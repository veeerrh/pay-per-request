// T-09: inspect the web bundle. Exit 1 on any secret-shaped string or exact .env secret value.
const path = require('path');
const { walk, scanFiles, ROOT } = require('./lib/secrets');
const files = walk(path.join(ROOT, 'web'));
const hits = scanFiles(files);
// The browser bundle must never mention these either.
const fs = require('fs');
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  for (const w of ['BEACON_PRIVATE_KEY', 'REPLAY_PRIVATE_KEY', 'SPARE_BUYER_PRIVATE_KEY', 'OPERATOR_TOKEN=', 'MODEL_API_KEY', 'GEMINI_API_KEY', 'BEACON_GEMINI_API_KEY', 'ATLAS_GEMINI_API_KEY', 'TREMOR_GEMINI_API_KEY', 'BRIEF_GEMINI_API_KEY']) if (t.includes(w)) hits.push({ file: path.relative(ROOT, f), line: 0, rule: `mentions ${w}` });
}
console.log(`bundle scan: ${files.length} files in web/, ${hits.length} finding(s)`);
hits.forEach((h) => console.log(`  ${h.file}:${h.line}  ${h.rule}`));
process.exitCode = hits.length ? 1 : 0;
