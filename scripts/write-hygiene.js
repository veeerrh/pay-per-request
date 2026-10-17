// npm run scan: gitleaks over the FULL history, tracked files, web bundle, logs and dependency audit. Writes config/hygiene.json.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const run = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' && cmd !== process.execPath }); return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-3).join(' | ') }; };
const checks = {
  gitleaks_history: run('gitleaks', ['git', '--redact', '--no-banner']),
  tracked_files: run(process.execPath, ['scripts/scan-tracked.js']),
  web_bundle: run(process.execPath, ['scripts/bundle-scan.js']),
  logs: run(process.execPath, ['scripts/scan-logs.js']),
  npm_audit: run('npm', ['audit', '--audit-level=high', '--omit=dev']),
};
const commit = run('git', ['rev-parse', '--short', 'HEAD']).out.split(' | ').pop();
const report = { ok: Object.values(checks).every((c) => c.ok), at: new Date().toISOString(), commit, checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok])) };
fs.writeFileSync(path.join(ROOT, 'config', 'hygiene.json'), JSON.stringify(report, null, 2) + '\n');
for (const [k, v] of Object.entries(checks)) console.log(`${v.ok ? 'PASS' : 'FAIL'}  ${k}${v.ok ? '' : '  ' + v.out}`);
console.log(report.ok ? '\nAll checks passed.' : '\nFindings exist. Fix them before the freeze.');
process.exitCode = report.ok ? 0 : 1;
