// Public host for the judges: the registry and every seller in ONE process behind ONE https URL (built for a free Render web service,
// 512 MB). It holds no wallet key: Beacon, the buyer, is not part of this process and runs on the operator's machine.
//   /registry/...  registry      /atlas, /tremor, /brief  real sellers      /overquote, /redirect, /hollow, /offline  test vendors
// Same paths the local gateway uses, so listings and the reference buyer work unchanged.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');

const ROOT = path.join(__dirname, '..');
// Defence in depth: this process must never be given a key that can move money.
for (const k of ['BEACON_PRIVATE_KEY', 'REPLAY_PRIVATE_KEY', 'OPERATOR_TOKEN', 'PRIVATE_KEY']) {
  if (process.env[k]) { console.error(`REFUSING TO START: ${k} is set. The public host never holds a wallet key or the operator token.`); process.exit(1); }
}
if ((process.env.NETWORK || 'eip155:84532') !== 'eip155:84532' || (process.env.CHAIN_ID || '84532') !== '84532') { console.error('REFUSING TO START: not Base Sepolia'); process.exit(1); }
process.env.DEMO_MODE = 'true';
process.env.ALLOW_PRIVATE_ENDPOINTS = 'false';
const BASE = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (!/^https:\/\/[^/]+$/.test(BASE)) { console.error('REFUSING TO START: set PUBLIC_BASE_URL to the public https URL (Render sets RENDER_EXTERNAL_URL itself).'); process.exit(1); }
process.env.PUBLIC_BASE_URL = BASE;
const PORT = Number(process.env.PORT || 10000);

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const { createRegistry } = require('../packages/registry/src/server');
const registry = createRegistry({ dbPath: path.join(ROOT, 'data', 'registry.db'), allowPrivate: false, demoMode: true });

const MOUNTS = {
  registry,
  atlas: require('../packages/sellers/src/atlas').app,
  tremor: require('../packages/sellers/src/tremor').app,
  brief: require('../packages/sellers/src/brief').app,
  overquote: require('../packages/sellers/src/fixtures/overquote').app,
  redirect: require('../packages/sellers/src/fixtures/redirect').app,
  hollow: require('../packages/sellers/src/fixtures/hollow').app,
  offline: require('../packages/sellers/src/fixtures/offline').app,
};

const host = express();
host.disable('x-powered-by');
host.set('trust proxy', 1); // Render terminates TLS; the seller sees the original https host
const startedAt = Date.now();
host.get('/gateway/health', (_req, res) => res.json({ ok: true, routes: Object.keys(MOUNTS), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));
for (const [prefix, app] of Object.entries(MOUNTS)) host.use(`/${prefix}`, app);
host.get('/', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><title>AgentMarket public host</title><h1>AgentMarket: registry and sellers</h1><p>Testnet only (Base Sepolia).</p><ul><li><a href="/registry/">Registry</a> (<a href="/registry/services">JSON</a>)</li><li><a href="/gateway/health">Health</a></li></ul>`));
host.use((_req, res) => res.status(404).json({ error: 'not_found' }));

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e && e.message));
const server = host.listen(PORT, '0.0.0.0', () => {
  console.log(`public host on :${PORT} as ${BASE} (${Object.keys(MOUNTS).join(', ')})`);
  seed(1);
});
server.keepAliveTimeout = 65000; // longer than the proxy's idle timeout, so connections are not cut mid-request

/** Registers the listings with the public URL. Idempotent; retried because the public URL needs a moment before the probe can reach it. */
function seed(attempt) {
  setTimeout(() => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'seed-registry.js'), `http://127.0.0.1:${PORT}/registry`, BASE], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => { if (code !== 0 && attempt < 4) seed(attempt + 1); else console.log(code === 0 ? 'registry seeded' : 'registry seeding failed; restart to retry'); });
  }, attempt === 1 ? 4000 : 8000);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
