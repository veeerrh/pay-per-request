// Idempotent: registers the 7 listings from config/listings/*.json with the registry.
// Usage: node scripts/seed-registry.js [registryUrl=http://localhost:4000] [sellerBase=http://localhost]
//   public run: node scripts/seed-registry.js $PUBLIC_BASE_URL/registry $PUBLIC_BASE_URL   (paths become /<name>/...)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const addr = require(path.join(ROOT, 'config', 'addresses.json'));
const registry = (process.argv[2] || 'http://localhost:4000').replace(/\/$/, '');
const base = (process.argv[3] || 'http://localhost').replace(/\/$/, '');
const publicMode = base.startsWith('https://');
const PROBE = { atlas: 'top=3', overquote: 'top=3', offline: 'top=3', tremor: 'country=India', redirect: 'country=India' };

(async () => {
  const dir = path.join(ROOT, 'config', 'listings');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const id = f.replace('.json', '');
    const l = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const endpoint = publicMode ? `${base}/${id}${l.path}` : `${base}:${l.port}${l.path}`;
    const body = {
      name: l.name, category: l.category, endpoint, method: l.method, price: l.price, network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: addr.sellers[id], inputSchema: l.inputSchema, outputSchema: l.outputSchema,
      description: l.description, labels: l.labels || [],
      ...(PROBE[id] ? { probeQuery: PROBE[id] } : {}),
      ...(id === 'brief' || id === 'hollow' ? { probeBody: { countries: [{ name: 'India', quakes: [] }] } } : {}),
    };
    const r = await fetch(`${registry}/services`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    console.log(id.padEnd(10), r.status, j.status || j.error, j.unchanged ? '(unchanged)' : '', j.probe ? `probe=${j.probe.matches}` : '', j.detail || '');
  }
})().catch((e) => { console.error('seed failed:', e.message); process.exitCode = 1; });
