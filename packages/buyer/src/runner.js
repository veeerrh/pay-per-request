// Beacon's runner: executes a plan through guard.runStep / guard.pay and emits typed events (Appendix B).
// The runner never signs anything itself: every payment goes through guard.pay() (M-37).
const g = require('@di06/guard');
const { parseTask, buildPlan, estimateMin, PlanError } = require('./planner');
const { buildResult, fmt } = require('./reporter');

/**
 * ctx: { store, budget, signer, cfg, chain, listings: () => Promise<Listing[]>, log, now? }
 * req: { taskId, text, budget: bigint, maxConcurrency, hired?: string[] }
 */
async function runTask(ctx, req, emit = () => {}) {
  const { store, budget, signer, cfg, chain } = ctx;
  const taskId = req.taskId;
  const act = (kind, text) => emit({ type: 'activity', kind, text, at: new Date().toISOString() });
  const stage = (s) => emit({ type: 'stage', stage: s });
  const attempts = [];
  const exclusions = new Set();
  const spentBySeller = new Map();
  let seq = 0;
  let paidCalls = 0;
  const accepted = new Set();

  const blocked = (notice) => {
    emit({ type: 'blocked', notice, at: new Date().toISOString() });
    act('blocked', notice);
    return { status: 'blocked', notice };
  };

  stage('plan');
  act('start', `Task started with a ${fmt(req.budget)} USDC hard cap (max concurrency ${req.maxConcurrency}).`);
  let params;
  try { params = parseTask(req.text); } catch (e) { if (e instanceof PlanError) return blocked(e.message); throw e; }
  const plan = buildPlan(params);

  // Listings: take the snapshot once at task start (M-54). Hired agents pin their category.
  let listings = await ctx.listings();
  const hired = new Set(req.hired || []);
  for (const cat of new Set(listings.map((l) => l.category))) {
    const pinned = listings.filter((l) => l.category === cat && hired.has(l.id));
    if (pinned.length) { listings = listings.filter((l) => l.category !== cat || hired.has(l.id)); act('info', `${cat} step is limited to your hired agent(s): ${pinned.map((p) => p.name).join(', ')}.`); }
  }
  act('info', `Plan: ${plan.steps.map((s) => `${s.label} (${s.calls} call${s.calls > 1 ? 's' : ''})`).join('; ')}.`);

  const est = estimateMin(plan, listings);
  const firstCheapest = listings.filter((l) => l.category === 'scraping').reduce((m, l) => (m === null || l.price < m ? l.price : m), null);
  if (firstCheapest === null) return blocked('No scraping seller is listed, so the first step cannot start.');
  if (req.budget < firstCheapest) return blocked(`Budget ${fmt(req.budget)} USDC is below the cheapest first step (${fmt(firstCheapest)} USDC). Nothing was bought.`);
  act('info', `Cheapest possible plan costs about ${est === null ? 'unknown' : fmt(est)} USDC at listed prices.`);

  let balance;
  try { balance = await chain.balanceOf(signer.address); } catch (e) { return blocked(`Cannot read the wallet balance (${e.message}). Nothing was bought.`); }
  const startV = g.taskStartVerdict(balance, firstCheapest, cfg);
  if (startV) return blocked(startV.reason);

  budget.openTask(taskId, req.budget);
  const deps = { store, budget, signer, cfg, chain, log: ctx.log };
  const metrics = () => {
    const t = budget.totals(taskId);
    emit({ type: 'metrics', budget: String(t.budget), reserved: String(t.reserved), spent: String(t.spent), remaining: String(t.remaining), paidCalls, services: [...accepted] });
  };
  const snapshotRep = () => g.computeReputation(store.listEntries(), cfg, Date.now());

  // Wraps guard.pay for one candidate and turns the result into ledger/activity/output events.
  const mkPay = (build) => async (c) => {
    const requestId = `${taskId}-${++seq}`;
    act('select', `${c.name} selected for the ${c.category} step: ${c.why}.`);
    const r = build(c);
    const result = await g.pay(deps, {
      requestId, taskId, seller: { id: c.id, name: c.name, category: c.category },
      listing: { price: c.price, payTo: c.payTo, network: g.NETWORK, asset: g.USDC_ADDRESS }, listingHash: c.listingHash,
      url: r.url, method: r.method, body: r.body, validate: r.validate,
    });
    const entry = store.listEntries().find((e) => e.id === requestId);
    if (entry) emit({ type: 'ledger', entry: { ...entry, buyer: 'Scout', seller: c.name, why: c.why, source: 'task' } });
    if (result.paid > 0n) paidCalls++;
    if (result.status === 'paid') accepted.add(c.id);
    const price = fmt(result.paid);
    if (result.status === 'refused') act('refused', `${c.name} refused: ${result.reason}`);
    else if (result.status === 'failed') act('failed', `${c.name} failed, not charged: ${result.reason}`);
    else if (result.status === 'pending') act('info', `${c.name} is pending: ${result.reason}`);
    else {
      act('settled', `Paid ${price} test USDC to ${c.name}.`);
      if (result.status === 'paid') act('validated', `${c.name} output validated.`);
      else act('rejected', `${c.name} output rejected: ${result.reason}. ${c.name} is excluded for the rest of this task.`);
      emit({ type: 'output', call: entry?.callNo ?? null, agent: c.id, status: result.status === 'paid' ? 'accepted' : 'rejected', output: result.status === 'paid' ? result.output : String(entry?.rawOutput ?? '').slice(0, 500) });
    }
    metrics();
    return result;
  };

  const step = async (category, build, reputation) => {
    const out = await g.runStep({
      category, listings, reputation, exclusions, remaining: () => budget.totals(taskId).remaining, buyerAddress: signer.address, cfg, spentBySeller, pay: mkPay(build),
    });
    out.attempts.forEach((a) => attempts.push(a));
    if (out.stop) act('stopped', `${category} step: ${out.stop.message}`);
    return out;
  };
  const stops = [];
  const note = (o) => { if (o.stop) stops.push(o.stop); return o; };

  stage('discover');
  act('info', `Querying the registry: ${listings.length} listings across ${new Set(listings.map((l) => l.category)).size} categories.`);
  stage('pay');

  // 1. scraping: which countries?
  const sc = note(await step('scraping', (c) => ({
    url: `${c.endpoint}?top=${params.n}&by=${params.by === 'area' ? 'area' : 'population'}`,
    validate: g.makeValidator({ outputSchema: c.outputSchema, sanity: 'atlas', context: { top: params.n } }),
  }), snapshotRep()));
  const countries = sc.accepted ? sc.accepted.result.output.countries.map((c) => c.name) : [];

  // 2. data: one call per country. Probe-first: the first call runs alone so a liar is discovered once,
  // then the rest run in parallel up to max_concurrency.
  const quakeByCountry = new Map();
  const quakeCall = (country) => async (rep) => {
    const out = note(await step('data', (c) => ({
      url: `${c.endpoint}?country=${encodeURIComponent(country)}&days=${params.days}&minMag=${params.minMag}`,
      validate: g.makeValidator({ outputSchema: c.outputSchema, sanity: 'tremor', context: { country, days: params.days, minMag: params.minMag } }),
    }), rep()));
    if (out.accepted) quakeByCountry.set(country, out.accepted.result.output);
    return out;
  };
  if (countries.length) {
    const first = quakeCall(countries[0]);
    await first(snapshotRep);
    const rest = countries.slice(1).map((c) => () => quakeCall(c)(snapshotRep));
    await g.runWithConcurrency(req.maxConcurrency, rest);
  }

  // 3. inference: batches of at most 2 countries, same probe-first rule.
  const briefs = [];
  const withData = countries.filter((c) => quakeByCountry.has(c));
  const batches = [];
  for (let i = 0; i < withData.length; i += 2) batches.push(withData.slice(i, i + 2));
  const briefCall = (names) => async () => {
    const out = note(await step('inference', (c) => ({
      url: c.endpoint, method: 'POST', body: JSON.stringify({ countries: names.map((n) => ({ name: n, quakes: quakeByCountry.get(n).quakes })) }),
      validate: g.makeValidator({ outputSchema: c.outputSchema, sanity: 'brief', context: { countries: names, knownCountries: names } }),
    }), snapshotRep()));
    if (out.accepted) briefs.push(...out.accepted.result.output.briefs);
    return out;
  };
  if (batches.length) {
    await briefCall(batches[0])();
    await g.runWithConcurrency(req.maxConcurrency, batches.slice(1).map((b) => briefCall(b)));
  }

  // 4. combine
  stage('execute');
  stage('validate');
  stage('combine');
  act('info', 'Combining validated outputs into one result.');
  const complete = stops.length === 0 && countries.length === params.n && quakeByCountry.size === params.n && briefs.length === params.n;
  const notice = complete ? '' : (stops[0]?.message || 'Not every step produced a valid result. Partial result below.');
  const entries = store.listEntries().filter((e) => e.taskId === taskId);
  const result = buildResult({ params, countries, quakeByCountry, briefs, attempts, entries, complete, notice });
  const totals = budget.totals(taskId);
  metrics();
  const status = complete ? 'completed' : 'stopped';
  emit({ type: 'done', status, notice, result, at: new Date().toISOString() });
  act(complete ? 'completed' : 'stopped', complete ? `Task completed. Spent ${fmt(totals.spent)} of ${fmt(totals.budget)} USDC.` : notice);
  return { status, notice, result, totals, attempts, entries, params };
}

module.exports = { runTask };
