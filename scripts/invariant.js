// Usage: npm run invariant -- --seed 42 --runs 300
const path = require('path');
const g = require('../packages/guard/dist');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const cfg = g.loadConfig(path.join(__dirname, '..', 'config', 'rules.config.json'));
const seed = Number(arg('seed', '42')), runs = Number(arg('runs', '300'));
const t0 = Date.now();
g.runInvariant({ seed, runs, cfg }).then((s) => {
  console.log(JSON.stringify({ ...s, maxSeen: s.maxSeen.toString(), ms: Date.now() - t0 }, null, 2));
  process.exitCode = s.violations === 0 && s.chainOk ? 0 : 1;
});
