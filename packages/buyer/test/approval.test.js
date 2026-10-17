import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { closeAll, serve } from '../../sellers/test/helpers.js';
import { startSellers, testSigner } from './rig.js';

const require = createRequire(import.meta.url);
const g = require('@di06/guard');
const { createBeacon } = require('../src/beacon.js');
const { createServer } = require('../src/server.js');
const { createApprovals } = require('../src/approvals.js');
const cfg = { ...g.loadConfig(path.join(__dirname, '..', '..', '..', 'config', 'rules.config.json')), requestTimeoutMs: 4000 };
const T1 = 'For the 3 most populous countries, find earthquakes of magnitude 4.5 or more from the last 7 days and write a short readiness brief for each.';

let world;
beforeAll(async () => { world = await startSellers(); });
afterAll(closeAll);

const chain = { balanceOf: async () => 20_000_000n, authorizationState: async () => false, blockNumber: async () => 200n, getTransfersFrom: async () => [], getReceiptStatus: async () => 'success' };
async function boot(approvalTimeoutMs = 60_000) {
  const store = new g.Store(':memory:', 'rs');
  const budget = new g.Budget(store, cfg);
  store.setSessionStartBlock(100);
  const services = async () => world.listings.map((l) => ({ id: l.id, name: l.name, category: l.category, price: String(l.price), payTo: l.payTo, endpoint: l.endpoint, status: 'active', description: 'd' }));
  const app = createServer({ store, budget, signer: testSigner(), chain, cfg, listings: async () => world.listings, services, operatorToken: 'tok', allowPrivate: true, beacon: createBeacon({}), chatLimit: 100, taskLimit: 100, approvalTimeoutMs });
  return { base: await serve(app), store };
}
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getJson = async (base, p) => (await fetch(`${base}${p}`)).json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function pendingApproval(base, taskId, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const j = await getJson(base, `/api/tasks/${taskId}/poll?after=0`);
    const byId = new Map();
    for (const e of j.events.filter((x) => x.type === 'approval')) byId.set(e.approvalId, e); // the last event per request wins
    const p = [...byId.values()].find((e) => e.status === 'pending');
    if (p) return p;
    if (j.status !== 'running') return null;
    await wait(50);
  }
  throw new Error('no approval request appeared');
}
async function finished(base, taskId) {
  for (let i = 0; i < 300; i++) { const t = await getJson(base, `/api/tasks/${taskId}`); if (t.status !== 'running') return t; await wait(100); }
  throw new Error('task did not finish');
}

describe('approvals module (M-23, M-57)', () => {
  it('01 approve and decline resolve once; a second answer is refused', async () => {
    const ap = createApprovals({ timeoutMs: 5000 });
    const seen = [];
    const p = ap.request('t1', { sellerId: 'brief', seller: 'Brief', category: 'inference', priceUnits: 10000n, thresholdUnits: 8000n }, (e) => seen.push(e));
    const id = seen[0].approvalId;
    expect(seen[0]).toMatchObject({ type: 'approval', status: 'pending', seller: 'Brief', priceUnits: '10000', thresholdUnits: '8000' });
    expect(ap.list('t1')).toHaveLength(1);
    expect(ap.decide('t1', id, 'approve')).toEqual({ ok: true });
    expect(await p).toBe('approved');
    expect(ap.decide('t1', id, 'decline').ok).toBe(false);
    expect(seen.map((e) => e.status)).toEqual(['pending', 'approved']);
    expect(ap.list('t1')).toHaveLength(0);
  });
  it('02 no answer in time counts as a decline (expired)', async () => {
    const ap = createApprovals({ timeoutMs: 40 });
    const seen = [];
    expect(await ap.request('t1', { sellerId: 'x', seller: 'X', category: 'data', priceUnits: 2, thresholdUnits: 1 }, (e) => seen.push(e))).toBe('expired');
    expect(seen.at(-1).status).toBe('expired');
    expect(ap.decide('t1', seen[0].approvalId, 'approve').ok).toBe(false); // too late
  });
  it('03 answers for another task, unknown ids and bad decisions are refused', async () => {
    const ap = createApprovals({ timeoutMs: 5000 });
    const seen = [];
    const p = ap.request('t1', { sellerId: 'x', seller: 'X', category: 'data', priceUnits: 2, thresholdUnits: 1 }, (e) => seen.push(e));
    expect(ap.decide('t2', seen[0].approvalId, 'approve').ok).toBe(false);
    expect(ap.decide('t1', 'a999', 'approve').ok).toBe(false);
    expect(ap.decide('t1', seen[0].approvalId, 'maybe').ok).toBe(false);
    ap.cancelTask('t1');
    expect(await p).toBe('declined');
  });
});

describe('approval above a limit, end to end', () => {
  it('04 no limit set: no approval is ever requested', async () => {
    const { base } = await boot();
    const { taskId } = await (await post(base, '/api/tasks', { text: T1, budget: '50000' })).json();
    const t = await finished(base, taskId);
    expect(t.status).toBe('completed');
    const j = await getJson(base, `/api/tasks/${taskId}/poll?after=0`);
    expect(j.events.some((e) => e.type === 'approval')).toBe(false);
  });

  it('05 a limit above every price changes nothing', async () => {
    const { base } = await boot();
    const { taskId } = await (await post(base, '/api/tasks', { text: T1, budget: '50000', approveAbove: '10000' })).json();
    const t = await finished(base, taskId);
    expect(t.status).toBe('completed');
    expect(t.approveAbove).toBe('10000');
    expect((await getJson(base, `/api/tasks/${taskId}/poll?after=0`)).events.some((e) => e.type === 'approval')).toBe(false);
  });

  it('06 approve: only the call above the limit waits, and the task completes with the same spend as without a limit', async () => {
    const { base } = await boot();
    const { taskId } = await (await post(base, '/api/tasks', { text: T1, budget: '50000', approveAbove: '8000' })).json();
    const p = await pendingApproval(base, taskId);
    expect(p).toMatchObject({ seller: 'Brief', category: 'inference', priceUnits: '10000', thresholdUnits: '8000' });
    // while it waits, nothing is reserved for Brief and no Brief call has been made
    const waiting = world.hits.brief;
    await wait(300);
    expect(world.hits.brief).toBe(waiting);
    expect((await post(base, `/api/tasks/${taskId}/approvals/${p.approvalId}`, { decision: 'approve' })).status).toBe(200);
    const t = await finished(base, taskId);
    expect(t.status).toBe('completed');
    expect(t.spent).toBe('39000'); // the same spend as a run without a limit (see beacon-gaps)
    const j = await getJson(base, `/api/tasks/${taskId}/poll?after=0`);
    expect(j.events.filter((e) => e.type === 'approval').map((e) => e.status)).toEqual(['pending', 'approved']); // asked once for the seller, not once per call
    const chat = (await getJson(base, `/api/tasks/${taskId}/chat`)).messages.map((m) => m.text).join('\n');
    expect(chat).toContain('above your approval limit');
    expect(chat).toContain('Approved: I will hire Brief');
  });

  it('07 decline: Brief is never contacted, nothing is paid for it, and the task says why it stopped', async () => {
    const { base, store } = await boot();
    const { taskId } = await (await post(base, '/api/tasks', { text: T1, budget: '50000', approveAbove: '8000' })).json();
    const p = await pendingApproval(base, taskId);
    const before = world.hits.brief;
    expect((await post(base, `/api/tasks/${taskId}/approvals/${p.approvalId}`, { decision: 'decline' })).status).toBe(200);
    const t = await finished(base, taskId);
    expect(world.hits.brief).toBe(before); // never contacted: no probe, no signature
    const rows = store.listEntries().filter((e) => e.taskId === taskId);
    expect(rows.some((e) => e.sellerId === 'brief')).toBe(false); // declined by policy: no call, no ledger row, no reputation effect
    // Declining skips that seller only: the step falls back to the cheaper eligible seller (M-57), which here is the junk seller Hollow.
    expect(rows.some((e) => e.sellerId === 'hollow' && e.status === 'rejected')).toBe(true);
    expect(t.status).toBe('stopped'); // no valid brief was produced
    const chat = (await getJson(base, `/api/tasks/${taskId}/chat`)).messages.map((m) => m.text).join('\n');
    expect(chat).toContain('Not approved: you declined');
  });

  it('08 no answer: the request expires, counts as a decline, and the task stops', async () => {
    const { base } = await boot(300);
    const { taskId } = await (await post(base, '/api/tasks', { text: T1, budget: '50000', approveAbove: '8000' })).json();
    const t = await finished(base, taskId);
    expect(t.status).toBe('stopped');
    const j = await getJson(base, `/api/tasks/${taskId}/poll?after=0`);
    expect(j.events.filter((e) => e.type === 'approval').map((e) => e.status)).toEqual(['pending', 'expired']);
    const chat = (await getJson(base, `/api/tasks/${taskId}/chat`)).messages.map((m) => m.text).join(' ');
    expect(chat).toContain('no answer within');
  });

  it('09 limits are validated, and answering a request that does not exist is refused', async () => {
    const { base } = await boot();
    for (const bad of ['0', '100001', 'abc', '-5']) {
      const r = await post(base, '/api/tasks', { text: T1, budget: '50000', approveAbove: bad });
      expect(r.status).toBe(400);
    }
    const { taskId } = await (await post(base, '/api/tasks', { text: T1, budget: '50000' })).json();
    expect((await post(base, `/api/tasks/${taskId}/approvals/a1`, { decision: 'approve' })).status).toBe(409);
    expect((await post(base, '/api/tasks/nope/approvals/a1', { decision: 'approve' })).status).toBe(404);
    await finished(base, taskId);
  });
});
