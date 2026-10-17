// One command to start everything: npm run start. Sellers get no private key. Logs go to logs/<name>.log.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { SERVICES, buildEnv, ROOT } = require('./lib/services');

const only = process.argv.includes('--sellers') ? new Set(SERVICES.filter((s) => /^(atlas|tremor|brief|overquote|redirect|hollow|offline|shapeshifter)$/.test(s.name)).map((s) => s.name)) : null;

// --public: demo mode for the judging run. Needs PUBLIC_BASE_URL (the tunnel URL) and refuses private endpoints (D-29).
const PUBLIC = process.argv.includes('--public');
if (PUBLIC) {
  process.env.DEMO_MODE = 'true';
  process.env.ALLOW_PRIVATE_ENDPOINTS = 'false';
  if (!/^https:\/\/[^/]+$/.test((process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''))) { console.error('REFUSING TO START: set PUBLIC_BASE_URL to the https tunnel URL first (npm run tunnel).'); process.exit(1); }
  process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
}

// Startup network guard: refuse to run if anything is not Base Sepolia (M-40, S-56).
const NET = { NETWORK: process.env.NETWORK || 'eip155:84532', CHAIN_ID: process.env.CHAIN_ID || '84532' };
if (NET.NETWORK !== 'eip155:84532' || NET.CHAIN_ID !== '84532') { console.error('REFUSING TO START: not Base Sepolia'); process.exit(1); }
if (process.env.DEMO_MODE === 'true' && process.env.ALLOW_PRIVATE_ENDPOINTS === 'true') { console.error('REFUSING TO START: ALLOW_PRIVATE_ENDPOINTS must be false in demo mode'); process.exit(1); }

// A port is in use if anything accepts a connection on it (binding alone is unreliable on Windows dual-stack).
const inUse = (port, host) => new Promise((resolve) => {
  const c = net.connect({ port, host, timeout: 400 });
  c.once('connect', () => { c.destroy(); resolve(true); });
  c.once('timeout', () => { c.destroy(); resolve(false); });
  c.once('error', () => resolve(false));
});
const portFree = async (port) => !(await inUse(port, '127.0.0.1')) && !(await inUse(port, '::1'));

(async () => {
  const list = SERVICES.filter((s) => (!only || only.has(s.name)) && (!s.optional || fs.existsSync(path.join(ROOT, s.script))));
  for (const s of list) if (!(await portFree(s.port))) { console.error(`REFUSING TO START: port ${s.port} (${s.name}) is already in use. Nothing was started.`); process.exit(1); }
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  const children = [];
  for (const s of list) {
    const log = fs.openSync(path.join(ROOT, 'logs', `${s.name}.log`), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, s.script)], { cwd: ROOT, env: buildEnv(s), stdio: ['ignore', log, log] });
    child.on('exit', (code) => console.log(`${s.name} exited (${code})`));
    children.push(child);
    console.log(`started ${s.name.padEnd(10)} :${s.port}`);
  }
  const stopAll = () => { children.forEach((c) => { try { c.kill(); } catch { /* already gone */ } }); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', stopAll); process.on('SIGTERM', stopAll);
  console.log('\nAll services up. Press Ctrl+C to stop.');
  if (!only) {
    // Register the seven listings (idempotent). In public mode the listings carry the public tunnel URL.
    await new Promise((r) => setTimeout(r, 4000));
    const base = PUBLIC ? process.env.PUBLIC_BASE_URL : 'http://localhost';
    const seed = spawn(process.execPath, [path.join(ROOT, 'scripts', 'seed-registry.js'), 'http://localhost:4000', base], { cwd: ROOT, stdio: 'inherit' });
    seed.on('exit', () => console.log(PUBLIC ? `\nPublic URL: ${process.env.PUBLIC_BASE_URL}   (dashboard at /, registry at /registry/services)` : '\nDashboard: http://localhost:4100   (everything through one door: http://localhost:8080)'));
  }
})();
