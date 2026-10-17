// T-09, M-38: inspect the logs. A log line must never carry a key, signature or payment header.
const path = require('path');
const { walk, scanFiles, ROOT } = require('./lib/secrets');
const files = walk(path.join(ROOT, 'logs')).filter((f) => f.endsWith('.log'));
const hits = scanFiles(files);
console.log(`log scan: ${files.length} log file(s), ${hits.length} finding(s)`);
hits.forEach((h) => console.log(`  ${h.file}:${h.line}  ${h.rule}`));
process.exitCode = hits.length ? 1 : 0;
