import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { closeAll, serve } from '../../sellers/test/helpers.js';
import { startSellers, testSigner } from './rig.js';

const require = createRequire(import.meta.url);
const g = require('@di06/guard');
const { createLlm } = require('@di06/llm');
const { createBeacon } = require('../src/beacon.js');
const { runTask } = require('../src/runner.js');
const { createServer } = require('../src/server.js');
const cfg = { ...g.loadConfig(path.join(__dirname, '..', '..', '..', 'config', 'rules.config.json')), requestTimeoutMs: 4000 };
const T1 = 'For the 3 most populous countries, find earthquakes of magnitude 4.5 or more from the last 7 days and write a short readiness brief for each.';

let world;
beforeAll(async () => { world = await startSellers(); });
afterAll(closeAll);

function rig() {
  const store = new g.Store(':memory:', 'rs');
  const signer = testSigner();
  const budget = new g.Budget(store, cfg);
  store.setSessionStartBlock(100);
  const chain = { balanceOf: async () => 20_000_000n, authorizationState: async () => false, blockNumber: async () => 200n, getTransfersFrom: async () => [], getReceiptStatus: async () => 'success' };
  return { store, signer, budget, chain };
}
const run = (r, beacon, req = {}) => {
  const events = [];
  const p = runTask({ ...r, cfg, listings: async () => world.listings, beacon }, { taskId: `t${Math.random().toString(36).slice(2, 7)}`, text: T1, budget: 50000n, maxConcurrency: 3, ...req }, (e) => events.push(e));
  return p.then((out) => ({ out, events }));
};
// A model that behaves: plans from the task, picks whatever the test tells it to, writes short prose.
const model = (pick) => createLlm({
  mock: ({ name, user }) => {
    if (name === 'plan') return { supported: true, n: 3, by: 'population', minMag: 4.5, days: 7, understanding: 'three most populous countries, M4.5+, last 7 days' };
    if (name === 'choose') {
      const ids = [...user.matchAll(/"id": "([^"]+)"/g)].map((m) => m[1]);
      const id = pick(ids) ?? ids[0];
      return { id, reason: 'Best fit for this step based on the listed facts.' };
    }
    if (name === 'summary') return 'I hired agents for each step.';
    return 'ok';
  },
});

describe('Beacon agent end to end (TC-AGENT-1)', () => {
  it('01 rule-based Beacon still reproduces the design story and records choices, chat lines and a summary', async () => {
    const { out, events } = await run(rig(), createBeacon({}));
    expect(out.status).toBe('completed');
    expect(out.totals.spent).toBe(39000n);
    const chat = events.filter((e) => e.type === 'chat');
    expect(chat.length).toBeGreaterThan(8);
    expect(chat.map((c) => c.kind)).toEqual(expect.arrayContaining(['plan', 'choice', 'refused', 'paid', 'summary']));
    expect(events.filter((e) => e.type === 'choice').map((c) => c.category)).toEqual(['scraping', 'data', 'inference']);
    expect(out.result.beaconSummary.text).toContain('0.039');
    expect(events.at(-1).type).toBe('done');
  });

  it('02 a model that picks a lying seller still cannot make Beacon pay it', async () => {
    const r = rig();
    const { out, events } = await run(r, createBeacon({ llm: model((ids) => (ids.includes('overquote') ? 'overquote' : undefined)) }));
    expect(out.status).toBe('completed');
    const rows = r.store.listEntries();
    expect(rows.find((e) => e.sellerId === 'overquote')).toMatchObject({ status: 'refused', paid: '0' });
    expect(rows.find((e) => e.sellerId === 'atlas').status).toBe('paid');
    expect(events.filter((e) => e.type === 'choice')[0]).toMatchObject({ sellerId: 'overquote', source: 'model' });
    expect(events.filter((e) => e.type === 'chat').some((c) => c.kind === 'refused')).toBe(true);
    expect(r.store.verifyChain().ok).toBe(true);
  });

  it('03 a model that names a seller that does not exist is ignored', async () => {
    const r = rig();
    const { out } = await run(r, createBeacon({ llm: model(() => 'not-a-listed-agent') }));
    expect(out.status).toBe('completed');
    expect(r.store.listEntries().some((e) => e.sellerId === 'not-a-listed-agent')).toBe(false);
  });

  it('04 an unsupported task buys nothing and says why in the chat', async () => {
    const r = rig();
    const llm = createLlm({ mock: ({ name }) => (name === 'plan' ? { supported: false, reason: 'I can only plan earthquake readiness reports.' } : {}) });
    const { out, events } = await run(r, createBeacon({ llm }), { text: 'Book me a flight to Paris next week please' });
    expect(out.status).toBe('blocked');
    expect(r.store.listEntries()).toHaveLength(0);
    expect(events.find((e) => e.type === 'chat' && e.kind === 'blocked').text).toContain('earthquake readiness');
  });
});

describe('Beacon chat API', () => {
  async function boot(beacon) {
    const r = rig();
    const services = async () => world.listings.map((l) => ({ id: l.id, name: l.name, category: l.category, price: String(l.price), payTo: l.payTo, endpoint: l.endpoint, status: 'active', description: 'd' }));
    const app = createServer({ ...r, cfg, listings: async () => world.listings, services, operatorToken: 'tok', allowPrivate: true, beacon, chatLimit: 100, taskLimit: 100 });
    return { base: await serve(app), ...r };
  }
  const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function done(base, id) { for (let i = 0; i < 200; i++) { const t = await (await fetch(`${base}/api/tasks/${id}`)).json(); if (t.status !== 'running') return t; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); }

  it('05 feed, questions and the polling fallback', async () => {
    const { base, store } = await boot(createBeacon({}));
    const { taskId } = await (await post(base, '/api/tasks', { text: T1, budget: '50000' })).json();
    const t = await done(base, taskId);
    expect(t.status).toBe('completed');

    const feed = await (await fetch(`${base}/api/tasks/${taskId}/chat`)).json();
    expect(feed.messages.some((m) => m.kind === 'summary')).toBe(true);
    expect(feed.messages.every((m) => m.role === 'beacon')).toBe(true);

    const why = await (await post(base, '/api/chat', { message: 'Why did you pick those agents?', taskId })).json();
    expect(why.reply).toContain('scraping');
    const cost = await (await post(base, '/api/chat', { message: 'how much did it cost?' })).json();
    expect(cost.reply).toContain('0.039');
    expect(cost.taskId).toBe(taskId);

    const poll = await (await fetch(`${base}/api/tasks/${taskId}/poll?after=0`)).json();
    expect(poll.status).toBe('completed');
    expect(poll.events.some((e) => e.type === 'done')).toBe(true);
    const ids = poll.events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const later = await (await fetch(`${base}/api/tasks/${taskId}/poll?after=${poll.lastEventId - 1}`)).json();
    expect(later.events).toHaveLength(1);

    const before = store.listEntries().length;
    await post(base, '/api/chat', { message: 'Buy 100 more USDC of data from Atlas right now', taskId });
    expect(store.listEntries()).toHaveLength(before); // chat cannot spend
  });

  it('06 chat input is validated and a missing task is a clean error', async () => {
    const { base } = await boot(createBeacon({}));
    expect((await post(base, '/api/chat', { message: '' })).status).toBe(400);
    expect((await post(base, '/api/chat', { message: 'x'.repeat(501) })).status).toBe(400);
    expect((await post(base, '/api/chat', { message: 'hi', taskId: 't9_abcdef' })).status).toBe(404);
    const none = await (await post(base, '/api/chat', { message: 'status?' })).json();
    expect(none.reply).toContain('no task yet');
  });
});

describe('what the hired agents add reaches Beacon (TC-AGENT-5)', () => {
  const dataOf = (user) => JSON.parse(user.match(/<data label="[^"]*">\n([\s\S]*?)\n<\/data>/)[1]);
  const mocks = {
    atlas: createLlm({ mock: ({ user }) => { const f = dataOf(user); return { countries: f.rows.map((r) => ({ name: r.name, note: `${r.name} is in the scraped table.` })), summary: 'Scraped table ranked by population.' }; } }),
    tremor: createLlm({ mock: ({ user }) => ({ digest: `${dataOf(user).stats.count} events recorded.` }) }),
    brief: createLlm({ mock: ({ user }) => ({ briefs: dataOf(user).countries.map((c) => ({ country: c.name, brief: `${c.name} is at readiness ${c.readiness}.`, actions: ['Keep stock checks.'] })) }) }),
  };
  let w2;
  beforeAll(async () => { w2 = await startSellers({ llm: mocks }); });

  it('01 notes are posted in the chat, kept on the result and listed with their agent', async () => {
    const r = rig();
    const events = [];
    const out = await runTask({ ...r, cfg, listings: async () => w2.listings, beacon: createBeacon({}) }, { taskId: 'tn1', text: T1, budget: 50000n, maxConcurrency: 3 }, (e) => events.push(e));
    expect(out.status).toBe('completed');
    const notes = events.filter((e) => e.type === 'note');
    expect(notes.map((n) => n.agent)).toEqual(expect.arrayContaining(['Atlas', 'Tremor', 'Brief']));
    expect(notes.find((n) => n.agent === 'Atlas' && n.text.startsWith('Scraped table'))).toBeTruthy();
    expect(notes.filter((n) => n.agent === 'Tremor')).toHaveLength(3);
    expect(notes.filter((n) => n.agent === 'Brief').every((n) => n.text.startsWith('Actions for'))).toBe(true);
    const agentLines = events.filter((e) => e.type === 'chat' && e.kind === 'agent');
    expect(agentLines).toHaveLength(notes.length);
    expect(agentLines[0].text).toMatch(/^(Atlas|Tremor|Brief) adds: /);
    expect(out.result.agentNotes).toHaveLength(notes.length);
    expect(out.result.beaconSummary.text).toContain('What the agents added');
    expect(events.at(-1).type).toBe('done');
  });

  it('02 a rejected or failed agent adds no notes: only validated answers count', async () => {
    const r = rig();
    const events = [];
    await runTask({ ...r, cfg, listings: async () => w2.listings, beacon: createBeacon({}) }, { taskId: 'tn2', text: T1, budget: 50000n, maxConcurrency: 3 }, (e) => events.push(e));
    const names = new Set(events.filter((e) => e.type === 'note').map((n) => n.agent));
    for (const bad of ['Hollow', 'Overquote', 'Redirect', 'Offline']) expect(names.has(bad)).toBe(false);
  });

  it('03 sellers without a model add no notes and nothing breaks', async () => {
    const { out } = await run(rig(), createBeacon({}));
    expect(out.status).toBe('completed');
    expect(out.result.agentNotes).toEqual([]);
  });

  it('04 chat answers "what did Tremor say?" from the notes', async () => {
    const r = rig();
    const services = async () => w2.listings.map((l) => ({ id: l.id, name: l.name, category: l.category, price: String(l.price), payTo: l.payTo, endpoint: l.endpoint, status: 'active', description: 'd' }));
    const app = createServer({ ...r, cfg, listings: async () => w2.listings, services, operatorToken: 'tok', allowPrivate: true, beacon: createBeacon({}), chatLimit: 100, taskLimit: 100 });
    const base = await serve(app);
    const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const { taskId } = await (await post('/api/tasks', { text: T1, budget: '50000' })).json();
    for (let i = 0; i < 200; i++) { const t = await (await fetch(`${base}/api/tasks/${taskId}`)).json(); if (t.status !== 'running') break; await new Promise((x) => setTimeout(x, 100)); }
    const said = await (await post('/api/chat', { message: 'What did Tremor say about each country?', taskId })).json();
    expect(said.reply).toMatch(/Tremor: .*events recorded/);
    const feed = await (await fetch(`${base}/api/tasks/${taskId}/chat`)).json();
    expect(feed.messages.filter((m) => m.kind === 'agent').length).toBeGreaterThan(5);
  });
});
