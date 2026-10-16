// Runs N real purchases through guard.pay() into data/buyer.db with a fresh session (live integration test).
// Usage: node scripts/live-pay.js <url> <listedUnits> <payTo> [count=3]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const path = require('path');
const fs = require('fs');
const g = require('../packages/guard/dist');
const [url, listed, payTo, count = '3'] = process.argv.slice(2);

(async () => {
  const cfg = g.loadConfig(path.join(__dirname, '..', 'config', 'rules.config.json'));
  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  const rsh = g.ruleSetHash(cfg, path.join(__dirname, '..', 'packages', 'guard', 'dist', 'rules'));
  const store = new g.Store(path.join(__dirname, '..', 'data', 'buyer.db'), rsh);
  const chain = g.createChainReader(process.env.RPC_URL);
  store.newSession(Number(await chain.blockNumber()));
  const budget = new g.Budget(store, cfg);
  const taskId = `live-${Date.now()}`;
  budget.openTask(taskId, 50000n);
  const signer = g.createSigner();
  for (let i = 1; i <= Number(count); i++) {
    const r = await g.pay({ store, budget, signer, cfg, chain, log: g.createLogger() }, {
      requestId: `${taskId}-${i}`, taskId, seller: { id: 'echo', name: 'Echo', category: 'data' },
      listing: { price: BigInt(listed), payTo, network: g.NETWORK, asset: g.USDC_ADDRESS }, listingHash: 'live', url,
    });
    console.log(i, r.status, String(r.paid), r.txHash);
  }
  console.log('chain verifies:', store.verifyChain().ok);
  store.close();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
