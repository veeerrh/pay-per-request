// Live smoke test of guard.pay() with the real signer against any x402 seller URL.
// Usage: node scripts/pay-smoke.js <url> <listedUnits> <payTo>
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const path = require('path');
const g = require('../packages/guard/dist');
const [url, listed, payTo] = process.argv.slice(2);
(async () => {
  const cfg = g.loadConfig(path.join(__dirname, '..', 'config', 'rules.config.json'));
  const signer = g.createSigner();
  const store = new g.Store(':memory:', g.ruleSetHash(cfg, path.join(__dirname, '..', 'packages', 'guard', 'dist', 'rules')));
  const budget = new g.Budget(store, cfg);
  budget.openTask('smoke', 10000n);
  const r = await g.pay({ store, budget, signer, cfg, log: g.createLogger() }, {
    requestId: 'smoke1', taskId: 'smoke', seller: { id: 'smoke', name: 'Smoke', category: 'scraping' },
    listing: { price: BigInt(listed), payTo, network: g.NETWORK, asset: g.USDC_ADDRESS }, listingHash: 'smoke', url,
  });
  console.log({ ...r, asked: String(r.asked), paid: String(r.paid) });
  console.log('chain ok:', store.verifyChain().ok, 'totals:', JSON.stringify(budget.totals('smoke'), (k, v) => typeof v === 'bigint' ? v.toString() : v));
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
