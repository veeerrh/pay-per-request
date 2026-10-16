// Usage: npm run task -- --id 1 --budget 0.050 --concurrency 3 [--new-session] [--db data/buyer.db]
// Runs one of the example tasks on the real testnet and prints the receipt, then reconciles against the chain.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env'), quiet: true });
const path = require('path');
const fs = require('fs');
const g = require('@di06/guard');
const { runTask } = require('./runner');
const { loadLocalListings } = require('./listings');
const { formatReceipt, fmt } = require('./reporter');

const ROOT = path.join(__dirname, '..', '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);

(async () => {
  g.assertTestnet({ NETWORK: process.env.NETWORK || 'eip155:84532', CHAIN_ID: process.env.CHAIN_ID || '84532', USDC_ADDRESS: process.env.USDC_ADDRESS || g.USDC_ADDRESS });
  const tasks = require(path.join(ROOT, 'config', 'tasks.json'));
  const t = tasks.find((x) => x.id === Number(arg('id', '1')));
  if (!t) { console.error('unknown task id'); process.exit(1); }
  const budgetUnits = g.fromUsdc(arg('budget', t.budget));
  const maxConcurrency = Number(arg('concurrency', t.maxConcurrency));
  if (![1, 2, 3, 4, 5].includes(maxConcurrency)) { console.error('concurrency must be 1 to 5'); process.exit(1); }

  const cfg = g.loadConfig(path.join(ROOT, 'config', 'rules.config.json'));
  const rsh = g.ruleSetHash(cfg, path.join(ROOT, 'packages', 'guard', 'dist', 'rules'));
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const store = new g.Store(path.resolve(arg('db', path.join(ROOT, 'data', 'buyer.db'))), rsh);
  const chain = g.createChainReader(process.env.RPC_URL);
  const signer = g.createSigner();
  let walletBalance = 0n;
  walletBalance = await chain.balanceOf(signer.address);
  const budget = new g.Budget(store, cfg, () => walletBalance);
  const start = await g.startGuard({ store, budget, chain, signerAddress: signer.address });
  if (start.spendingHalted) { console.error('SPENDING HALTED:', start.reason); process.exit(1); }
  if (flag('new-session')) store.newSession(Number(await chain.blockNumber())); // only after the old session's pending purchases were resolved
  if (start.recovered.length) console.log('recovered pending purchases:', start.recovered.map((r) => `${r.requestId}:${r.outcome}`).join(', '));

  const taskId = `t${Date.now()}`;
  console.log(`Task ${t.id}: ${t.text}\nBudget ${fmt(budgetUnits)} USDC, max concurrency ${maxConcurrency}\n`);
  const result = await runTask({ store, budget, signer, cfg, chain, listings: async () => loadLocalListings() },
    { taskId, text: t.text, budget: budgetUnits, maxConcurrency },
    (ev) => { if (ev.type === 'activity') console.log(`  [${ev.kind}] ${ev.text}`); });

  console.log(`\nSTATUS: ${result.status.toUpperCase()}${result.notice ? ' - ' + result.notice : ''}\n`);
  if (result.entries) console.log(formatReceipt(result.result.breakdown, result.totals));
  if (result.result) { console.log('\nASSESSMENT:', result.result.assessment.title, '|', result.result.assessment.summary); result.result.evidence.forEach((e) => console.log('  -', e)); }
  console.log('\nledger chain verifies:', store.verifyChain().ok);

  // Resolve anything still pending (slow facilitator, lost response) from the chain, for up to 90 seconds.
  for (let i = 0; i < 18 && store.unfinishedIntents().length; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const rec = await g.recoverPending({ store, budget, chain, signerAddress: signer.address, cfgMaxTimeoutSeconds: cfg.maxTimeoutSeconds });
    rec.filter((x) => x.outcome !== 'held').forEach((x) => console.log(`recovered ${x.requestId}: ${x.outcome} (${x.reason})`));
  }
  const sess = store.db.prepare('SELECT start_block FROM sessions WHERE id=?').get(store.sessionId);
  if (sess && sess.start_block != null) {
    await new Promise((r) => setTimeout(r, 4000));
    const rec = await g.reconcile({ store, chain, buyerAddress: signer.address, fromBlock: BigInt(sess.start_block), retry: { times: 4, delayMs: 3000 } });
    console.log(`reconciliation: ${rec.status.toUpperCase()} (ledger ${rec.ledgerTotal}, chain ${rec.chainTotal})`);
    rec.differences.forEach((d) => console.log('  difference:', d.status, d.txHash || '-', String(d.ledgerAmount), String(d.chainAmount)));
  } else console.log('reconciliation skipped: this session has no start block (use --new-session)');
  store.close();
})().catch((e) => { console.error('task failed:', e.message); process.exitCode = 1; });
