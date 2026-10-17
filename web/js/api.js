// The ONLY place the UI talks to the backend (Appendix B). Amounts are digit strings of units.
// Mock mode (?mock=1) swaps in canned data so the UI can be built before the backend is ready.
import { mock } from './api.mock.js';

export const MOCK = new URLSearchParams(location.search).get('mock') === '1';

export class ApiError extends Error {
  constructor(status, body, message) { super(message); this.status = status; this.body = body; }
}

async function call(method, path, body, headers = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  let res;
  try {
    res = await fetch(path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
  } catch {
    throw new ApiError(0, null, 'Cannot reach Beacon');
  } finally { clearTimeout(t); }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const msg = data?.issues?.[0]?.message || data?.detail || data?.error || `Request failed (${res.status})`;
    throw new ApiError(res.status, data, msg);
  }
  return data;
}

const live = {
  health: () => call('GET', '/api/health'),
  examples: () => call('GET', '/api/examples'),
  config: () => call('GET', '/api/config'),
  services: () => call('GET', '/api/services'),
  registerService: (listing) => call('POST', '/api/services', listing),
  wallet: () => call('GET', '/api/wallet'),
  tasks: () => call('GET', '/api/tasks'),
  task: (id) => call('GET', `/api/tasks/${encodeURIComponent(id)}`),
  createTask: (body) => call('POST', '/api/tasks', body),
  ledger: () => call('GET', '/api/ledger'),
  verify: () => call('GET', '/api/ledger/verify'),
  reconcile: () => call('POST', '/api/reconcile', {}),
  reputation: () => call('GET', '/api/reputation'),
  newSession: (token) => call('POST', '/api/session/new', {}, { 'x-operator-token': token }),
  attacks: () => call('GET', '/api/attack'),
  attack: (name, body = {}) => call('POST', `/api/attack/${encodeURIComponent(name)}`, body),
};

export const api = MOCK ? mock(live) : live;
