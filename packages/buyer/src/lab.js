// Fraud Lab: Beacon tries each suspect agent one at a time, exactly as it would buy from it in a normal task, and says in the chat
// what went wrong and why it did not hire the agent. Every purchase goes through guard.pay(); nothing here signs or approves anything.
// The suspects are scripted (no model), so each run is repeatable. Only the closing report may be polished by the model.
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const g = require('@di06/guard');
const { fmt } = require('./reporter');
const { createBeacon, factsFromLab } = require('./beacon');

const ROOT = path.join(__dirname, '..', '..', '..');
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const SHAPE_MODES = [
  { mode: 'drift', label: 'one unit above the listed price', claim: 'asks for 1 unit more than it listed' },
  { mode: 'decimals', label: 'units confusion (1 USDC instead of 0.001)', claim: 'asks for a thousand times its listed price' },
  { mode: 'asset', label: 'look-alike token', claim: 'asks to be paid in a different token' },
  { mode: 'network', label: 'Base mainnet instead of the test network', claim: 'asks for payment on Base mainnet' },
  { mode: 'scheme', label: 'a different payment scheme', claim: 'asks for the "upto" payment scheme' },
  { mode: 'timeout', label: 'an authorization valid for a year', claim: 'asks for a one-year authorization window' },
];

/** The suspects, in the order Beacon meets them. The registry ones are the live test vendors; Shapeshifter and the replay are lab-only. */
const ROSTER = [
  { id: 'overquote', title: 'Bait-and-Switch', suspect: 'Overquote', kind: 'registry', layer: 'Before signing', rules: ['M-17'], cost: 'Free',
    tactic: 'Price lie: it lists 0.002 USDC, then its payment request asks for 0.020.', expected: 'Refused before signing. Nothing paid.',
    build: (l) => ({ url: `${l.endpoint}?top=1` }) },
  { id: 'redirect', title: 'Redirector', suspect: 'Redirect', kind: 'registry', layer: 'Before signing', rules: ['S-06'], cost: 'Free',
    tactic: 'Payee lie: the payment request names a different recipient than the address it registered.', expected: 'Refused before signing. Nothing paid.',
    build: (l) => ({ url: `${l.endpoint}?country=India&days=7&minMag=4.5` }) },
  { id: 'shapeshifter', title: 'Shapeshifter', suspect: 'Shapeshifter', kind: 'lab', layer: 'Before signing', rules: ['M-17', 'terms rules'], cost: 'Free',
    tactic: 'Terms manipulation: lists 0.001 USDC, then changes one term per call (price drift, units, token, network, scheme, timeout).', expected: 'Six refusals, each pointing at exactly one changed term.',
    subs: SHAPE_MODES },
  { id: 'hollow', title: 'Ghost', suspect: 'Hollow', kind: 'registry', layer: 'After paying', rules: ['M-24'], cost: '0.008 test USDC',
    tactic: 'Takes the payment, then returns an answer that breaks its own published format.', expected: 'Paid, answer rejected, seller flagged and excluded. The loss is capped at one call.',
    build: (l) => ({ url: l.endpoint, method: 'POST', body: JSON.stringify({ countries: [{ name: 'India', quakes: [] }] }) }) },
  { id: 'offline', title: 'Vanishing agent', suspect: 'Offline', kind: 'registry', layer: 'Liveness', rules: ['S-27'], cost: 'Free',
    tactic: 'Goes offline: every request fails.', expected: 'Failed, not charged. The reserved budget is released.',
    build: (l) => ({ url: `${l.endpoint}?top=1` }) },
  { id: 'control', listingId: 'atlas', title: 'Control: honest agent', suspect: 'Atlas', kind: 'registry', layer: 'Control', rules: [], cost: '0.005 test USDC', honest: true,
    tactic: 'An honest purchase, to show that legitimate buying still works.', expected: 'Paid and validated.',
    build: (l) => ({ url: `${l.endpoint}?top=1`, validate: { sanity: 'atlas', context: { top: 1 } } }) },
  { id: 'replay', title: 'Replay attacker', suspect: 'Replay', kind: 'system', layer: 'Seller side', rules: ['M-28', 'X-08'], cost: '0.010 test USDC',
    tactic: 'Reuses a signed payment: once more, then five times at the same moment.', expected: 'One response per signed payment. Every replay is refused. Two transfers on chain for two signatures.' },
];
const ORDER = ROSTER.map((r) => r.id);

const publicRoster = () => ROSTER.map(({ build, ...r }) => ({ ...r, subs: r.subs?.map((s) => ({ mode: s.mode, label: s.label })) }));

const labListing = () => {
  const l = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'lab', 'shapeshifter.json'), 'utf8'));
  const addr = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'addresses.json'), 'utf8'));
  return { l, payTo: addr.lab?.shapeshifter };
};

/** What the seller said it would charge and where, against what its payment request really asked. Only the differences are reported. */
function diffTerms(entry) {
  const exp = entry?.terms?.expected;
  const act = entry?.terms?.actual;
  if (!exp || !act) return [];
  const rows = [];
  if (String(exp.amount) !== String(act.amount)) rows.push({ field: 'price', listed: fmt(exp.amount), actual: fmt(act.amount) });
  if (exp.payTo && act.payTo && !same(exp.payTo, act.payTo)) rows.push({ field: 'payTo', listed: short(exp.payTo), actual: short(act.payTo) });
  if (exp.asset && act.asset && !same(exp.asset, act.asset)) rows.push({ field: 'token', listed: short(exp.asset), actual: short(act.asset) });
  if (exp.network && act.network && exp.network !== act.network) rows.push({ field: 'network', listed: exp.network, actual: act.network });
  if (exp.scheme && act.scheme && exp.scheme !== act.scheme) rows.push({ field: 'scheme', listed: exp.scheme, actual: act.scheme });
  return rows;
}
const LIE_TEXT = {
  price: (d) => `It listed ${d.listed} USDC but its payment request asked for ${d.actual} USDC.`,
  payTo: (d) => `Its payment request names a different recipient (${d.actual}) than the address it registered (${d.listed}).`,
  token: (d) => `It asked to be paid in a different token (${d.actual}) instead of testnet USDC.`,
  network: (d) => `It asked for payment on ${d.actual}, not ${d.listed}. This system has no mainnet path.`,
  scheme: (d) => `It asked for the "${d.actual}" payment scheme; only "${d.listed}" is accepted.`,
};

const ReplayLayers = (statuses) => {
  const n = (c) => statuses.filter((s) => s === c).length;
  const parts = [];
  if (n(409)) parts.push(`${n(409)} by the seller's nonce claim (one authorization unlocks one response)`);
  if (n(402)) parts.push(`${n(402)} by payment verification after settlement (the authorization is already used on chain)`);
  if (statuses.some((s) => s === 0)) parts.push(`${n(0)} got no answer`);
  return parts.join(' and ');
};

/**
 * The replay test pays from Beacon's own wallet when the replay wallet is unfunded. Those transfers are not purchases, so their
 * hashes are recorded and excluded from reconciliation. Anything else the ledger cannot explain still counts as a difference.
 */
function adjustReconcile(rec, known) {
  const knownSet = new Set([...known].map((h) => String(h).toLowerCase()));
  const extra = rec.differences.filter((d) => d.status === 'chain_only' && d.txHash && knownSet.has(String(d.txHash).toLowerCase()));
  const remaining = rec.differences.length - extra.length;
  const excludedValue = extra.reduce((s, d) => s + d.chainAmount, 0n);
  return {
    status: rec.status === 'differences' && remaining === 0 ? 'matched' : rec.status,
    ledgerTotal: rec.ledgerTotal, chainTotal: rec.chainTotal - excludedValue,
    differences: remaining, excludedReplayTransfers: extra.length,
  };
}

/**
 * ctx: { store, budget, signer, cfg, chain, log, listings, beacon?, replay, replaySigner?, labEndpoints? }
 * req: { taskId, budget: bigint, cases?: string[] }
 */
async function runLab(ctx, req, emit = () => {}) {
  const { store, budget, signer, cfg, chain } = ctx;
  const taskId = req.taskId;
  const beacon = ctx.beacon || createBeacon({ log: ctx.log });
  const now = () => new Date().toISOString();
  const say = (text, kind = 'info', severity, agent) => emit({ type: 'chat', role: 'beacon', kind, text, at: now(), ...(severity ? { severity } : {}), ...(agent ? { agent } : {}) });
  const act = (kind, text) => emit({ type: 'activity', kind, text, at: now() });
  const stage = (s) => emit({ type: 'stage', stage: s });
  const blocked = (notice) => { emit({ type: 'blocked', notice, at: now() }); say(`I stopped before trying any suspect: ${notice}`, 'blocked', 'warn'); return { status: 'blocked', notice }; };

  stage('plan');
  const want = new Set(req.cases?.length ? req.cases : ORDER);
  const roster = ROSTER.filter((r) => want.has(r.id));
  if (!roster.length) return blocked('No suspects were selected.');
  let balance;
  try { balance = await chain.balanceOf(signer.address); } catch (e) { return blocked(`Cannot read the wallet balance (${e.message}).`); }
  const startV = g.taskStartVerdict(balance, 8000n, cfg);
  if (startV) return blocked(startV.reason);
  budget.openTask(taskId, req.budget);

  const all = await ctx.listings();
  const byId = new Map(all.map((l) => [l.id, l]));
  const endpoints = ctx.labEndpoints || {};
  const steps = []; // flat list of what will be tried
  const skipped = [];
  for (const r of roster) {
    if (r.kind === 'registry') {
      const l = byId.get(r.listingId || r.id);
      if (!l) { skipped.push(`${r.suspect} is not registered`); continue; }
      steps.push({ key: r.id, r, listing: l });
    } else if (r.kind === 'lab') {
      const base = (endpoints.shapeshifter || process.env.LAB_SHAPESHIFTER_URL || 'http://127.0.0.1:4025').replace(/\/$/, '');
      let up = false;
      try { up = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })).ok; } catch { /* not running */ }
      if (!up) { skipped.push('Shapeshifter is not running'); continue; }
      const { l, payTo } = labListing();
      const listing = { id: 'shapeshifter', name: l.name, category: l.category, price: BigInt(l.price), payTo, endpoint: `${base}${l.path}`, method: 'GET', listingHash: 'lab-shapeshifter', outputSchema: l.outputSchema };
      for (const s of r.subs) steps.push({ key: `shapeshifter:${s.mode}`, r, sub: s, listing });
    } else {
      const atlas = byId.get('atlas');
      if (!atlas) { skipped.push('the replay needs Atlas to be registered'); continue; }
      steps.push({ key: 'replay', r, listing: atlas });
    }
  }
  if (!steps.length) return blocked(`Nothing to try: ${skipped.join('; ')}.`);

  say(`Fraud Lab. I will try each suspect agent one at a time, exactly as I would buy from it in a normal task, and tell you what happens and why I did not hire it. `
    + `These are real payment requests checked by the real rules, with test USDC on Base Sepolia. Suspects: ${[...new Set(steps.filter((s) => !s.r.honest).map((s) => s.r.suspect))].join(', ')}${steps.some((s) => s.r.honest) ? `, plus ${steps.find((s) => s.r.honest).r.suspect} as an honest control` : ''}. Hard cap for this run: ${fmt(req.budget)} USDC.`, 'plan');
  for (const s of skipped) say(`Skipped: ${s}.`, 'notice', 'warn');
  const emitStep = (st, data) => emit({ type: 'lab_step', key: st.key, index: steps.indexOf(st) + 1, total: steps.length, agentId: st.r.id, title: st.r.title, suspect: st.r.suspect, sub: st.sub ? st.sub.mode : null, layer: st.r.layer, at: now(), ...data });
  const metrics = () => { const t = budget.totals(taskId); emit({ type: 'metrics', budget: String(t.budget), reserved: String(t.reserved), spent: String(t.spent), remaining: String(t.remaining), paidCalls: results.filter((x) => BigInt(x.paid || 0) > 0n).length, services: [] }); };

  const repOf = (id) => { const r = g.computeReputation(store.listEntries(), cfg, Date.now()).get(id) ?? g.newSellerReputation(id, cfg); return { score: Number(r.score.toFixed(2)), attempts: r.attempts, status: r.status }; };
  store.db.exec('CREATE TABLE IF NOT EXISTS lab_known_transfers(tx_hash TEXT PRIMARY KEY)');
  const knownReplayHashes = () => store.db.prepare('SELECT tx_hash FROM lab_known_transfers').all().map((r) => r.tx_hash);
  const recordReplayHashes = (hashes) => { const ins = store.db.prepare('INSERT OR IGNORE INTO lab_known_transfers(tx_hash) VALUES (?)'); for (const h of hashes) ins.run(String(h).toLowerCase()); };
  const results = [];
  let seq = 0;
  let verification = null;
  let replayResult = null;

  async function attempt(st) {
    const { r, sub, listing } = st;
    const requestId = `${taskId}-${++seq}`;
    const label = sub ? `${r.suspect}, ${sub.label}` : r.suspect;
    const before = repOf(listing.id);
    emitStep(st, { status: 'running', tactic: sub ? `Changes one term: ${sub.claim}.` : r.tactic, listedUsdc: fmt(listing.price) });
    say(`Suspect ${steps.indexOf(st) + 1} of ${steps.length}: ${label}. ${sub ? `It lists ${fmt(listing.price)} USDC, then ${sub.claim}.` : r.tactic} I will try to buy from it now.`, 'select', undefined, r.id);
    const b = sub ? { url: `${listing.endpoint}?mode=${sub.mode}` } : r.build(listing);
    const v = b.validate || {};
    const result = await g.pay({ store, budget, signer, cfg, chain, log: ctx.log }, {
      requestId, taskId, seller: { id: listing.id, name: listing.name, category: listing.category },
      listing: { price: listing.price, payTo: listing.payTo, network: g.NETWORK, asset: g.USDC_ADDRESS }, listingHash: listing.listingHash,
      url: b.url, method: b.method, body: b.body,
      validate: g.makeValidator({ outputSchema: listing.outputSchema, ...(v.sanity ? { sanity: v.sanity, context: v.context } : {}) }),
      meta: { why: `Fraud Lab: ${label}`, source: 'lab' },
    });
    const entry = store.listEntries().find((e) => e.id === requestId);
    if (entry) emit({ type: 'ledger', entry: { ...entry, buyer: 'Scout', seller: listing.name, why: `Fraud Lab: ${label}`, source: 'lab' } });
    const after = repOf(listing.id);
    const diffs = diffTerms(entry);
    const lie = diffs[0];
    const wouldHavePaid = result.status === 'refused' && entry?.terms?.actual ? entry.terms.actual.amount : null;
    const repLine = `Its reputation score went from ${before.score} to ${after.score}.`;
    let outcome; let text; let kind = 'alert'; let severity = 'blocked';
    if (result.status === 'refused') {
      outcome = 'blocked';
      const naive = lie?.field === 'price' ? `A buyer with no checks would have signed a payment of ${lie.actual} USDC.`
        : lie?.field === 'payTo' ? `A buyer with no checks would have sent ${fmt(entry.terms.actual.amount)} USDC to ${lie.actual}, an address nobody vetted.`
          : 'A buyer with no checks would have signed that request as it stood.';
      text = `Blocked before signing: ${label}. ${lie ? `${LIE_TEXT[lie.field](lie)} ` : ''}Rule ${result.ruleId}: ${result.reason}. Nothing was signed and nothing was paid. ${naive} `
        + `I did not hire ${listing.name} because an agent that changes the deal after listing it cannot be trusted with a signature. ${repLine} It is excluded for the rest of this task and ranked down in future ones.`;
    } else if (result.status === 'failed') {
      outcome = 'failed'; severity = 'warn';
      text = `${label} did not deliver and I was not charged (${result.reason}). Its payment request looked fine, so I signed an authorization, but it was never settled: no money moved, the reserved budget was released and the authorization expires unused. I did not hire it because there was nothing to pay for. ${repLine}`;
    } else if (result.status === 'pending') {
      outcome = 'pending'; severity = 'warn';
      text = `${label}: the payment is still settling (${result.reason}). I am holding the reserved budget and will resolve it from the chain, so it can never be paid twice.`;
    } else if (r.honest) {
      outcome = 'paid'; kind = 'paid'; severity = 'ok';
      text = `Control: I paid ${fmt(result.paid)} USDC to ${listing.name} and its answer passed my checks. Legitimate buying still works; the checks only stop agents that break the rules.`;
    } else if (result.status === 'rejected' || result.status === 'paid_rejected' || BigInt(result.paid) > 0n) {
      outcome = 'rejected'; severity = 'warn';
      text = `Paid, then rejected: ${label} took ${fmt(result.paid)} USDC and returned an answer that failed my checks (${result.reason}). I discarded the answer, flagged ${listing.name} as a junk seller and excluded it. ${repLine} `
        + `Honest limit: a payment already settled on chain cannot be taken back. What the system guarantees is that the junk never reaches the result and the loss is capped at one call (${fmt(cfg.probationSpendCap)} USDC probation cap).`;
    } else {
      outcome = result.status; severity = 'warn';
      text = `${label}: ${result.status}. ${result.reason}`;
    }
    say(text, kind, severity, r.id);
    const row = { key: st.key, id: r.id, title: r.title, suspect: label, outcome, ruleId: result.ruleId, reason: result.reason, paid: String(result.paid), wouldHavePaid, txHash: result.txHash ?? null, diffs, reputation: { before: before.score, after: after.score }, ledgerEntryId: requestId };
    results.push(row);
    emitStep(st, { status: 'done', ...row, paidUsdc: fmt(result.paid), wouldHavePaidUsdc: wouldHavePaid ? fmt(wouldHavePaid) : null });
    metrics();
    return row;
  }

  async function verifyAll() {
    const chainOk = store.verifyChain();
    let rec = null;
    try {
      const start = store.sessionStartBlock();
      if (start !== null) rec = await g.reconcile({ store, chain, buyerAddress: signer.address, fromBlock: BigInt(start), retry: ctx.reconcileRetry ?? { times: 4, delayMs: 3000 } });
    } catch { /* reported as unverified */ }
    const adj = rec ? adjustReconcile(rec, knownReplayHashes()) : null;
    verification = { chainOk: chainOk.ok, reconcile: adj ? { status: adj.status, ledgerTotal: String(adj.ledgerTotal), chainTotal: String(adj.chainTotal), differences: adj.differences, excludedReplayTransfers: adj.excludedReplayTransfers } : { status: 'unverified' } };
    say(`Proof check: the hash-chained ledger ${chainOk.ok ? 'verifies' : 'is BROKEN'}. Reconciliation against the chain: ${adj ? `${adj.status}, ledger ${fmt(adj.ledgerTotal)} USDC and chain ${fmt(adj.chainTotal)} USDC${adj.excludedReplayTransfers ? ` (${adj.excludedReplayTransfers} earlier replay-test transfer${adj.excludedReplayTransfers > 1 ? 's' : ''} from Beacon's wallet are recorded as tests and left out)` : ''}` : 'could not be completed'}.`, 'info', chainOk.ok && adj?.status === 'matched' ? 'ok' : 'warn');
  }

  async function replayStep(st) {
    const { r, listing } = st;
    emitStep(st, { status: 'running', tactic: r.tactic, listedUsdc: fmt(listing.price) });
    say(`Suspect ${steps.indexOf(st) + 1} of ${steps.length}: ${r.suspect} attacker. I act as someone who captured a signed payment header. I will send it once, replay the same header, then sign a second payment and fire it five times at the same moment against ${listing.name}.`, 'select', undefined, r.id);
    let actor = ctx.replaySigner;
    if (actor) { try { if ((await chain.balanceOf(actor.address)) < listing.price * 2n) actor = null; } catch { actor = null; } }
    const fallback = !actor;
    if (fallback) { actor = signer; say("The replay wallet is not funded, so I am using Beacon's own wallet for this one. Those two payments are a replay test, not purchases, so they are outside the purchase ledger by design.", 'notice', 'warn'); }
    let rr;
    try { rr = await ctx.replay(listing, actor); } catch (e) {
      say(`The replay could not run: ${e.message}`, 'alert', 'warn', r.id);
      const row = { key: st.key, id: r.id, title: r.title, suspect: r.suspect, outcome: 'error', reason: e.message, paid: '0' };
      results.push(row); emitStep(st, { status: 'done', ...row }); return row;
    }
    const layers = ReplayLayers(rr.stage3.filter((c) => c !== 200));
    const retried = (rr.retries?.first || 0) + (rr.retries?.parallel || 0);
    const winners = rr.winners;
    const okAll = rr.pass;
    if (retried) say(`The public facilitator answered 402 to ${retried} good payment${retried > 1 ? 's' : ''} before anything was claimed. That is a transient error, not a replay, so I signed a fresh authorization and tried again.`, 'notice', 'warn', r.id);
    say(`Replay ${okAll ? 'blocked' : 'RESULT NEEDS ATTENTION'}. I signed one payment and sent it: ${rr.stage1}${rr.stage1 === 200 ? ' (served once, as it should be)' : ''}. I sent the same header again: ${rr.stage2}${rr.stage2 !== 200 ? ' (refused)' : ' (SERVED AGAIN)'}. `
      + `I signed a second payment and sent it five times at once: ${rr.stage3.join(', ')}. ${winners} got through; ${layers ? `the rest were stopped ${layers}` : 'none were stopped'}. `
      + `On chain: ${rr.transfers ?? 'unverified'} transfers for 2 signed payments. The extra requests got nothing and cost nothing. One signed authorization unlocks one response.`, 'alert', okAll ? 'blocked' : 'warn', r.id);
    if (fallback && rr.transferHashes?.length) recordReplayHashes(rr.transferHashes);
    replayResult = { ...rr, usedBeaconWallet: fallback };
    const lanes = rr.stage3.map((c, i) => ({ n: i + 1, status: c, layer: c === 200 ? 'accepted: first nonce claim' : c === 409 ? "seller's nonce claim" : c === 402 ? 'verification after settlement' : 'no answer' }));
    const row = { key: st.key, id: r.id, title: r.title, suspect: r.suspect, outcome: okAll ? 'blocked' : 'attention', ruleId: 'M-28', reason: `once ${rr.stage1}; same header ${rr.stage2}; five at once ${rr.stage3.join(', ')}; transfers ${rr.transfers ?? 'unverified'}`, paid: String(listing.price * 2n), lanes, transfers: rr.transfers, wallet: rr.wallet };
    results.push(row);
    emitStep(st, { status: 'done', ...row, paidUsdc: fmt(listing.price * 2n) });
    return row;
  }

  stage('pay');
  for (const st of steps) {
    if (st.r.kind === 'system') { await verifyAll(); await replayStep(st); } else await attempt(st);
  }
  if (!verification) await verifyAll();

  stage('combine');
  const totals = budget.totals(taskId);
  const facts = factsFromLab({ results, totals, verification, replay: replayResult, cfg });
  const report = await beacon.labReport(facts);
  if (report.fallback) say(report.fallback === 'budget' ? "Gemini's free request budget is full for the moment, so this report is written by my rule-based logic. The facts are the same." : 'The model is not responding, so this report is written by my rule-based logic. The facts are the same.', 'notice', 'warn');
  say(report.text, 'incident', 'ok');
  const scoreboard = facts.scoreboard;
  act('completed', `Fraud Lab finished: ${scoreboard.blockedBeforeSigning} blocked before signing, ${scoreboard.paidThenRejected} paid then rejected, ${scoreboard.failedNotCharged} failed without charge.`);
  const result = { kind: 'lab', steps: results, scoreboard, verification, beaconSummary: { text: report.text, source: report.source }, replay: replayResult };
  emit({ type: 'done', status: 'completed', notice: '', result, at: now() });
  return { status: 'completed', result };
}

const RunReq = z.object({
  cases: z.array(z.enum(ORDER)).max(ORDER.length).optional(),
  budget: z.string().regex(/^\d{1,7}$/).optional(),
});

/** Routes: the roster for the page, and one endpoint that starts a lab run as a task (events, chat and polling all reuse the task routes). */
function install(app, ctx, { limiter }) {
  app.get('/api/lab', (_req, res) => res.json({ agents: publicRoster(), order: ORDER, defaultBudget: '50000', note: 'Scripted suspects, no model. Every purchase goes through the real guard.' }));
  app.post('/api/lab/run', limiter, async (req, res) => {
    const p = RunReq.safeParse(req.body ?? {});
    if (!p.success) return res.status(400).json({ error: 'invalid_lab_run', issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (ctx.state.halted) return res.status(409).json({ error: 'spending_halted', detail: ctx.state.haltReason });
    const running = [...ctx.state.tasks.values()].filter((t) => t.status === 'running');
    if (running.some((t) => t.kind === 'lab')) return res.status(409).json({ error: 'lab_running', detail: 'A Fraud Lab run is already in progress.' });
    if (running.length >= 2) return res.status(429).json({ error: 'busy', detail: 'Two tasks are already running. Wait for one to finish.' });
    const budgetUnits = BigInt(p.data.budget ?? '50000');
    if (budgetUnits < 10000n || budgetUnits > 100000n) return res.status(400).json({ error: 'invalid_lab_run', issues: [{ path: 'budget', message: 'Budget must be between 0.01 and 0.10 USDC.' }] });
    const t = ctx.newTask({ text: 'Fraud Lab: Beacon tries each suspect agent', budget: String(budgetUnits), kind: 'lab' });
    res.status(202).json({ taskId: t.id });
    const em = (ev) => ctx.emit(t, ev);
    runLab({ ...ctx }, { taskId: t.id, budget: budgetUnits, cases: p.data.cases }, em).catch((e) => {
      ctx.log?.('error', 'lab crashed', { error: e.message });
      ctx.emit(t, { type: 'done', status: 'stopped', notice: 'The Fraud Lab stopped unexpectedly. Anything already signed is tracked in the ledger.', result: null, at: new Date().toISOString() });
    }).finally(() => { ctx.checkChain(); if (t.status === 'running') t.status = 'stopped'; });
  });
}

module.exports = { runLab, install, adjustReconcile, ROSTER, ORDER, SHAPE_MODES };
