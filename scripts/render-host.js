// Public host for the judges, built for ONE free Render web service (512 MB) behind ONE https URL.
//   /registry/...  registry      /atlas, /tremor, /brief  real sellers      /overquote, /redirect, /hollow, /offline  test vendors
//   everything else: Beacon's dashboard and API (full mode), or a small landing page (sellers-only mode)
// Same paths the local gateway uses, so listings and the reference buyer work unchanged.
//
// Two modes, chosen by the environment:
//   sellers-only: no wallet key anywhere. The process REFUSES to start if one is set. Beacon runs elsewhere.
//   full:         RENDER_FULL=true. Beacon (the buyer, with the testnet wallet key and the operator token) runs as a separate child
//                 process on a loopback port. The host process itself never keeps those secrets: they are moved out of its
//                 environment before any seller code runs, so seller code can never read a wallet key.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const FULL = process.env.RENDER_FULL === 'true';
const SECRET_NAMES = ['BEACON_PRIVATE_KEY', 'REPLAY_PRIVATE_KEY', 'OPERATOR_TOKEN', 'PRIVATE_KEY', 'GEMINI_API_KEY', 'BEACON_GEMINI_API_KEY'];

if (!FULL) {
  for (const k of ['BEACON_PRIVATE_KEY', 'REPLAY_PRIVATE_KEY', 'OPERATOR_TOKEN', 'PRIVATE_KEY']) {
    if (process.env[k]) { console.error(`REFUSING TO START: ${k} is set. Sellers-only mode never holds a wallet key or the operator token (set RENDER_FULL=true to run Beacon here).`); process.exit(1); }
  }
}
// Take the secrets out of this process's environment right away (full mode hands them only to Beacon).
const secrets = {};
for (const k of Object.keys(process.env)) { if (SECRET_NAMES.includes(k) || /PRIVATE_KEY/.test(k)) { secrets[k] = process.env[k]; delete process.env[k]; } }
if (FULL && (!secrets.BEACON_PRIVATE_KEY || !secrets.OPERATOR_TOKEN)) { console.error('REFUSING TO START: full mode needs BEACON_PRIVATE_KEY and OPERATOR_TOKEN (set them as Render secrets).'); process.exit(1); }

if ((process.env.NETWORK || 'eip155:84532') !== 'eip155:84532' || (process.env.CHAIN_ID || '84532') !== '84532') { console.error('REFUSING TO START: not Base Sepolia'); process.exit(1); }
process.env.DEMO_MODE = 'true';
process.env.ALLOW_PRIVATE_ENDPOINTS = 'false';
const BASE = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (!/^https:\/\/[^/]+$/.test(BASE)) { console.error('REFUSING TO START: set PUBLIC_BASE_URL to the public https URL (Render sets RENDER_EXTERNAL_URL itself).'); process.exit(1); }
process.env.PUBLIC_BASE_URL = BASE;
const PORT = Number(process.env.PORT || 10000);
const BEACON_PORT = 4100;

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
let beaconUp = false;
host.get('/gateway/health', (_req, res) => res.json({ ok: true, mode: FULL ? 'full' : 'sellers-only', routes: Object.keys(MOUNTS), ...(FULL ? { beacon: beaconUp } : {}), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));
for (const [prefix, app] of Object.entries(MOUNTS)) host.use(`/${prefix}`, app);

if (FULL) {
  // Everything that is not a seller or the registry goes to Beacon (dashboard, /api, live events), through the same proxy as the local gateway.
  const { createGateway } = require('../packages/gateway/src/gateway');
  const toBeacon = createGateway({ routes: {}, beacon: BEACON_PORT });
  host.use((req, res) => toBeacon(req, res));
} else {
  host.get('/', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><title>AgentMarket public host</title><h1>AgentMarket: registry and sellers</h1><p>Testnet only (Base Sepolia).</p><ul><li><a href="/registry/">Registry</a> (<a href="/registry/services">JSON</a>)</li><li><a href="/gateway/health">Health</a></li></ul>`));
  host.use((_req, res) => res.status(404).json({ error: 'not_found' }));
}

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e && e.message));
const server = host.listen(PORT, '0.0.0.0', () => {
  console.log(`public host on :${PORT} as ${BASE} (${FULL ? 'full: ' : 'sellers-only: '}${Object.keys(MOUNTS).join(', ')})`);
  if (FULL) {
    // The Fraud Lab's lab-only vendor stays private: loopback only, never routed through the public URL.
    require('../packages/sellers/src/fixtures/shapeshifter').app.listen(4025, '127.0.0.1');
    startBeacon(0);
  }
  seed(1);
});
server.keepAliveTimeout = 65000; // longer than the proxy's idle timeout, so connections are not cut mid-request

/** Beacon as a child process with only the environment it needs (the same allowlist the local launcher uses). Restarted if it dies. */
let stopping = false;
function startBeacon(restarts) {
  const { SERVICES, buildEnv } = require('./lib/services');
  const svc = SERVICES.find((s) => s.name === 'beacon');
  const parent = { ...process.env, ...secrets, REGISTRY_URL: `http://127.0.0.1:${PORT}/registry`, BEACON_LOCAL_ROUTES: 'false', ENABLE_ATTACK_PANEL: process.env.ENABLE_ATTACK_PANEL || 'true' };
  const env = buildEnv({ ...svc, allow: [...svc.allow, 'REGISTRY_URL', 'BEACON_LOCAL_ROUTES'], env: { PORT: String(BEACON_PORT) } }, parent);
  const child = spawn(process.execPath, [path.join(ROOT, svc.script)], { cwd: ROOT, env, stdio: 'inherit' });
  const probe = setInterval(async () => { try { beaconUp = (await fetch(`http://127.0.0.1:${BEACON_PORT}/api/config`)).ok; } catch { beaconUp = false; } }, 3000);
  child.on('exit', (code) => {
    clearInterval(probe); beaconUp = false;
    console.error(`Beacon exited (${code})`);
    if (!stopping && restarts < 5) setTimeout(() => startBeacon(restarts + 1), 3000);
  });
  process.on('exit', () => { try { child.kill(); } catch { /* already gone */ } });
}

/** Registers the listings with the public URL. Idempotent; retried because the public URL needs a moment before the probe can reach it. */
function seed(attempt) {
  setTimeout(() => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'seed-registry.js'), `http://127.0.0.1:${PORT}/registry`, BASE], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => { if (code !== 0 && attempt < 4) seed(attempt + 1); else console.log(code === 0 ? 'registry seeded' : 'registry seeding failed; restart to retry'); });
  }, attempt === 1 ? 4000 : 8000);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; server.close(() => process.exit(0)); });
