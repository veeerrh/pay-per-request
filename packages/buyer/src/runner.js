// Beacon's runner: executes a plan through guard.runStep / guard.pay and emits typed events (Appendix B).
// The runner never signs anything itself: every payment goes through guard.pay() (M-37).
const g = require('@di06/guard');
const { buildPlan, estimateMin, PlanError } = require('./planner');
const { buildResult, fmt } = require('./reporter');
const { createBeacon, factsFromTask } = require('./beacon');
const { createApprovals } = require('./approvals');
const path = require('path');
const RELAY_PAYTO = (() => { try { return String(require(path.join(__dirname, '..', '..', '..', 'config', 'addresses.json')).sellers.relay || '').toLowerCase(); } catch { return ''; } })();

/**
 * ctx: { store, budget, signer, cfg, chain, listings: () => Promise<Listing[]>, log, now? }
 * req: { taskId, text, budget: bigint, maxConcurrency, hired?: string[] }
 */
async function runTask(ctx, req, emit = () => {}) {
  const { store, budget, signer, cfg, chain } = ctx;
  const taskId = req.taskId;
  const chainMode = !!req.chain; // opt-in: Relay buys the earthquake data itself
  const beacon = ctx.beacon || createBeacon({ log: ctx.log });
  const act = (kind, text) => emit({ type: 'activity', kind, text, at: new Date().toISOString() });
  /** A line in the Beacon chat. Built from recorded facts; the chat shows what Beacon did and why. */
  const say = (text, kind = 'info') => emit({ type: 'chat', role: 'beacon', kind, text, at: new Date().toISOString() });
  const stage = (s) => emit({ type: 'stage', stage: s });
  const attempts = [];
  const exclusions = new Set();
  const spentBySeller = new Map();
  const preferred = new Map(); // category -> seller id chosen by Beacon; only ever one of the eligible candidates
  const choices = [];
  const agentNotes = [];
  const warned = new Set();
  /** One chat line per reason: the user should know when Beacon is using its rule-based path instead of the model. */
  const noteFallback = (reason) => {
    if (!reason || warned.has(reason)) return;
    warned.add(reason);
    say(reason === 'budget'
      ? "Gemini's free request budget is full for the moment, so I am using my rule-based logic for some steps. Payments and checks are unchanged."
      : 'The model is not responding right now, so I am using my rule-based logic for some steps. Payments and checks are unchanged.', 'notice');
  };
  /** What a hired agent added to its answer (Atlas notes, Tremor digest, Brief actions). Only from outputs that passed validation. */
  const agentNote = (agent, category, text) => {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!t) return;
    agentNotes.push({ agent, category, text: t });
    emit({ type: 'note', agent, category, text: t, at: new Date().toISOString() });
    say(`${agent} adds: ${t}`, 'agent');
  };
  const approvals = ctx.approvals || createApprovals();
  const approveAbove = req.approveAbove ?? null; // units; null means no approval needed
  const askedAbout = new Map(); // seller id -> the pending or settled approval question for this task
  const ledgerRows = [];
  let seq = 0;
  let paidCalls = 0;
  const accepted = new Set();

  const blocked = (notice) => {
    emit({ type: 'blocked', notice, at: new Date().toISOString() });
    act('blocked', notice);
    say(`I stopped before buying anything: ${notice}`, 'blocked');
    return { status: 'blocked', notice };
  };

  stage('plan');
  act('start', `Task started with a ${fmt(req.budget)} USDC hard cap (max concurrency ${req.maxConcurrency}).`);
  let params;
  try {
    const planned = await beacon.plan(req.text);
    params = planned.params;
    noteFallback(planned.fallback);
    emit({ type: 'plan', params, source: planned.source });
    say(`I read your task as: ${String(planned.understanding).replace(/[.\s]+$/, '')}. Budget is a hard cap of ${fmt(req.budget)} USDC. ${chainMode ? 'I will find the countries, then hire Relay, which buys the earthquake data from Tremor itself and writes the briefs.' : 'I will find the countries, fetch earthquake data for each, then have a readiness brief written.'}`, 'plan');
  } catch (e) { if (e instanceof PlanError) return blocked(e.message); throw e; }
  const plan = buildPlan(params, { chain: chainMode });

  // Listings: take the snapshot once at task start (M-54). Hired agents pin their category.
  let listings = await ctx.listings();
  // The agent chain (Relay) is opt-in. Identified by its id AND its registered payee address, never by seller-written text (M-12):
  // without the option it is not a candidate for any step; with the option the inference step can only be Relay.
  const isRelay = (l) => l.id === 'relay' && !!RELAY_PAYTO && String(l.payTo).toLowerCase() === RELAY_PAYTO;
  if (chainMode) {
    if (!listings.some(isRelay)) return blocked('You asked for the agent chain, but Relay is not listed right now (or its address does not match). Nothing was bought.');
    listings = listings.filter((l) => l.category !== 'inference' || isRelay(l));
  } else listings = listings.filter((l) => l.id !== 'relay');
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
    if (preferred.get(c.category) !== c.id) say(`Trying ${c.name} for the ${c.category} step next (${c.why}).`, 'select');
    const r = build(c);
    // Human approval (M-23, M-57): decided BEFORE the guard is asked to do anything, so nothing is reserved or signed while waiting.
    // A decline, or no answer in time, is a refusal by policy: nothing is signed, nothing is paid, and the seller's reputation is untouched.
    if (approveAbove !== null && c.price > approveAbove) {
      // One question per seller per task: the answer covers that seller's remaining calls (the budget cap still applies), and
      // parallel calls to the same seller wait on the same question instead of asking again.
      if (!askedAbout.has(c.id)) {
        say(`${c.name} costs up to ${fmt(c.price)} USDC per call, above your approval limit of ${fmt(approveAbove)} USDC. I am waiting for your decision (${Math.round(approvals.timeoutMs / 1000)} seconds, then I decline).`, 'pending');
        askedAbout.set(c.id, approvals.request(taskId, { sellerId: c.id, seller: c.name, category: c.category, priceUnits: c.price, thresholdUnits: approveAbove }, emit)
          .then((d) => { if (d === 'approved') say(`Approved: I will hire ${c.name} for this task (up to ${fmt(c.price)} USDC per call).`, 'info'); return d; }));
      }
      const decision = await askedAbout.get(c.id);
      if (decision !== 'approved') {
        const why = decision === 'expired' ? `no answer within ${Math.round(approvals.timeoutMs / 1000)} seconds, so it was declined` : 'you declined';
        const declined = { requestId, status: 'refused', verdict: 'REFUSE', ruleId: 'M-57', reason: `${why}: ${c.name} is above your approval limit of ${fmt(approveAbove)} USDC`, asked: c.price, paid: 0n, latencyMs: 0, txHash: null, signed: false };
        act('refused', `${c.name} not approved: ${declined.reason}`);
        say(`Not approved: ${declined.reason}. Nothing was signed or paid.`, 'refused');
        return declined;
      }
    }
    const result = await g.pay(deps, {
      requestId, taskId, seller: { id: c.id, name: c.name, category: c.category },
      listing: { price: c.price, payTo: c.payTo, network: g.NETWORK, asset: g.USDC_ADDRESS }, listingHash: c.listingHash,
      url: r.url, method: r.method, body: r.body, validate: r.validate, meta: { why: c.why, source: 'task' },
    });
    const entry = store.listEntries().find((e) => e.id === requestId);
    if (entry) { emit({ type: 'ledger', entry: { ...entry, buyer: 'Scout', seller: c.name, why: c.why, source: 'task' } }); ledgerRows.push({ ...entry, seller: c.name }); }
    if (result.paid > 0n) paidCalls++;
    if (result.status === 'paid') accepted.add(c.id);
    const price = fmt(result.paid);
    if (result.status === 'refused') { act('refused', `${c.name} refused: ${result.reason}`); say(`I refused ${c.name} before signing anything, so nothing was paid: ${result.reason}`, 'refused'); }
    else if (result.status === 'failed') { act('failed', `${c.name} failed, not charged: ${result.reason}`); say(`${c.name} did not deliver and I was not charged: ${result.reason}`, 'failed'); }
    else if (result.status === 'pending') { act('info', `${c.name} is pending: ${result.reason}`); say(`${c.name}'s payment is still settling: ${result.reason}`, 'pending'); }
    else {
      act('settled', `Paid ${price} test USDC to ${c.name}.`);
      if (result.status === 'paid') { act('validated', `${c.name} output validated.`); say(`Paid ${price} USDC to ${c.name}. Its answer passed my checks.`, 'paid'); }
      else { act('rejected', `${c.name} output rejected: ${result.reason}. ${c.name} is excluded for the rest of this task.`); say(`Paid ${price} USDC to ${c.name}, but its answer failed my checks (${result.reason}). I will not use ${c.name} again in this task.`, 'rejected'); }
      emit({ type: 'output', call: entry?.callNo ?? null, agent: c.id, status: result.status === 'paid' ? 'accepted' : 'rejected', output: result.status === 'paid' ? result.output : String(entry?.rawOutput ?? '').slice(0, 500) });
    }
    metrics();
    return result;
  };

  // Beacon picks among the sellers the safety rules already approved. Once per category: later calls in the same step reuse the pick.
  const chooseFor = async (category, reputation) => {
    if (preferred.has(category)) return;
    preferred.set(category, undefined);
    const candidates = g.selectCandidates({ category, listings, reputation, exclusions, remaining: budget.totals(taskId).remaining, buyerAddress: signer.address, cfg, spentBySeller }).candidates;
    if (!candidates.length) return;
    const label = plan.steps.find((s) => s.category === category)?.label ?? category;
    const pick = await beacon.choose({ category, label, candidates, taskText: req.text });
    noteFallback(pick.fallback);
    const picked = candidates.find((c) => c.id === pick.id) ?? candidates[0];
    preferred.set(category, picked.id);
    choices.push({ category, id: picked.id, name: picked.name, reason: pick.reason, source: pick.source });
    emit({ type: 'choice', category, sellerId: picked.id, seller: picked.name, reason: pick.reason, source: pick.source, at: new Date().toISOString() });
    say(`For the ${category} step I hire ${picked.name}. ${pick.reason}`, 'choice');
  };

  const step = async (category, build, reputation) => {
    await chooseFor(category, reputation);
    const out = await g.runStep({
      category, listings, reputation, exclusions, remaining: () => budget.totals(taskId).remaining, buyerAddress: signer.address, cfg, spentBySeller, pay: mkPay(build),
      prefer: () => preferred.get(category),
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
  if (sc.accepted) {
    const o = sc.accepted.result.output;
    const who = sc.accepted.candidate.name;
    if (o.summary) agentNote(who, 'scraping', o.summary);
    for (const c of o.countries) if (c.note) agentNote(who, 'scraping', `${c.name}: ${c.note}`);
  }

  const quakeByCountry = new Map();
  const briefs = [];
  let chainInfo = null;
  if (chainMode) {
    // 2+3 (chained). One purchase per batch of at most two countries: Relay buys the quake data from Tremor itself, with its own wallet.
    const hiredByRelay = [];
    const names = countries;
    const batches = [];
    for (let i = 0; i < names.length; i += 2) batches.push(names.slice(i, i + 2));
    const chainCall = (batch) => async () => {
      const out = note(await step('inference', (c) => ({
        url: c.endpoint, method: 'POST', body: JSON.stringify({ countries: batch.map((n) => ({ name: n })), days: params.days, minMag: params.minMag }),
        validate: g.makeValidator({ outputSchema: c.outputSchema, sanity: 'brief', context: { countries: batch, knownCountries: batch } }),
      }), snapshotRep()));
      if (!out.accepted) return out;
      const o = out.accepted.result.output;
      briefs.push(...o.briefs);
      for (const b of o.briefs) if (b.actions?.length) agentNote(out.accepted.candidate.name, 'inference', `Actions for ${b.country}: ${b.actions.join('; ')}`);
      // What Relay says it bought. It is the seller's own account, so it is shown as such and only checked for shape and plausibility.
      const ch = o.meta?.chain;
      if (ch && Array.isArray(ch.hired)) {
        for (const h of ch.hired.slice(0, 4)) {
          const row = { seller: String(h.seller ?? '').slice(0, 40), country: String(h.country ?? '').slice(0, 80), paidUnits: /^\d{1,9}$/.test(String(h.paidUnits)) ? String(h.paidUnits) : '0', txHash: /^0x[0-9a-fA-F]{64}$/.test(String(h.txHash)) ? String(h.txHash) : null };
          hiredByRelay.push(row);
          agentNote(out.accepted.candidate.name, 'inference', `Hired ${row.seller} for ${row.country} and paid ${fmt(row.paidUnits)} USDC from its own wallet${row.txHash ? ` (tx ${row.txHash.slice(0, 10)}...)` : ''}.`);
          emit({ type: 'chain', agent: out.accepted.candidate.name, ...row, at: new Date().toISOString() });
        }
      }
      for (const d of Array.isArray(ch?.data) ? ch.data.slice(0, 2) : []) {
        const q = { country: String(d.country ?? ''), window_days: params.days, quakes: Array.isArray(d.quakes) ? d.quakes.slice(0, 50) : [] };
        if (batch.includes(q.country) && !g.sanityCheck('tremor', q, { country: q.country, days: params.days, minMag: params.minMag })) quakeByCountry.set(q.country, q);
      }
      return out;
    };
    if (batches.length) {
      await chainCall(batches[0])();
      await g.runWithConcurrency(req.maxConcurrency, batches.slice(1).map((b) => chainCall(b)));
    }
    if (hiredByRelay.length) chainInfo = { agent: 'Relay', hired: hiredByRelay, spentUnits: String(hiredByRelay.reduce((s, h) => s + BigInt(h.paidUnits), 0n)) };
  } else {
  // 2. data: one call per country. Probe-first: the first call runs alone so a liar is discovered once,
  // then the rest run in parallel up to max_concurrency.
  const quakeCall = (country) => async (rep) => {
    const out = note(await step('data', (c) => ({
      url: `${c.endpoint}?country=${encodeURIComponent(country)}&days=${params.days}&minMag=${params.minMag}`,
      validate: g.makeValidator({ outputSchema: c.outputSchema, sanity: 'tremor', context: { country, days: params.days, minMag: params.minMag } }),
    }), rep()));
    if (out.accepted) {
      quakeByCountry.set(country, out.accepted.result.output);
      if (out.accepted.result.output.digest) agentNote(out.accepted.candidate.name, 'data', `${country}: ${out.accepted.result.output.digest}`);
    }
    return out;
  };
  if (countries.length) {
    const first = quakeCall(countries[0]);
    await first(snapshotRep);
    const rest = countries.slice(1).map((c) => () => quakeCall(c)(snapshotRep));
    await g.runWithConcurrency(req.maxConcurrency, rest);
  }

  // 3. inference: batches of at most 2 countries, same probe-first rule.
  const withData = countries.filter((c) => quakeByCountry.has(c));
  const batches = [];
  for (let i = 0; i < withData.length; i += 2) batches.push(withData.slice(i, i + 2));
  const briefCall = (names) => async () => {
    const out = note(await step('inference', (c) => ({
      url: c.endpoint, method: 'POST', body: JSON.stringify({ countries: names.map((n) => ({ name: n, quakes: quakeByCountry.get(n).quakes })) }),
      validate: g.makeValidator({ outputSchema: c.outputSchema, sanity: 'brief', context: { countries: names, knownCountries: names } }),
    }), snapshotRep()));
    if (out.accepted) {
      briefs.push(...out.accepted.result.output.briefs);
      for (const b of out.accepted.result.output.briefs) if (b.actions?.length) agentNote(out.accepted.candidate.name, 'inference', `Actions for ${b.country}: ${b.actions.join('; ')}`);
    }
    return out;
  };
  if (batches.length) {
    await briefCall(batches[0])();
    await g.runWithConcurrency(req.maxConcurrency, batches.slice(1).map((b) => briefCall(b)));
  }
  }

  // 4. combine
  stage('execute');
  stage('validate');
  stage('combine');
  act('info', 'Combining validated outputs into one result.');
  const complete = stops.length === 0 && countries.length === params.n && (chainMode || quakeByCountry.size === params.n) && briefs.length === params.n;
  const notice = complete ? '' : (stops[0]?.message || 'Not every step produced a valid result. Partial result below.');
  const entries = store.listEntries().filter((e) => e.taskId === taskId);
  const result = buildResult({ params, countries, quakeByCountry, briefs, attempts, entries, complete, notice });
  const totals = budget.totals(taskId);
  metrics();
  const status = complete ? 'completed' : 'stopped';
  act(complete ? 'completed' : 'stopped', complete ? `Task completed. Spent ${fmt(totals.spent)} of ${fmt(totals.budget)} USDC.` : notice);
  result.agentNotes = agentNotes;
  if (chainInfo) result.chain = chainInfo;
  result.choices = choices.map((c) => ({ category: c.category, sellerId: c.id, seller: c.name, reason: c.reason, source: c.source }));
  const summary = await beacon.summarize(factsFromTask({
    text: req.text, status, stage: 'combine', notice, budget: String(totals.budget), spent: String(totals.spent), paidCalls, params, choices, ledger: ledgerRows, result, agentNotes,
  }));
  result.beaconSummary = { text: summary.text, source: summary.source };
  noteFallback(summary.fallback);
  say(summary.text, 'summary');
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
  const beacon = ctx.beacon || createBeacon({ log: ctx.log });
  const act = (kind, text) => emit({ type: 'activity', kind, text, at: new Date().toISOString() });
  const say = (text, kind = 'info') => emit({ type: 'chat', role: 'beacon', kind, text, at: new Date().toISOString() });
  const blocked = (notice) => { emit({ type: 'blocked', notice, at: new Date().toISOString() }); act('blocked', notice); say(`I stopped before buying anything: ${notice}`, 'blocked'); return { status: 'blocked', notice }; };
  const d = req.directUrl;
  emit({ type: 'stage', stage: 'plan' });
  act('start', `Direct purchase started with a ${fmt(req.budget)} USDC hard cap.`);
  say(`Direct purchase: you gave me one URL and the price you expect, so I am not choosing an agent. I still check the price, payee, token and network before signing anything. Budget is a hard cap of ${fmt(req.budget)} USDC.`, 'plan');
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
  const host = new URL(d.url).host;
  if (result.status === 'refused') { act('refused', `Refused: ${result.reason}`); say(`I refused ${host} before signing anything, so nothing was paid: ${result.reason}`, 'refused'); }
  else if (result.status === 'failed') { act('failed', `Failed, not charged: ${result.reason}`); say(`${host} did not deliver and I was not charged: ${result.reason}`, 'failed'); }
  else if (result.status === 'pending') { act('info', `Pending: ${result.reason}`); say(`The payment to ${host} is still settling: ${result.reason}`, 'pending'); }
  else if (result.status === 'paid') { act('validated', 'Paid and received a response.'); say(`Paid ${fmt(result.paid)} USDC to ${host} and received a response.`, 'paid'); }
  else { act('rejected', `Paid, output rejected: ${result.reason}`); say(`Paid ${fmt(result.paid)} USDC to ${host}, but the answer failed my checks (${result.reason}).`, 'rejected'); }
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
  const summary = await beacon.summarize(factsFromTask({
    text: `Direct purchase from ${d.url}`, status, stage: 'combine', notice: ok ? '' : result.reason, budget: String(t.budget), spent: String(t.spent), paidCalls: result.paid > 0n ? 1 : 0,
    choices: [], ledger: entry ? [{ ...entry, seller: host }] : [], result: out, agentNotes: [],
  }));
  out.beaconSummary = { text: summary.text, source: summary.source };
  say(summary.text, 'summary');
  emit({ type: 'done', status, notice: ok ? '' : result.reason, result: out, at: new Date().toISOString() });
  return { status, notice: ok ? '' : result.reason, result: out, totals: t };
}

module.exports = { runTask, runDirect };
