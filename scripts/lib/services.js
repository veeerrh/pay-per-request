// Service table and the environment allowlist for each child process (M-71, T-09).
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const addresses = require(path.join(ROOT, 'config', 'addresses.json'));

// Variables every child needs just to run on Windows or Linux. No secrets here.
const BASE = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'NODE_ENV', 'NETWORK', 'CHAIN_ID', 'USDC_ADDRESS', 'RPC_URL', 'FACILITATOR_URL', 'PUBLIC_BASE_URL', 'DEMO_MODE', 'ALLOW_PRIVATE_ENDPOINTS'];

const seller = (name, port, file, payToKey = name) => ({ name, port, script: `packages/sellers/src/${file}`, env: { PORT: String(port), PAY_TO: addresses.sellers[payToKey] }, allow: BASE });

const SERVICES = [
  seller('atlas', 4011, 'atlas.js'),
  seller('tremor', 4012, 'tremor.js'),
  seller('brief', 4013, 'brief.js'),
  seller('overquote', 4021, 'fixtures/overquote.js'),
  seller('redirect', 4022, 'fixtures/redirect.js'),
  seller('hollow', 4023, 'fixtures/hollow.js'),
  seller('offline', 4024, 'fixtures/offline.js'),
  // Added in later milestones: the registry holds no key; Beacon is the only process that receives one.
  { name: 'registry', port: 4000, script: 'packages/registry/src/server.js', env: { PORT: '4000' }, allow: BASE, optional: true },
  { name: 'beacon', port: 4100, script: 'packages/buyer/src/server.js', env: { PORT: '4100' }, allow: [...BASE, 'BEACON_PRIVATE_KEY', 'OPERATOR_TOKEN', 'ENABLE_ATTACK_PANEL', 'MAX_TASK_BUDGET', 'LEDGER_WRITERS', 'REPLAY_PRIVATE_KEY', 'LOG_RANGE', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODELS', 'BEACON_LLM'], optional: true },
  { name: 'gateway', port: 8080, script: 'packages/gateway/src/gateway.js', env: { PORT: '8080' }, allow: BASE, optional: true },
];

/** The exact environment a child gets: its own variables plus an allowlist from the parent. Never ...process.env. */
function buildEnv(service, parent = process.env) {
  const env = {};
  for (const k of service.allow) if (parent[k] !== undefined) env[k] = parent[k];
  return { ...env, ...service.env };
}

module.exports = { SERVICES, buildEnv, ROOT };
