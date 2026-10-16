// Compares Beacon's ledger with USDC transfers out of Beacon's wallet since the session started (T-02).
// Usage: node scripts/reconcile.js [--db data/buyer.db]   (exit code 1 on any difference or if the chain cannot be read)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const path = require('path');
const g = require('../packages/guard/dist');
const addr = require('../config/addresses.json');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

(async () => {
  const cfg = g.loadConfig(path.join(__dirname, '..', 'config', 'rules.config.json'));
  const store = new g.Store(path.resolve(arg('db', 'data/buyer.db')), g.ruleSetHash(cfg, path.join(__dirname, '..', 'packages', 'guard', 'dist', 'rules')));
  const sess = store.db.prepare('SELECT start_block FROM sessions WHERE id=?').get(store.sessionId);
  if (!sess || sess.start_block == null) { console.error('session has no start block; cannot reconcile'); process.exit(1); }
  const chain = g.createChainReader(process.env.RPC_URL);
  const r = await g.reconcile({ store, chain, buyerAddress: addr.buyers.beacon, fromBlock: BigInt(sess.start_block) });
  console.log(`session ${store.sessionId}, from block ${sess.start_block}`);
  for (const row of r.rows) console.log(`${row.status.padEnd(18)} ledger ${String(row.ledgerAmount).padStart(7)}  chain ${String(row.chainAmount).padStart(7)}  ${row.txHash || '-'}`);
  console.log(`\nledger total ${r.ledgerTotal}  chain total ${r.chainTotal}  => ${r.status.toUpperCase()}${r.error ? ' (' + r.error + ')' : ''}`);
  if (r.wallet) console.log(`wallet balance ${r.wallet.balance} units (${r.wallet.note})`);
  store.close();
  process.exitCode = r.ok ? 0 : 1;
})().catch((e) => { console.error('reconcile failed:', e.message); process.exitCode = 1; });
