// Attack panel (A-03): fires the hostile cases against the LIVE system through the SAME guard path and shows the verdict.
// Nothing here bypasses guard.pay(). Enabled only when ENABLE_ATTACK_PANEL=true, rate limited.
const { rateLimit } = require('express-rate-limit');
const g = require('@di06/guard');

const CASES = {
  'price-lie': { proves: 'T-04a, P-07', expected: 'REFUSE (M-17). Nothing is signed or paid.', cost: 'Free', seller: 'overquote' },
  'payto-lie': { proves: 'T-04b, P-07', expected: 'REFUSE (S-06). Nothing is signed or paid.', cost: 'Free', seller: 'redirect' },
  junk: { proves: 'T-07, P-10', expected: 'Paid, output rejected (ACCEPT_FLAG). The junk is discarded and the seller flagged.', cost: '0.008 test USDC (Hollow really settles)', seller: 'hollow' },
  failure: { proves: 'T-06, P-09', expected: 'Failed, not charged (RELEASE). No transfer.', cost: 'Free', seller: 'offline' },
  replay5: { proves: 'T-05, P-08', expected: 'One 200 and one transfer per signed payment. Replays get an error.', cost: '0.010 test USDC from the replay wallet', seller: 'atlas' },
  'budget-race': { proves: 'T-03, P-06', expected: 'Spending never passes 0.012 USDC at concurrency 5. The agent stops and says why.', cost: 'Up to 0.012 test USDC', seller: null },
  invariant: { proves: 'T-03, T-05, A-20', expected: 'spent + reserved <= budget after every step across hundreds of random parallel calls. 0 violations.', cost: 'Free (runs in memory)', seller: null },
};

const ser = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
let seq = 0;

function install(app, ctx) {
  const { store, budget, signer, chain, cfg, listings } = ctx;
  app.get('/api/attack', (_req, res) => res.json(Object.entries(CASES).map(([id, c]) => ({ id, ...c }))));
  const limiter = rateLimit({ windowMs: 60_000, limit: ctx.attackLimit ?? 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited', detail: 'Too many attacks, wait a minute.' } });

  async function payOnce(listing, build) {
    const taskId = `atk-${Date.now()}-${++seq}`;
    budget.openTask(taskId, 50000n);
    const requestId = `${taskId}-1`;
    const b = build(listing);
    const r = await g.pay({ store, budget, signer, cfg, chain }, {
      requestId, taskId, seller: { id: listing.id, name: listing.name, category: listing.category },
      listing: { price: listing.price, payTo: listing.payTo, network: g.NETWORK, asset: g.USDC_ADDRESS }, listingHash: listing.listingHash,
      url: b.url, method: b.method, body: b.body, validate: g.makeValidator({ outputSchema: listing.outputSchema }),
      meta: { why: 'Fired from the attack panel', source: 'attack-panel' },
    });
    return { r, requestId };
  }

  const urls = {
    'price-lie': (l) => ({ url: `${l.endpoint}?top=1` }),
    'payto-lie': (l) => ({ url: `${l.endpoint}?country=India&days=7&minMag=4.5` }),
    junk: (l) => ({ url: l.endpoint, method: 'POST', body: JSON.stringify({ countries: [{ name: 'India', quakes: [] }] }) }),
    failure: (l) => ({ url: `${l.endpoint}?top=1` }),
  };

  async function replay(listing) {
    const rs = ctx.replaySigner;
    if (!rs) { const e = new Error('The replay wallet key is not configured (REPLAY_PRIVATE_KEY).'); e.status = 501; e.code = 'no_replay_wallet'; throw e; }
    const bal = await chain.balanceOf(rs.address);
    if (bal < listing.price * 2n) { const e = new Error(`The replay wallet (${rs.address}) holds ${g.formatUsdc(bal)} USDC and needs at least ${g.formatUsdc(listing.price * 2n)}. Fund it at the Circle faucet.`); e.status = 400; e.code = 'replay_wallet_unfunded'; throw e; }
    const startBlock = await chain.blockNumber();
    const url = `${listing.endpoint}?top=1`;
    const sign = async () => {
      const r = await fetch(url);
      const header = r.headers.get('payment-required');
      if (r.status !== 402 || !header) throw new Error(`expected a 402 from the seller, got ${r.status}`);
      const ev = g.evaluateHeader(header, { listing: { price: listing.price, payTo: listing.payTo, network: g.NETWORK, asset: g.USDC_ADDRESS }, snapshotHash: 'a', liveListingHash: 'a', buyerAddress: rs.address, config: { maxTimeoutSeconds: cfg.maxTimeoutSeconds, oddDropRatioPct: cfg.oddDropRatioPct } });
      if (ev.decision.verdict !== 'ALLOW') throw new Error(`the seller 402 failed the price check: ${ev.decision.reason}`);
      const raw = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
      return (await rs.signPayment({ ...raw, accepts: [raw.accepts[ev.chosenIndex]] })).headers;
    };
    const send = (h) => fetch(url, { headers: h, signal: AbortSignal.timeout(cfg.requestTimeoutMs) }).then((r) => r.status).catch(() => 0);
    const a = await sign();
    const first = await send(a);
    const second = await send(a);
    const b = await sign();
    const parallel = await Promise.all(Array.from({ length: 5 }, () => send(b)));
    let transfers = null;
    await new Promise((r) => setTimeout(r, 4000));
    try { transfers = (await chain.getTransfersFrom(rs.address, BigInt(startBlock))).filter((t) => t.to.toLowerCase() === listing.payTo.toLowerCase()).length; } catch { /* unverified */ }
    const winners = parallel.filter((c) => c === 200).length;
    const pass = first === 200 && second !== 200 && winners === 1 && (transfers === null || transfers === 2);
    return { stage1: first, stage2: second, stage3: parallel, winners, transfers, pass, wallet: rs.address };
  }

  app.post('/api/attack/:case', limiter, async (req, res) => {
    const id = req.params.case;
    const c = CASES[id];
    if (!c) return res.status(404).json({ error: 'unknown_case', cases: Object.keys(CASES) });
    if (ctx.state.halted) return res.status(409).json({ error: 'spending_halted', detail: ctx.state.haltReason });
    const t0 = Date.now();
    const base = { case: id, proves: c.proves, expected: c.expected };
    try {
      if (id === 'invariant') {
        const s = await g.runInvariant({ seed: Number(req.body?.seed) || 42, runs: Math.min(Number(req.body?.runs) || 300, 500), cfg });
        return res.json(ser({ ...base, actual: { verdict: s.violations === 0 ? 'PASS' : 'FAIL', ruleId: 'A-20', reason: `${s.runs} random runs, ${s.calls} calls, max spent+reserved ${s.maxSeen}, ${s.violations} violations` }, summary: s, paid: '0', durationMs: Date.now() - t0 }));
      }
      if (id === 'budget-race') {
        return res.json({ ...base, startTask: { text: 'For the 2 most populous countries, find earthquakes of magnitude 4.0 or more from the last 30 days and write a short readiness brief for each.', budget: '12000', maxConcurrency: 5 }, actual: { verdict: 'READY', ruleId: 'M-15', reason: 'Start the task. Watch the budget meter: spent plus reserved never passes the cap.' }, paid: '0', durationMs: Date.now() - t0 });
      }
      const all = await listings();
      const listing = all.find((l) => l.id === c.seller);
      if (!listing) return res.status(404).json({ error: 'seller_not_registered', detail: `${c.seller} is not in the registry` });
      if (id === 'replay5') {
        const r = await replay(listing);
        return res.json(ser({ ...base, actual: { verdict: r.pass ? 'PASS' : 'FAIL', ruleId: 'M-28', reason: `once: ${r.stage1}; same header again: ${r.stage2}; five in parallel: ${r.stage3.join(', ')}; transfers on chain: ${r.transfers ?? 'unverified'}` }, replay: r, paid: String(listing.price * 2n), durationMs: Date.now() - t0 }));
      }
      const { r, requestId } = await payOnce(listing, urls[id]);
      ctx.checkChain();
      const entry = store.listEntries().find((e) => e.id === requestId);
      return res.json(ser({ ...base, actual: { verdict: r.verdict, ruleId: r.ruleId, reason: r.reason, status: r.status }, paid: r.paid, txHash: r.txHash, ledgerEntryId: requestId, callNo: entry?.callNo, durationMs: Date.now() - t0 }));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'attack_failed', detail: e.message });
    }
  });
}

module.exports = { install, CASES };
