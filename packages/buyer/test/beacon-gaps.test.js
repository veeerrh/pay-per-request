import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { closeAll, serve } from '../../sellers/test/helpers.js';
import { startSellers, testSigner } from './rig.js';

const require = createRequire(import.meta.url);
const g = require('@di06/guard');
const { createLlm, LlmBudget } = require('@di06/llm');
const { createBeacon } = require('../src/beacon.js');
const { runTask, runDirect } = require('../src/runner.js');
const { createServer } = require('../src/server.js');
const cfg = { ...g.loadConfig(path.join(__dirname, '..', '..', '..', 'config', 'rules.config.json')), requestTimeoutMs: 4000 };
const T1 = 'For the 3 most populous countries, find earthquakes of magnitude 4.5 or more from the last 7 days and write a short readiness brief for each.';

let world;
beforeAll(async () => { world = await startSellers(); });
afterAll(closeAll);

const chain = { balanceOf: async () => 20_000_000n, authorizationState: async () => false, blockNumber: async () => 200n, getTransfersFrom: async () => [], getReceiptStatus: async () => 'success' };
function rig(file = ':memory:') {
  const store = new g.Store(file, 'rs');
  const budget = new g.Budget(store, cfg);
  if (store.sessionStartBlock() === null) store.setSessionStartBlock(100);
  return { store, signer: testSigner(), budget, chain };
}
async function boot(r, beacon = createBeacon({})) {
  const services = async () => world.listings.map((l) => ({ id: l.id, name: l.name, category: l.category, price: String(l.price), payTo: l.payTo, endpoint: l.endpoint, status: 'active', description: 'd' }));
  const app = createServer({ ...r, cfg, listings: async () => world.listings, services, operatorToken: 'tok', allowPrivate: true, beacon, chatLimit: 100, taskLimit: 100 });
  return serve(app);
}
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function runViaApi(base) {
  const { taskId } = await (await post(base, '/api/tasks', { text: T1, budget: '50000' })).json();
  for (let i = 0; i < 300; i++) { const t = await (await fetch(`${base}/api/tasks/${taskId}`)).json(); if (t.status !== 'running') return { taskId, task: t }; await new Promise((x) => setTimeout(x, 100)); }
  throw new Error('timeout');
}

describe('Beacon small gaps (TC-AGENT-6)', () => {
  it('01 tasks and chat survive a Beacon restart', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'beacon-')), 'buyer.db');
    const a = await boot(rig(file));
    const { taskId } = await runViaApi(a);
    const before = await (await fetch(`${a}/api/tasks/${taskId}/chat`)).json();
    expect(before.messages.some((m) => m.kind === 'summary')).toBe(true);

    const b = await boot(rig(file)); // a new process over the same database file
    const list = await (await fetch(`${b}/api/tasks`)).json();
    expect(list.map((t) => t.id)).toContain(taskId);
    const after = await (await fetch(`${b}/api/tasks/${taskId}/chat`)).json();
    expect(after.messages.map((m) => m.text)).toEqual(before.messages.map((m) => m.text));
    const cost = await (await post(b, '/api/chat', { message: 'how much did it cost?', taskId })).json();
    expect(cost.reply).toContain('0.039');
    // a new task after the restart gets a fresh id
    const next = await runViaApi(b);
    expect(next.taskId).not.toBe(taskId);
  });

  it('02 a task that was running when Beacon stopped comes back as stopped, with its chat', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'beacon-')), 'buyer.db');
    const r = rig(file);
    r.store.db.exec('CREATE TABLE IF NOT EXISTS beacon_tasks(id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)');
    const saved = { id: 't7_abcdef', text: T1, budget: '50000', spent: '5000', reserved: '0', paidCalls: 1, status: 'running', stage: 'pay', startedAt: '2026-10-17T00:00:00.000Z', endedAt: null, services: [], notice: '', result: null, lastEventId: 3, params: null, choices: [], ledger: [], agentNotes: [], chat: [{ id: 1, role: 'beacon', kind: 'plan', text: 'I read your task as: x.', at: '2026-10-17T00:00:00.000Z' }] };
    r.store.db.prepare('INSERT INTO beacon_tasks(id, json, updated_at) VALUES (?,?,?)').run(saved.id, JSON.stringify(saved), '2026-10-17T00:00:01.000Z');
    const base = await boot(r);
    const t = await (await fetch(`${base}/api/tasks/t7_abcdef`)).json();
    expect(t.status).toBe('stopped');
    expect(t.notice).toContain('restarted');
    const chat = await (await fetch(`${base}/api/tasks/t7_abcdef/chat`)).json();
    expect(chat.messages[0].text).toContain('I read your task');
    const next = await runViaApi(base); // ids keep counting up
    expect(Number(next.taskId.match(/^t(\d+)_/)[1])).toBeGreaterThan(7);
  });

  it('03 questions about earlier tasks are answered; with no taskId the chat follows the newest task', async () => {
    const base = await boot(rig());
    const first = await runViaApi(base);
    const second = await runViaApi(base);
    const ans = await (await post(base, '/api/chat', { message: 'How did the previous task go?' })).json();
    expect(ans.taskId).toBe(second.taskId);
    expect(ans.reply).toContain(first.taskId);
    expect(ans.reply).toContain('completed');
  });

  it('04 direct-URL mode narrates in the chat and writes a summary', async () => {
    const r = rig();
    const atlas = world.listings.find((l) => l.id === 'atlas');
    const events = [];
    const out = await runDirect({ ...r, cfg, allowPrivate: true, beacon: createBeacon({}) },
      { taskId: 'td1', budget: 20000n, directUrl: { url: `${atlas.endpoint}?top=1`, expectedPrice: atlas.price, category: 'scraping', expectedPayTo: atlas.payTo } }, (e) => events.push(e));
    expect(out.status).toBe('completed');
    const chat = events.filter((e) => e.type === 'chat');
    expect(chat.map((c) => c.kind)).toEqual(expect.arrayContaining(['plan', 'paid', 'summary']));
    expect(chat[0].text).toContain('not choosing an agent');
    expect(out.result.beaconSummary.text).toContain('Direct purchase');
    expect(events.at(-1).type).toBe('done');
  });

  it('05 direct-URL mode says why it stopped when the price is wrong', async () => {
    const r = rig();
    const atlas = world.listings.find((l) => l.id === 'atlas');
    const events = [];
    const out = await runDirect({ ...r, cfg, allowPrivate: true, beacon: createBeacon({}) },
      { taskId: 'td2', budget: 20000n, directUrl: { url: `${atlas.endpoint}?top=1`, expectedPrice: 100n, category: 'scraping', expectedPayTo: atlas.payTo } }, (e) => events.push(e));
    expect(out.status).toBe('stopped');
    expect(events.some((e) => e.type === 'chat' && e.kind === 'refused')).toBe(true);
  });

  it('06 when our Gemini budget is full the chat says so once, and the task still completes rule-based', async () => {
    const llm = createLlm({ mock: () => { throw new LlmBudget('per-minute budget of 8 requests is full'); } });
    const r = rig();
    const events = [];
    const out = await runTask({ ...r, cfg, listings: async () => world.listings, beacon: createBeacon({ llm }) }, { taskId: 'tb1', text: T1, budget: 50000n, maxConcurrency: 3 }, (e) => events.push(e));
    expect(out.status).toBe('completed');
    const notices = events.filter((e) => e.type === 'chat' && e.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain('free request budget is full');
    expect(out.totals.spent).toBe(39000n);
  });

  it('07 a different failure is described differently, and answers carry the budget note', async () => {
    const down = createLlm({ mock: () => { throw new (require('@di06/llm').LlmUnavailable)('503'); } });
    const events = [];
    await runTask({ ...rig(), cfg, listings: async () => world.listings, beacon: createBeacon({ llm: down }) }, { taskId: 'tb2', text: T1, budget: 50000n, maxConcurrency: 3 }, (e) => events.push(e));
    expect(events.filter((e) => e.kind === 'notice')[0].text).toContain('not responding');

    const budgetOut = createLlm({ mock: ({ name }) => { if (name === 'answer') throw new LlmBudget('full'); return {}; } });
    const base = await boot(rig(), createBeacon({ llm: budgetOut }));
    // the task itself falls back too (plan needs JSON), which is fine for this check
    const { taskId } = await runViaApi(base);
    const ans = await (await post(base, '/api/chat', { message: 'why did you pick those agents?', taskId })).json();
    expect(ans.source).toBe('rules');
    expect(ans.reply).toContain('free request budget is full');
  });
});
