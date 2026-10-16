// Live check: guard.pay() (real signer, real facilitator) against the four running test vendors.
// Expected: overquote refused (price lie), redirect refused (payTo lie), offline failed not charged, hollow paid 8000 + output rejected.
// Needs the sellers running (npm run start:sellers). Spends 8000 units from Beacon on Hollow.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const path = require('path');
const g = require('../packages/guard/dist');
const addr = require('../config/addresses.json');
const L = (n) => require(`../config/listings/${n}.json`);

(async () => {
  const cfg = g.loadConfig(path.join(__dirname, '..', 'config', 'rules.config.json'));
  const store = new g.Store(':memory:', 'fixture-check');
  const budget = new g.Budget(store, cfg);
  budget.openTask('fx', 50000n);
  const chain = g.createChainReader(process.env.RPC_URL);
  const signer = g.createSigner();
  const deps = { store, budget, signer, cfg, chain, log: g.createLogger(() => undefined) };
  const cases = [
    ['overquote', 'http://localhost:4021/countries?top=3', 'scraping', null],
    ['redirect', 'http://localhost:4022/quakes?country=India&days=7&minMag=4.5', 'data', null],
    ['offline', 'http://localhost:4024/countries?top=3', 'scraping', null],
    ['hollow', 'http://localhost:4023/brief', 'inference', JSON.stringify({ countries: [{ name: 'India', quakes: [] }] })],
  ];
  for (const [id, url, category, body] of cases) {
    const l = L(id);
    const r = await g.pay(deps, {
      requestId: `fx-${id}`, taskId: 'fx', seller: { id, name: l.name, category }, url, method: body ? 'POST' : 'GET', body: body || undefined,
      listing: { price: BigInt(l.price), payTo: addr.sellers[id], network: g.NETWORK, asset: g.USDC_ADDRESS }, listingHash: `fx-${id}`,
      validate: g.makeValidator({ outputSchema: l.outputSchema }),
    });
    console.log(id.padEnd(10), r.status.padEnd(9), r.ruleId.padEnd(6), `paid ${r.paid}`.padEnd(10), r.txHash || '-', '|', r.reason.slice(0, 90));
  }
  console.log('budget', JSON.stringify(budget.totals('fx'), (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
