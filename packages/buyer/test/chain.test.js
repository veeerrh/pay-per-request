import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { closeAll, serve } from '../../sellers/test/helpers.js';
import { startSellers, testSigner } from './rig.js';

const require = createRequire(import.meta.url);
const g = require('@di06/guard');
const { createBeacon } = require('../src/beacon.js');
const { createServer } = require('../src/server.js');
const { createHirer } = require('../../sellers/src/relay.js');
const addresses = require('../../../config/addresses.json');
const cfg = { ...g.loadConfig(path.join(__dirname, '..', '..', '..', 'config', 'rules.config.json')), requestTimeoutMs: 4000 };
const T1 = 'For the 3 most populous countries, find earthquakes of magnitude 4.5 or more from the last 7 days and write a short readiness brief for each.';

let world;
beforeAll(async () => { world = await startSellers(); });
afterAll(closeAll);

const chain = { balanceOf: async () => 20_000_000n, authorizationState: async () => false, blockNumber: async () => 200n, getTransfersFrom: async () => [], getReceiptStatus: async () => 'success' };
async function boot(w = world, listingsFilter = (l) => l) {
  const store = new g.Store(':memory:', 'rs');
  const budget = new g.Budget(store, cfg);
  store.setSessionStartBlock(100);
  const listings = async () => listingsFilter(w.listings);
  const services = async () => (await listings()).map((l) => ({ id: l.id, name: l.name, category: l.category, price: String(l.price), payTo: l.payTo, endpoint: l.endpoint, status: 'active', description: 'd' }));
  const app = createServer({ store, budget, signer: testSigner(), chain, cfg, listings, services, operatorToken: 'tok', allowPrivate: true, beacon: createBeacon({}), chatLimit: 100, taskLimit: 100 });
  return { base: await serve(app), store };
}
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getJson = async (base, p) => (await fetch(`${base}${p}`)).json();
async function run(base, body) {
  const r = await post(base, '/api/tasks', { text: T1, budget: '50000', ...body });
  const { taskId } = await r.json();
  for (let i = 0; i < 300; i++) { const t = await getJson(base, `/api/tasks/${taskId}`); if (t.status !== 'running') return { taskId, task: t }; await new Promise((x) => setTimeout(x, 100)); }
  throw new Error('timeout');
}

describe('agent chain: Relay hires Tremor itself (opt-in)', () => {
  it('01 without the option Relay is never a candidate and nothing changes', async () => {
    const { base, store } = await boot();
    const before = world.hits.relay;
    const { task } = await run(base, {});
    expect(task.status).toBe('completed');
    expect(world.hits.relay).toBe(before);
    expect(store.listEntries().some((e) => e.sellerId === 'relay')).toBe(false);
    expect(task.chain).toBe(false);
  });

  it('02 with the option Beacon pays Atlas and Relay only; Relay buys the data; the result is complete with a chain receipt', async () => {
    const { base, store } = await boot();
    const { taskId, task } = await run(base, { chain: true });
    expect(task.status).toBe('completed');
    expect(task.chain).toBe(true);
    const rows = store.listEntries().filter((e) => e.taskId === taskId);
    expect(rows.some((e) => e.sellerId === 'tremor')).toBe(false); // Beacon never bought data itself
    const relay = rows.filter((e) => e.sellerId === 'relay' && e.status === 'paid');
    expect(relay.map((e) => e.paid).sort()).toEqual(['10000', '6000']); // metered: two countries, then one
    expect(task.spent).toBe('21000'); // Atlas 5000 + Relay 10000 + 6000 (the data and the briefs, bought once)
    expect(task.result.complete).toBe(true);
    expect(task.result.chain).toMatchObject({ agent: 'Relay', spentUnits: '6000' });
    expect(task.result.chain.hired).toHaveLength(3);
    expect(task.result.chain.hired[0].txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(task.result.evidence.some((e) => /earthquake\(s\) of magnitude/.test(e))).toBe(true); // data came back through Relay
    const chat = (await getJson(base, `/api/tasks/${taskId}/chat`)).messages.map((m) => m.text).join(' ');
    expect(chat).toContain('hire Relay');
    expect(chat).toContain('Hired Tremor for');
    const ev = (await getJson(base, `/api/tasks/${taskId}/poll?after=0`)).events.filter((e) => e.type === 'chain');
    expect(ev).toHaveLength(3);
  });

  it('03 the option without a listed Relay stops before buying anything', async () => {
    const { base, store } = await boot(world, (ls) => ls.filter((l) => l.id !== 'relay'));
    const { taskId, task } = await run(base, { chain: true });
    expect(task.status).toBe('blocked');
    expect(task.notice).toMatch(/Relay is not listed/);
    expect(store.listEntries().filter((e) => e.taskId === taskId)).toHaveLength(0);
  });

  it('04 an impostor called relay with another payee address is not accepted as the chained agent', async () => {
    const { base } = await boot(world, (ls) => ls.map((l) => (l.id === 'relay' ? { ...l, payTo: addresses.sellers.redirect } : l)));
    const { task } = await run(base, { chain: true });
    expect(task.status).toBe('blocked');
  });

  it('05 if Relay fails, Beacon is not charged for it and says so', async () => {
    const w = await startSellers({ relayHire: async () => { throw new Error('Tremor refused'); } });
    const { base, store } = await boot(w);
    const { taskId, task } = await run(base, { chain: true });
    expect(task.status).toBe('stopped');
    const rows = store.listEntries().filter((e) => e.taskId === taskId && e.sellerId === 'relay');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => e.paid === '0' && e.status === 'failed')).toBe(true);
    expect(task.spent).toBe('5000'); // only Atlas
  });

  it('06 data Relay reports that fails Beacon\'s own plausibility check is not used as evidence', async () => {
    const w = await startSellers({ relayHire: async (country) => ({ seller: 'Tremor', paid: 2000n, txHash: `0x${'cd'.repeat(32)}`, data: { country, quakes: [{ magnitude: 2.0, place: 'x', time: new Date().toISOString() }] } }) }); // below the requested M4.5
    const { base } = await boot(w);
    const { task } = await run(base, { chain: true });
    expect(task.status).toBe('completed');
    expect(task.result.evidence.some((e) => /earthquake\(s\) of magnitude/.test(e))).toBe(false);
  });
});

describe('Relay hires through the same payment guard Beacon uses', () => {
  const tremor = () => {
    const l = world.listings.find((x) => x.id === 'tremor');
    return async () => ({ id: 'tremor', name: 'Tremor', category: 'data', price: l.price, payTo: l.payTo, endpoint: l.endpoint, listingHash: l.listingHash, outputSchema: l.outputSchema });
  };
  function rig(tremorListing) {
    const store = new g.Store(':memory:', 'rl');
    store.setSessionStartBlock(100);
    const budget = new g.Budget(store, cfg);
    const hire = createHirer({ store, budget, signer: testSigner(), cfg, chain, log: () => undefined, tremorListing });
    return { store, budget, hire };
  }

  it('07 an honest purchase settles and is recorded in Relay\'s own ledger', async () => {
    const r = rig(tremor());
    const out = await r.hire('India', { days: 7, minMag: 4.5, taskId: 'relay-a' });
    expect(out.paid).toBe(2000n);
    expect(out.txHash).toMatch(/^0x/);
    expect(out.data.country).toBe('India');
    expect(r.store.listEntries().find((e) => e.sellerId === 'tremor')).toMatchObject({ status: 'paid', source: 'relay' });
  });

  it('07b one buyer request with two countries opens its spending cap once and buys both (regression)', async () => {
    const r = rig(tremor());
    const a = await r.hire('India', { days: 7, minMag: 4.5, taskId: 'relay-two' });
    const b = await r.hire('China', { days: 7, minMag: 4.5, taskId: 'relay-two' });
    expect([a.paid, b.paid]).toEqual([2000n, 2000n]);
    expect(r.budget.totals('relay-two').spent).toBe(4000n);
  });

  it('07c a failed purchase (authorisation unused, nothing charged) is repeated once; a second failure is reported', async () => {
    const mk = (failures) => {
      let n = 0;
      const base = rig(tremor());
      const flaky = async (url, init) => { const paidReq = !!new Headers(init?.headers).get('payment-signature'); if (paidReq && n++ < failures) return new Response('upstream hiccup', { status: 500 }); return fetch(url, init); };
      return { ...base, hire: createHirer({ store: base.store, budget: base.budget, signer: testSigner(), cfg, chain, log: () => undefined, tremorListing: tremor(), fetch: flaky }) };
    };
    const once = mk(1);
    const ok = await once.hire('India', { days: 7, minMag: 4.5, taskId: 'relay-retry' });
    expect(ok.paid).toBe(2000n);
    expect(once.store.listEntries().map((e) => e.status)).toEqual(['failed', 'paid']); // one failed attempt (not charged), then the paid one
    const twice = mk(2);
    await expect(twice.hire('India', { days: 7, minMag: 4.5, taskId: 'relay-retry2' })).rejects.toThrow(/failed/);
    expect(twice.store.listEntries().every((e) => e.paid === '0')).toBe(true);
  });

  it('08 a price lie by the seller Relay hires is refused before anything is signed', async () => {
    const base = await tremor()();
    const r = rig(async () => ({ ...base, price: 1000n })); // listing says 1000, Tremor really asks 2000
    await expect(r.hire('India', { days: 7, minMag: 4.5, taskId: 'relay-b' })).rejects.toThrow(/M-17/);
    expect(r.store.listEntries()[0]).toMatchObject({ status: 'refused', paid: '0' });
  });

  it('09 a payee mismatch is refused too', async () => {
    const base = await tremor()();
    const r = rig(async () => ({ ...base, payTo: addresses.sellers.redirect }));
    await expect(r.hire('India', { days: 7, minMag: 4.5, taskId: 'relay-c' })).rejects.toThrow(/S-06/);
  });
});
