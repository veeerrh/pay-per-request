import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { closeAll, serve } from '../../sellers/test/helpers.js';
import { startSellers, testSigner } from './rig.js';

const require = createRequire(import.meta.url);
const g = require('@di06/guard');
const { createServer } = require('../src/server.js');
const cfg = { ...g.loadConfig(path.join(__dirname, '..', '..', '..', 'config', 'rules.config.json')), requestTimeoutMs: 4000 };
const TOKEN = 'test-operator-token-123';
const T1 = 'For the 3 most populous countries, find earthquakes of magnitude 4.5 or more from the last 7 days and write a short readiness brief for each.';

let world;
beforeAll(async () => { world = await startSellers(); });
afterAll(closeAll);

async function boot(opts = {}) {
  const store = new g.Store(':memory:', 'rs');
  const signer = testSigner();
  const budget = new g.Budget(store, cfg);
  store.setSessionStartBlock(100);
  const chain = { balanceOf: async () => 20_000_000n, authorizationState: async () => false, blockNumber: async () => 200n, getTransfersFrom: async () => [], getReceiptStatus: async () => 'success' };
  const services = async () => world.listings.map((l) => ({ id: l.id, name: l.name, category: l.category, price: String(l.price), payTo: l.payTo, endpoint: l.endpoint, status: 'active', description: 'd' }));
  const app = createServer({ store, budget, signer, chain, cfg, listings: async () => world.listings, services, operatorToken: TOKEN, allowPrivate: true, ...opts });
  const base = await serve(app);
  return { base, store, signer, app };
}
const post = (base, p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function until(fn, ms = 20000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } }
async function sse(base, id, headers = {}) {
  const r = await fetch(`${base}/api/tasks/${id}/events`, { headers });
  const text = await r.text(); // the stream ends when the task is finished
  return text.split('\n\n').filter((b) => b.startsWith('id:')).map((b) => ({ id: Number(b.match(/^id: (\d+)/)[1]), ...JSON.parse(b.match(/data: (.*)/)[1]) }));
}

describe('Beacon API (TC-6.3)', () => {
  it('01 read endpoints return the contract shapes', async () => {
    const { base, signer } = await boot();
    expect((await (await fetch(`${base}/api/health`)).json())).toMatchObject({ ok: true, spendingHalted: false });
    expect((await (await fetch(`${base}/api/examples`)).json())).toHaveLength(3);
    const cfgRes = await (await fetch(`${base}/api/config`)).json();
    expect(cfgRes).toMatchObject({ network: 'eip155:84532', rules: { fallbackLimit: 3 } });
    expect(cfgRes.ruleSetHash).toHaveLength(64);
    const w = await (await fetch(`${base}/api/wallet`)).json();
    expect(w).toMatchObject({ address: signer.address, usdcBalance: '20000000', network: 'eip155:84532' });
    expect(JSON.stringify(w)).not.toMatch(/0x[0-9a-fA-F]{64}/); // never a key (TC-6.3-12)
    expect((await (await fetch(`${base}/api/services`)).json())).toHaveLength(8);
    expect((await (await fetch(`${base}/api/ledger/verify`)).json())).toMatchObject({ ok: true });
    expect(await (await fetch(`${base}/api/ledger`)).json()).toEqual([]);
    expect(await (await fetch(`${base}/api/reputation`)).json()).toEqual([]);
  });

  it('02 a task runs end to end; SSE order, resume and ledger agree', async () => {
    const { base } = await boot();
    const r = await post(base, '/api/tasks', { text: T1, budget: '50000', maxConcurrency: 3 });
    expect(r.status).toBe(202);
    const { taskId } = await r.json();
    const done = await until(async () => { const s = await (await fetch(`${base}/api/tasks/${taskId}`)).json(); return s.status !== 'running' && s; });
    expect(done.status).toBe('completed');
    expect(done.spent).toBe('35000'); // Atlas 5000, three Tremor 6000, Brief metered: 10000 for two countries and 6000 for one
    const events = await sse(base, taskId);
    expect(events.filter((e) => e.type === 'stage').map((e) => e.stage)).toEqual(['plan', 'discover', 'pay', 'execute', 'validate', 'combine']);
    expect(events.at(-1).type).toBe('done'); // done is the last event: the stream ends there
    expect(events.some((e) => e.type === 'done')).toBe(true);
    const ledger = await (await fetch(`${base}/api/ledger`)).json();
    expect(events.filter((e) => e.type === 'ledger')).toHaveLength(ledger.length);
    expect(ledger.find((e) => e.status === 'refused').buyer).toBe('Scout');
    const resumed = await sse(base, taskId, { 'last-event-id': String(events.length - 3) });
    expect(resumed.map((e) => e.id)).toEqual(events.slice(-3).map((e) => e.id)); // missed events replayed, no duplicates
    expect((await (await fetch(`${base}/api/tasks`)).json())[0].id).toBe(taskId);
    expect((await (await fetch(`${base}/api/reputation`)).json()).length).toBeGreaterThan(3);
  });

  it('03 invalid input is rejected with no reservation', async () => {
    const { base, store } = await boot({ taskLimit: 100 });
    const bad = [
      { text: '', budget: '50000' }, { text: 'short', budget: '50000' }, { text: T1, budget: '-1' }, { text: T1, budget: 'abc' }, { text: T1, budget: '0' },
      { text: T1, budget: '99999999999' }, { text: T1, budget: '' }, { text: T1, budget: '50000', maxConcurrency: 9 }, { text: T1, budget: '50000', hired: ['nobody'] },
      { budget: '50000', directUrl: { url: 'http://insecure.example.com/x', expectedPrice: '1000', category: 'data' } },
      { budget: '50000', directUrl: { url: 'https://x.example.com/x', expectedPrice: '999999', category: 'data' } },
    ];
    const strict = (await boot({ allowPrivate: false, taskLimit: 100 })).base;
    for (const b of bad) {
      const r = await post(b.directUrl ? strict : base, '/api/tasks', b);
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
    expect(store.listEntries()).toHaveLength(0);
    expect((await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })).status).toBe(400);
  });

  it('05 a closed client does not stop the task', async () => {
    const { base } = await boot();
    const { taskId } = await (await post(base, '/api/tasks', { text: T1, budget: '50000' })).json();
    const ac = new AbortController();
    fetch(`${base}/api/tasks/${taskId}/events`, { signal: ac.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    const done = await until(async () => { const s = await (await fetch(`${base}/api/tasks/${taskId}`)).json(); return s.status !== 'running' && s; });
    expect(done.status).toBe('completed');
  });

  it('06 rate limit answers 429 before any reservation (S-80)', async () => {
    const { base } = await boot({ taskLimit: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await post(base, '/api/tasks', { text: 'short', budget: '50000' })).status);
    expect(codes).toEqual([400, 400, 429]);
  });

  it('07 operator token guards New session (authorization)', async () => {
    const { base, store } = await boot();
    const old = store.sessionId;
    expect((await post(base, '/api/session/new', {})).status).toBe(401);
    expect((await post(base, '/api/session/new', {}, { 'x-operator-token': 'wrong' })).status).toBe(401);
    expect(store.sessionId).toBe(old);
    const ok = await post(base, '/api/session/new', {}, { 'x-operator-token': TOKEN });
    expect(ok.status).toBe(200);
    expect(store.sessionId).not.toBe(old);
    expect(store.verifyChain(old).ok).toBe(true); // old session stays verifiable
  });

  it('08 direct URL mode: pays an honest seller, refuses a price lie (T-08b, S-89)', async () => {
    const { base } = await boot();
    const honest = await (await post(base, '/api/tasks', { budget: '20000', directUrl: { url: `${world.bases.atlas}/countries?top=1`, expectedPrice: '5000', category: 'scraping' } })).json();
    const d1 = await until(async () => { const s = await (await fetch(`${base}/api/tasks/${honest.taskId}`)).json(); return s.status !== 'running' && s; });
    expect(d1.status).toBe('completed');
    expect(d1.spent).toBe('5000');
    const liar = await (await post(base, '/api/tasks', { budget: '20000', directUrl: { url: `${world.bases.overquote}/countries?top=1`, expectedPrice: '2000', category: 'scraping' } })).json();
    const d2 = await until(async () => { const s = await (await fetch(`${base}/api/tasks/${liar.taskId}`)).json(); return s.status !== 'running' && s; });
    expect(d2.status).toBe('stopped');
    expect(d2.spent).toBe('0');
    expect(d2.result.breakdown[0]).toMatchObject({ outcome: 'refused', ruleId: 'M-17' });
  });

  it('10 static serving is safe and headers are hardened', async () => {
    const { base } = await boot();
    const raw = (p) => new Promise((resolve) => { const u = new URL(base); http.get({ host: u.hostname, port: u.port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); });
    for (const p of ['/../.env', '/..%2f.env', '/%2e%2e/package.json', '/web/../package.json', '/.env']) {
      const r = await raw(p);
      expect(r.status, p).toBe(404);
      expect(r.body).not.toContain('PRIVATE_KEY');
    }
    const h = await fetch(`${base}/api/health`);
    expect(h.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(h.headers.get('x-powered-by')).toBeNull();
    const err = await fetch(`${base}/api/nope`);
    expect(err.status).toBe(404);
    expect(await err.text()).not.toContain('at ');
  });

  it('13 a broken ledger halts spending and refuses new tasks (S-84)', async () => {
    const { base, store } = await boot();
    await post(base, '/api/tasks', { text: T1, budget: '50000' }).then((r) => r.json());
    await until(async () => (await (await fetch(`${base}/api/tasks`)).json())[0].status !== 'running');
    store.db.exec('DROP TRIGGER ledger_no_update');
    store.db.prepare("UPDATE ledger_events SET payload='{}' WHERE seq=2").run();
    const v = await (await fetch(`${base}/api/ledger/verify`)).json();
    expect(v.ok).toBe(false);
    const r = await post(base, '/api/tasks', { text: T1, budget: '50000' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('spending_halted');
  });
});
