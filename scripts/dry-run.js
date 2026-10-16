// Usage: npm run dry-run -- --task 1 --budget 0.012
// Pre-sign rules only: nothing is signed, nothing touches the chain or a database.
const path = require('path');
const g = require('../packages/guard/dist');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const task = Number(arg('task', '1'));
const budget = g.fromUsdc(arg('budget', '0.050'));
const cfg = g.loadConfig(path.join(__dirname, '..', 'config', 'rules.config.json'));
const addr = require('../config/addresses.json');

const base = { network: g.NETWORK, asset: g.USDC_ADDRESS };
const mk = (id, cat, listed, asked, payToKey = id, lie) => ({
  label: id, sellerId: id, category: cat,
  listing: { price: BigInt(listed), payTo: addr.sellers[payToKey] || addr.sellers[id], ...base },
  accepts: [{ scheme: 'exact', ...base, amount: BigInt(asked), payTo: lie || addr.sellers[payToKey] || addr.sellers[id], maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }],
});
const tremor = (n) => Array.from({ length: n }, (_, i) => ({ ...mk('tremor', 'data', 2000, 2000), label: `tremor #${i + 1}` }));
const N = { 1: [3, 2], 2: [4, 2], 3: [2, 1] }[task] || [3, 2];
const steps = [
  mk('overquote', 'scraping', 2000, 20000), mk('offline', 'scraping', 4000, 4000), mk('atlas', 'scraping', 5000, 5000),
  mk('redirect', 'data', 1000, 1000, 'redirect', addr.sellers['redirect-decoy']), ...tremor(N[0]),
  mk('hollow', 'inference', 8000, 8000), ...Array.from({ length: N[1] }, (_, i) => ({ ...mk('brief', 'inference', 10000, 10000), label: `brief #${i + 1}` })),
];

console.log(`rule-set hash: ${g.ruleSetHash(cfg, path.join(__dirname, '..', 'packages', 'guard', 'dist', 'rules'))}`);
console.log(`task ${task}, budget ${g.formatUsdc(budget)} USDC\n`);
const res = g.dryRun(steps, budget, cfg, addr.buyers.beacon, 20_000_000n);
for (const r of res) console.log(`${r.label.padEnd(12)} ${r.verdict.verdict.padEnd(9)} ${r.verdict.ruleId.padEnd(6)} spend ${String(r.wouldSpend).padStart(6)}  left ${String(r.remainingAfter).padStart(6)}  ${r.verdict.reason}`);
