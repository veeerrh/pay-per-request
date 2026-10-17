// Relay: an inference agent that HIRES another agent. A buyer pays Relay once; Relay buys the earthquake data from Tremor itself, with its own
// wallet and through the same payment guard Beacon uses (price, payee, token, network and schema checks, budget reservation, hash-chained
// ledger), then writes the readiness briefs. So money moves in a chain: buyer -> Relay -> Tremor, and Relay pays Tremor out of what buyers pay it.
//
// Honest notes on how the money works:
//  - Relay is paid only after it delivers (no service, no charge), so it needs a small working float to buy the data first. The float is refilled
//    by what buyers pay it: a call earns 0.006 to 0.010 USDC and costs 0.002 per country, so it keeps itself going once it is seeded.
//  - If Tremor fails, Relay answers with an error, the buyer is not charged, and Relay absorbs whatever it already paid Tremor.
//  - Relay is the only seller that holds a private key (design M-71, "if the agent chain is built"). It reads RELAY_PRIVATE_KEY from its own
//    environment; the registry, the other sellers and Beacon never receive it.
const crypto = require('crypto');
const g = require('@di06/guard');
const { boot, ROOT, addresses } = require('./common');
const { createBriefWriter } = require('./brief');

const CEILING = '10000'; // listed price: the most a call can cost (the same as Brief, so an unproven Relay still fits the per-task probation cap twice)
const METER = { base: 2000, perCountry: 4000 }; // 1 country 6000, 2 countries 10000
const quoteUnits = (body) => { const n = Array.isArray(body?.countries) ? body.countries.length : 2; return String(METER.base + METER.perCountry * Math.min(Math.max(n, 1), 2)); };

/** Tremor's listing as the registry publishes it. Cached for a minute. */
function registryTremor({ registryUrl, fetchImpl = fetch, now = () => Date.now() }) {
  let cached = null;
  return async () => {
    if (cached && now() - cached.at < 60_000) return cached.v;
    const r = await fetchImpl(`${registryUrl.replace(/\/$/, '')}/services`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`registry answered ${r.status}`);
    const s = (await r.json()).find((x) => x.id === 'tremor' && x.status === 'active');
    if (!s) throw new Error('Tremor is not listed as active in the registry');
    const v = { id: s.id, name: s.name, category: s.category, price: BigInt(s.price), payTo: s.payTo, endpoint: s.endpoint, listingHash: s.listingHash, outputSchema: s.outputSchema };
    cached = { at: now(), v };
    return v;
  };
}

/**
 * Buys one country's earthquake data from Tremor through guard.pay(). Returns { data, paid, txHash } or throws with the reason.
 * deps: { store, budget, signer, cfg, chain, log, tremorListing }
 */
function createHirer(deps) {
  let seq = 0;
  const opened = new Set();
  return async function hire(country, { days, minMag, taskId }) {
    const t = await deps.tremorListing();
    // One hard spending cap per buyer request (at most two Tremor calls), opened once however many countries the request has.
    if (!opened.has(taskId)) { deps.budget.openTask(taskId, t.price * 2n); opened.add(taskId); }
    // A purchase that FAILED is safe to repeat once: "failed" means the signed authorisation is confirmed unused on chain and nothing was
    // charged (the public facilitator sometimes answers a transient 402). Refused, rejected and pending outcomes are never retried.
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      const requestId = `${taskId}-${++seq}`;
      result = await g.pay({ store: deps.store, budget: deps.budget, signer: deps.signer, cfg: deps.cfg, chain: deps.chain, log: deps.log, ...(deps.fetch ? { fetch: deps.fetch } : {}) }, {
        requestId, taskId, seller: { id: t.id, name: t.name, category: t.category },
        listing: { price: t.price, payTo: t.payTo, network: g.NETWORK, asset: g.USDC_ADDRESS }, listingHash: t.listingHash,
        url: `${t.endpoint}?country=${encodeURIComponent(country)}&days=${days}&minMag=${minMag}`,
        validate: g.makeValidator({ outputSchema: t.outputSchema, sanity: 'tremor', context: { country, days, minMag } }),
        meta: { why: `Relay hires ${t.name} for ${country}`, source: 'relay' },
      });
      if (result.status !== 'failed') break;
    }
    if (result.status !== 'paid') throw new Error(`${t.name} ${result.status} (${result.ruleId}): ${result.reason}`);
    return { data: result.output, paid: result.paid, txHash: result.txHash, seller: t.name };
  };
}

/**
 * opts.hire(country, { days, minMag, taskId }) is injectable for tests. opts.unavailable() returns a reason when the working float is too low.
 * opts.payments() returns the read-only receipts shown at GET /payments.
 */
function createRelay(opts = {}) {
  const writer = createBriefWriter('RELAY', opts);
  const hire = opts.hire;
  if (typeof hire !== 'function') throw new Error('createRelay needs a hire function');

  const app = boot('relay', 4014, {
    method: 'POST', path: '/relay', priceUnits: CEILING, priceFn: quoteUnits, handlerTimeoutMs: 45000,
    ...(opts.payTo ? { payTo: opts.payTo } : {}),
    discovery: { bodyType: 'json', input: { countries: [{ name: 'India' }], days: 7, minMag: 4.5 }, inputSchema: { properties: { countries: { type: 'array', minItems: 1, maxItems: 2 } }, required: ['countries'] }, output: { example: { briefs: [] } } },
    description: 'Agent chain: you pay Relay once, Relay buys the earthquake data from Tremor with its own wallet and writes the readiness brief. Metered per country (0.006 for one, 0.010 for two).',
    inputCheck: (req) => {
      const b = req.body;
      if (!Array.isArray(b?.countries) || b.countries.length < 1) return 'countries must be a non-empty array';
      if (b.countries.length > 2) return 'at most 2 countries per call';
      for (const c of b.countries) if (typeof c?.name !== 'string' || !c.name || c.name.length > 80) return 'each country needs a name';
      const days = b.days === undefined ? 7 : b.days, minMag = b.minMag === undefined ? 4.5 : b.minMag;
      if (!Number.isInteger(days) || days < 1 || days > 30) return 'days must be a whole number from 1 to 30';
      if (typeof minMag !== 'number' || !(minMag >= 0 && minMag <= 9)) return 'minMag must be between 0 and 9';
      return null;
    },
    unavailable: opts.unavailable,
    handler: async (req) => {
      const { countries, days = 7, minMag = 4.5 } = req.body;
      const taskId = `relay-${crypto.randomBytes(5).toString('hex')}`;
      const hired = [];
      const data = [];
      // One country at a time: if the first purchase fails, nothing more is spent.
      for (const c of countries) {
        const r = await hire(c.name, { days, minMag, taskId });
        hired.push({ seller: r.seller, country: c.name, paidUnits: String(r.paid), txHash: r.txHash });
        data.push({ country: c.name, window_days: days, quakes: r.data.quakes ?? [], ...(r.data.digest ? { digest: r.data.digest } : {}) });
      }
      const out = await writer.compose(countries.map((c, i) => ({ name: c.name, quakes: data[i].quakes })));
      return { ...out, meta: { ...out.meta, chain: { agent: 'Relay', hired, spentUnits: String(hired.reduce((s, h) => s + BigInt(h.paidUnits), 0n)), data } } };
    },
    outputCheck: (o) => (o.briefs.every((b) => ['low', 'medium', 'high'].includes(b.readiness)) ? null : 'bad readiness'),
  }, {}); // never auto-listens: the process entry point below starts it

  // Read-only receipts: where Relay's money went. No secrets, no payment paths.
  app.get('/payments', (_req, res) => res.json(opts.payments ? opts.payments() : { wallet: opts.payTo ?? null, payments: [] }));
  return app;
}

/** The real thing, built from the environment: Relay's own key, store, budget, chain reader and registry. Only used when run as a process. */
function createRelayFromEnv(env = process.env) {
  const signer = g.createSigner('RELAY_PRIVATE_KEY');
  const expected = addresses.sellers.relay;
  if (!expected || signer.address.toLowerCase() !== String(expected).toLowerCase()) throw new Error(`RELAY_PRIVATE_KEY does not belong to the Relay address in config/addresses.json (${expected ?? 'none'})`);
  require('fs').mkdirSync(`${ROOT}/data`, { recursive: true });
  const cfg = g.loadConfig(`${ROOT}/config/rules.config.json`);
  const store = new g.Store(`${ROOT}/data/relay.db`, g.ruleSetHash(cfg, `${ROOT}/packages/guard/dist/rules`));
  const chain = g.createChainReader(env.RPC_URL);
  const log = g.createLogger((l) => console.log(`[relay] ${l}`));
  let cached = { at: 0, v: 0n };
  const refresh = async () => { cached = { at: Date.now(), v: await chain.balanceOf(signer.address) }; };
  refresh().catch(() => undefined);
  setInterval(() => refresh().catch(() => undefined), 15000).unref();
  const budget = new g.Budget(store, cfg, () => cached.v);
  Promise.resolve().then(async () => {
    if (store.sessionStartBlock() === null) store.setSessionStartBlock(Number(await chain.blockNumber()));
    const start = await g.startGuard({ store, budget, chain, signerAddress: signer.address, cfgMaxTimeoutSeconds: cfg.maxTimeoutSeconds, log });
    if (start.recovered.length) log('info', 'recovered pending purchases', start.recovered);
    g.startRecoveryLoop({ store, budget, chain, signerAddress: signer.address, cfgMaxTimeoutSeconds: cfg.maxTimeoutSeconds, log });
  }).catch((e) => log('warn', 'relay start-up check failed', { error: e.message }));
  const registryUrl = env.REGISTRY_URL || 'http://localhost:4000';
  const tremorListing = registryTremor({ registryUrl });
  const base = createHirer({ store, budget, signer, cfg, chain, log, tremorListing });
  const hire = base;
  const unavailable = () => {
    // Same wallet floor Beacon uses: do not start a purchase the wallet could not cover (M-58).
    const need = BigInt(cfg.balanceFloor) + 2n * 2000n;
    return cached.at && cached.v < need ? 'Relay is out of working capital for the moment (its wallet is below the safety floor); nothing was charged' : null;
  };
  const payments = () => ({
    wallet: signer.address, network: g.NETWORK, balanceUnits: String(cached.v), note: 'Relay pays Tremor from its own wallet; buyers pay Relay.',
    payments: store.listEntries().filter((e) => e.source === 'relay').slice(-30).reverse().map((e) => ({ time: e.time, seller: e.seller, status: e.status, paidUnits: String(e.paid), txHash: e.txHash ?? null, why: e.why })),
  });
  return createRelay({ hire, unavailable, payments, payTo: signer.address });
}

if (require.main === module) {
  require('dotenv').config({ path: `${ROOT}/.env`, quiet: true });
  try { createRelayFromEnv().listen(Number(process.env.PORT || 4014), () => console.log(`relay seller on :${process.env.PORT || 4014}`)); } catch (e) { console.error('Relay failed to start:', e.message); process.exit(1); }
}

module.exports = { createRelay, createRelayFromEnv, createHirer, registryTremor, quoteUnits, METER, CEILING };
