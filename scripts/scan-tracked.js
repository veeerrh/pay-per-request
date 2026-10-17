// Searches every file Git tracks for exact secret values from .env and for secret-shaped strings.
const { execSync } = require('child_process');
const path = require('path');
const { scanFiles, ROOT } = require('./lib/secrets');
const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => !/package-lock\.json$|\.test\.(js|ts)$|(^|\/)test\//.test(f)).map((f) => path.join(ROOT, f));
const hits = scanFiles(files);
console.log(`tracked-file scan: ${files.length} files, ${hits.length} finding(s)`);
hits.forEach((h) => console.log(`  ${h.file}:${h.line}  ${h.rule}`));
process.exitCode = hits.length ? 1 : 0;
