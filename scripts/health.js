// Pings every public URL every 30 s and prints a red line when one fails (S-59).
// Usage: node scripts/health.js [publicBase]   (default: PUBLIC_BASE_URL from .env)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const base = (process.argv[2] || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
if (!base) { console.error('set PUBLIC_BASE_URL or pass the URL'); process.exit(1); }
const paths = ['/api/health', '/registry/health', ...['atlas', 'tremor', 'brief', 'overquote', 'redirect', 'hollow', 'offline'].map((s) => `/${s}/health`)];
const once = async () => {
  const bad = [];
  await Promise.all(paths.map(async (p) => { try { const r = await fetch(base + p, { signal: AbortSignal.timeout(8000) }); if (!r.ok) bad.push(`${p} ${r.status}`); } catch (e) { bad.push(`${p} ${e.name}`); } }));
  const t = new Date().toLocaleTimeString();
  console.log(bad.length ? `\x1b[31m${t} DOWN: ${bad.join(', ')}\x1b[0m` : `\x1b[32m${t} all ${paths.length} endpoints healthy\x1b[0m`);
  return bad.length === 0;
};
if (process.argv.includes('--once')) once().then((ok) => process.exit(ok ? 0 : 1));
else { once(); setInterval(once, 30000); }
