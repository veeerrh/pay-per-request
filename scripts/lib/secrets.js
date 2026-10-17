// Shared secret-shape detection for the bundle, log and tracked-file scans (T-09, M-38, M-39).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

// Shapes that look like a secret being ASSIGNED. A bare 64-hex value is also a transaction hash, so it only counts near a key-like word.
const PATTERNS = [
  ['key assigned to a key-like name', /(private[_-]?key|secret|api[_-]?key|access[_-]?token|operator[_-]?token|mnemonic)\s*["']?\s*[:=]\s*["']?(0x)?[A-Za-z0-9+/=_-]{32,}/i],
  ['64-hex near a key word', /(key|secret|mnemonic|seed)[^\n]{0,40}0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/i],
  ['PEM private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['payment or authorization header value', /(authorization|payment-signature|payment-required)["']?\s*[:=]\s*["']?(Bearer\s+)?[A-Za-z0-9+/_=.-]{40,}/i],
  ['long base64 blob', /[A-Za-z0-9+/]{300,}={0,2}/],
];

function scanText(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line)) { hits.push({ line: i + 1, rule: name }); break; }
  });
  return hits;
}

/** Real secret VALUES from .env (never printed). Used to search files for an exact leak. */
function envSecrets() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]*(KEY|TOKEN|SECRET)[A-Z0-9_]*)=(.+)$/)).filter(Boolean)
    .map((m) => ({ name: m[1], value: m[3].trim() })).filter((s) => s.value.length >= 16);
}

function walk(dir, skip = () => false) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (skip(full, e)) continue;
    if (e.isDirectory()) out.push(...walk(full, skip)); else out.push(full);
  }
  return out;
}

const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|zip|gz|db|sqlite)$/i;
function scanFiles(files, { exact = true } = {}) {
  const secrets = exact ? envSecrets() : [];
  const findings = [];
  for (const f of files) {
    if (BINARY.test(f)) continue;
    let text;
    try { const st = fs.statSync(f); if (st.size > 5_000_000) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const h of scanText(text)) findings.push({ file: path.relative(ROOT, f), line: h.line, rule: h.rule });
    for (const s of secrets) if (text.includes(s.value)) findings.push({ file: path.relative(ROOT, f), line: 0, rule: `exact value of ${s.name} (.env)` });
  }
  return findings;
}

module.exports = { scanText, scanFiles, walk, envSecrets, ROOT };
