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
      url: r.url, method: r.method, body: r.body, validate: r.validate, meta: { why: c.why, source: 'task' },
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
  act(complete ? 'completed' : 'stopped', complete ? `Task completed. Spent ${fmt(totals.spent)} of ${fmt(totals.budget)} USDC.` : notice);
  emit({ type: 'done', status, notice, result, at: new Date().toISOString() }); // last event: the stream ends here
  return { status, notice, result, totals, attempts, entries, params };
}

/**
 * Direct-URL mode (M-65, S-89, T-08b): buy one URL once, with an operator-supplied expected price.
 * Every guard check still runs. If no expected payTo is given, the payee cannot be compared with a listing,
 * so the row is marked payToUnverified (decision D-32).
 * req: { taskId, budget: bigint, directUrl: { url, expectedPrice: bigint, category, expectedPayTo? } }
 */
async function runDirect(ctx, req, emit = () => {}) {
  const { store, budget, signer, cfg, chain } = ctx;
  const act = (kind, text) => emit({ type: 'activity', kind, text, at: new Date().toISOString() });
  const blocked = (notice) => { emit({ type: 'blocked', notice, at: new Date().toISOString() }); act('blocked', notice); return { status: 'blocked', notice }; };
  const d = req.directUrl;
  emit({ type: 'stage', stage: 'plan' });
  act('start', `Direct purchase started with a ${fmt(req.budget)} USDC hard cap.`);
  try { await g.assertPublicEndpoint(d.url, { allowPrivate: !!ctx.allowPrivate }); } catch (e) { return blocked(`That URL is not allowed: ${e.message}.`); }
  if (d.expectedPrice > req.budget) return blocked(`Expected price ${fmt(d.expectedPrice)} USDC is above the budget ${fmt(req.budget)} USDC. Nothing was bought.`);
  let balance;
  try { balance = await chain.balanceOf(signer.address); } catch (e) { return blocked(`Cannot read the wallet balance (${e.message}).`); }
  const startV = g.taskStartVerdict(balance, d.expectedPrice, cfg);
  if (startV) return blocked(startV.reason);

  let payTo = d.expectedPayTo;
  const unverified = !payTo;
  emit({ type: 'stage', stage: 'discover' });
  if (!payTo) {
    act('info', 'No expected payTo supplied: reading it from the seller 402. Price, token, network and scheme are still checked.');
    try {
      const res = await g.limitedFetch(fetch, d.url, {}, { timeoutMs: cfg.requestTimeoutMs, maxBytes: cfg.maxBodyBytes });
      const h = res.headers.get('payment-required');
      if (res.status !== 402 || !h) return blocked(`The URL answered ${res.status} instead of 402 Payment Required. Nothing was signed.`);
      payTo = g.decodePaymentRequired(h).accepts[0].payTo;
    } catch (e) { return blocked(`Could not read a valid 402 from that URL: ${e.message}. Nothing was signed.`); }
  }
  budget.openTask(req.taskId, req.budget);
  const requestId = `${req.taskId}-1`;
  emit({ type: 'stage', stage: 'pay' });
  act('select', `Direct URL selected: ${new URL(d.url).host}.`);
  const result = await g.pay({ store, budget, signer, cfg, chain, log: ctx.log }, {
    requestId, taskId: req.taskId, seller: { id: 'direct', name: new URL(d.url).host, category: d.category },
    listing: { price: d.expectedPrice, payTo, network: g.NETWORK, asset: g.USDC_ADDRESS }, listingHash: `direct-${new URL(d.url).host}`, url: d.url,
    meta: { why: 'Direct-URL mode: price supplied by the operator', source: 'direct', payToUnverified: unverified },
  });
  const entry = store.listEntries().find((e) => e.id === requestId);
  if (entry) emit({ type: 'ledger', entry: { ...entry, buyer: 'Scout', source: 'direct' } });
  if (result.status === 'refused') act('refused', `Refused: ${result.reason}`);
  else if (result.status === 'failed') act('failed', `Failed, not charged: ${result.reason}`);
  else if (result.status === 'pending') act('info', `Pending: ${result.reason}`);
  else act(result.status === 'paid' ? 'validated' : 'rejected', result.status === 'paid' ? 'Paid and received a response.' : `Paid, output rejected: ${result.reason}`);
  const t = budget.totals(req.taskId);
  emit({ type: 'metrics', budget: String(t.budget), reserved: String(t.reserved), spent: String(t.spent), remaining: String(t.remaining), paidCalls: result.paid > 0n ? 1 : 0, services: result.status === 'paid' ? ['direct'] : [] });
  for (const s of ['execute', 'validate', 'combine']) emit({ type: 'stage', stage: s });
  const ok = result.status === 'paid';
  const out = {
    complete: ok, assessment: { level: ok ? 'low' : 'incomplete', title: ok ? 'Direct purchase completed' : 'Direct purchase was not completed', summary: ok ? 'The seller answered and the payment passed every guard check.' : result.reason },
    evidence: ok ? [`Response: ${JSON.stringify(result.output).slice(0, 300)}`] : [], sources: [new URL(d.url).host],
    uncertainty: unverified ? 'The payee address was not supplied, so it could not be compared with a listing. Price, token, network and scheme were still checked.' : 'Content is whatever the seller returned and was only checked for valid JSON.',
    contributors: ok ? [{ id: 'direct', name: new URL(d.url).host, category: d.category }] : [],
    breakdown: [{ callNo: entry?.callNo ?? 1, sellerId: 'direct', seller: new URL(d.url).host, category: d.category, why: 'Direct-URL mode', listed: String(d.expectedPrice), paid: String(result.paid), outcome: result.status, ruleId: result.ruleId, reason: result.reason }],
    rawOutputs: [],
  };
  const status = ok ? 'completed' : 'stopped';
  if (ok) emit({ type: 'output', call: entry?.callNo ?? 1, agent: 'direct', status: 'accepted', output: result.output });
  act(ok ? 'completed' : 'stopped', ok ? `Done. Spent ${fmt(t.spent)} of ${fmt(t.budget)} USDC.` : result.reason);
  emit({ type: 'done', status, notice: ok ? '' : result.reason, result: out, at: new Date().toISOString() });
  return { status, notice: ok ? '' : result.reason, result: out, totals: t };
}

module.exports = { runTask, runDirect };
