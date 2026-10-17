import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { closeAll, serve } from '../../sellers/test/helpers.js';
import { startSellers, testSigner } from './rig.js';

const require = createRequire(import.meta.url);
const g = require('@di06/guard');
const { createLlm, LlmBudget } = require('@di06/llm');
const { createBeacon, factsFromLab } = require('../src/beacon.js');
const { createServer } = require('../src/server.js');
const { install } = require('../src/attacks.js');
const { ROSTER, ORDER, adjustReconcile } = require('../src/lab.js');
const { createShapeshifter, MODES } = require('../../sellers/src/fixtures/shapeshifter.js');
const cfg = { ...g.loadConfig(path.join(__dirname, '..', '..', '..', 'config', 'rules.config.json')), requestTimeoutMs: 4000 };

let world;
let shapeBase;
beforeAll(async () => {
  world = await startSellers();
  shapeBase = await serve(createShapeshifter({ requiredBy: null, payTo: '0x5342137a225C44721d8c08f28EeA31f82925e874' }));
});
afterAll(closeAll);

/** A buyer signer that counts how many payments it was ever asked to sign. */
function countingSigner() {
  const s = testSigner();
  const out = { ...s, calls: 0, signPayment: async (pr) => { out.calls++; return s.signPayment(pr); } };
  return out;
}

async function boot(beacon = createBeacon({}), over = {}) {
  const store = new g.Store(':memory:', 'rs');
  const signer = countingSigner();
  const replaySigner = testSigner();
  const budget = new g.Budget(store, cfg);
  store.setSessionStartBlock(100);
  const atlas = world.listings.find((l) => l.id === 'atlas');
  const chain = {
    balanceOf: async () => 20_000_000n, authorizationState: async () => false, blockNumber: async () => 200n, getReceiptStatus: async () => 'success',
    getTransfersFrom: async (addr) => (String(addr).toLowerCase() === replaySigner.address.toLowerCase() ? [{ to: atlas.payTo }, { to: atlas.payTo }] : []),
  };
  const services = async () => world.listings.map((l) => ({ id: l.id, name: l.name, category: l.category, price: String(l.price), payTo: l.payTo, endpoint: l.endpoint, status: 'active', description: 'd' }));
  const app = createServer({ store, budget, signer, chain, cfg, listings: async () => world.listings, services, operatorToken: 'tok', allowPrivate: true, beacon,
    extend: install, replaySigner, attackLimit: 100, chatLimit: 100, taskLimit: 100, labEndpoints: { shapeshifter: shapeBase }, reconcileRetry: { times: 1, delayMs: 0 }, ...over });
  return { base: await serve(app), store, signer, replaySigner };
}
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function finish(base, taskId) {
  for (let i = 0; i < 400; i++) { const t = await (await fetch(`${base}/api/tasks/${taskId}`)).json(); if (t.status !== 'running') return t; await new Promise((x) => setTimeout(x, 100)); }
  throw new Error('lab did not finish');
}

describe('Fraud Lab (TC-LAB-1)', () => {
  it('01 the roster lists the suspects in order with their tactic, layer and cost', async () => {
    const { base } = await boot();
    const j = await (await fetch(`${base}/api/lab`)).json();
    expect(j.order).toEqual(ORDER);
    expect(j.agents.map((a) => a.id)).toEqual(['overquote', 'redirect', 'shapeshifter', 'hollow', 'offline', 'control', 'replay']);
    expect(j.agents.find((a) => a.id === 'shapeshifter').subs.map((s) => s.mode)).toEqual(Object.keys(MODES));
    for (const a of j.agents) { expect(a.tactic).toBeTruthy(); expect(a.layer).toBeTruthy(); expect(a.cost).toBeTruthy(); }
    expect(ROSTER.find((r) => r.id === 'control').honest).toBe(true);
  });

  it('02 Beacon tries every suspect one at a time and explains each outcome in the chat', async () => {
    const { base, store, signer } = await boot();
    const { taskId } = await (await post(base, '/api/lab/run', {})).json();
    const t = await finish(base, taskId);
    expect(t.status).toBe('completed');
    expect(t.kind).toBe('lab');

    const steps = t.result.steps;
    const by = (id) => steps.filter((s) => s.id === id);
    expect(by('overquote')[0]).toMatchObject({ outcome: 'blocked', ruleId: 'M-17', paid: '0' });
    expect(by('redirect')[0]).toMatchObject({ outcome: 'blocked', ruleId: 'S-06', paid: '0' });
    expect(by('shapeshifter')).toHaveLength(6);
    expect(by('shapeshifter').every((s) => s.outcome === 'blocked' && s.paid === '0')).toBe(true);
    expect(new Set(by('shapeshifter').map((s) => s.reason)).size).toBe(6); // six different reasons, one per changed term
    expect(by('hollow')[0]).toMatchObject({ outcome: 'rejected', paid: '8000' });
    expect(by('offline')[0]).toMatchObject({ outcome: 'failed', paid: '0' });
    expect(by('control')[0]).toMatchObject({ outcome: 'paid', paid: '5000' });
    expect(by('replay')[0].outcome).toBe('blocked');

    // nothing was signed for the 8 refused attempts. Three authorizations exist: the junk seller and the control (both settled) and
    // the offline seller (its request looked honest, so Beacon signed, but the seller never settled it and no money moved).
    expect(signer.calls).toBe(3);
    expect(store.listEntries().filter((e) => e.source === 'lab' || e.status === 'refused').filter((e) => e.status === 'refused').every((e) => e.paid === '0')).toBe(true);
    expect(store.verifyChain().ok).toBe(true);

    expect(t.result.scoreboard).toMatchObject({ blockedBeforeSigning: 8, paidThenRejected: 1, failedNotCharged: 1, controlPaid: true, junkPaidUsdc: '0.008', spentUsdc: '0.013' });
    expect(t.result.verification.chainOk).toBe(true);
  });

  it('03 the chat reports, in order: plan, one select per suspect, an alert for what went wrong, and a closing incident report', async () => {
    const { base } = await boot();
    const { taskId } = await (await post(base, '/api/lab/run', {})).json();
    await finish(base, taskId);
    const { messages } = await (await fetch(`${base}/api/tasks/${taskId}/chat`)).json();
    const kinds = messages.map((m) => m.kind);
    expect(kinds[0]).toBe('plan');
    expect(kinds.filter((k) => k === 'select')).toHaveLength(12); // 11 purchases (Shapeshifter counts six) + the replay
    expect(kinds.at(-1)).toBe('incident');
    const alerts = messages.filter((m) => m.kind === 'alert');
    expect(alerts.length).toBeGreaterThanOrEqual(11);
    expect(alerts.every((a) => ['blocked', 'warn'].includes(a.severity))).toBe(true);

    const text = (re) => messages.find((m) => re.test(m.text))?.text ?? '';
    const price = text(/Blocked before signing: Overquote/);
    expect(price).toContain('It listed 0.002 USDC but its payment request asked for 0.020 USDC');
    expect(price).toContain('Rule M-17');
    expect(price).toContain('Nothing was signed and nothing was paid');
    expect(price).toContain('would have signed a payment of 0.020 USDC');
    expect(price).toContain('I did not hire Overquote');
    expect(price).toMatch(/reputation score went from [\d.]+ to [\d.]+/);
    expect(text(/Blocked before signing: Redirect/)).toContain('different recipient');
    expect(text(/Blocked before signing: Shapeshifter, look-alike token/)).toContain('different token');
    expect(text(/Blocked before signing: Shapeshifter, Base mainnet/)).toContain('no mainnet path');
    expect(text(/Paid, then rejected: Hollow/)).toContain('cannot be taken back');
    expect(text(/did not deliver and I was not charged/)).toContain('expires unused');
    expect(text(/^Control:/)).toContain('Legitimate buying still works');
    expect(text(/^Replay blocked/)).toContain('One signed authorization unlocks one response');
    expect(messages.at(-1).text).toContain('Fraud Lab report');
    expect(messages.at(-1).text).toContain('Not covered');
  });

  it('04 steps are streamed as events with claim-versus-reality, reputation change and replay lanes', async () => {
    const { base } = await boot();
    const { taskId } = await (await post(base, '/api/lab/run', { cases: ['overquote', 'replay'] })).json();
    await finish(base, taskId);
    const poll = await (await fetch(`${base}/api/tasks/${taskId}/poll?after=0`)).json();
    const steps = poll.events.filter((e) => e.type === 'lab_step');
    expect(steps.map((s) => `${s.key}:${s.status}`)).toEqual(['overquote:running', 'overquote:done', 'replay:running', 'replay:done']);
    const done = steps.find((s) => s.key === 'overquote' && s.status === 'done');
    expect(done.diffs).toEqual([{ field: 'price', listed: '0.002', actual: '0.020' }]);
    expect(done.reputation.after).toBeLessThan(done.reputation.before);
    expect(done.wouldHavePaidUsdc).toBe('0.020');
    const replay = steps.find((s) => s.key === 'replay' && s.status === 'done');
    expect(replay.lanes).toHaveLength(5);
    expect(replay.lanes.filter((l) => l.status === 200)).toHaveLength(1);
    expect(replay.lanes.filter((l) => l.status === 409).length).toBe(4);
    expect(poll.events.at(-1).type).toBe('done');
    const snap = await (await fetch(`${base}/api/tasks/${taskId}`)).json();
    expect(snap.labSteps.length).toBe(2);
  });

  it('05 a run can be limited to chosen suspects and cannot overlap another lab run', async () => {
    const { base } = await boot();
    const first = await post(base, '/api/lab/run', { cases: ['hollow'] });
    const { taskId } = await first.json();
    const second = await post(base, '/api/lab/run', { cases: ['overquote'] });
    expect(second.status).toBe(409);
    const t = await finish(base, taskId);
    expect(t.result.steps.map((s) => s.id)).toEqual(['hollow']);
    expect((await post(base, '/api/lab/run', { cases: ['nope'] })).status).toBe(400);
    expect((await post(base, '/api/lab/run', { budget: '5' })).status).toBe(400);
  });

  it('06 when the replay wallet is unfunded Beacon says so and uses its own wallet, outside the purchase ledger', async () => {
    const poor = { balanceOf: async (a) => (String(a).toLowerCase() === 'poor' ? 0n : 20_000_000n) };
    const { base, replaySigner } = await boot(createBeacon({}), {});
    void poor; void replaySigner;
    // a replay signer that reports no funds: its address maps to zero balance
    const store = new g.Store(':memory:', 'rs');
    const signer = countingSigner();
    const rs = testSigner();
    const atlas = world.listings.find((l) => l.id === 'atlas');
    const chain = { balanceOf: async (a) => (String(a).toLowerCase() === rs.address.toLowerCase() ? 0n : 20_000_000n), authorizationState: async () => false, blockNumber: async () => 200n, getReceiptStatus: async () => 'success', getTransfersFrom: async () => [{ to: atlas.payTo }, { to: atlas.payTo }] };
    const budget = new g.Budget(store, cfg);
    store.setSessionStartBlock(100);
    const app = createServer({ store, budget, signer, chain, cfg, listings: async () => world.listings, services: async () => [], operatorToken: 'tok', allowPrivate: true, beacon: createBeacon({}), extend: install, replaySigner: rs, attackLimit: 100, labEndpoints: { shapeshifter: shapeBase }, reconcileRetry: { times: 1, delayMs: 0 } });
    const b2 = await serve(app);
    const { taskId } = await (await post(b2, '/api/lab/run', { cases: ['replay'] })).json();
    const t = await finish(b2, taskId);
    const chat = (await (await fetch(`${b2}/api/tasks/${taskId}/chat`)).json()).messages;
    expect(chat.some((m) => m.kind === 'notice' && m.text.includes("Beacon's own wallet"))).toBe(true);
    expect(t.result.replay.usedBeaconWallet).toBe(true);
  });

  it('06b replay-test transfers from the Beacon wallet are excluded from reconciliation by hash; anything else still counts', () => {
    const rec = { status: 'differences', ledgerTotal: 13000n, chainTotal: 23000n, differences: [
      { status: 'chain_only', txHash: '0xAAA', chainAmount: 5000n }, { status: 'chain_only', txHash: '0xbbb', chainAmount: 5000n }] };
    expect(adjustReconcile(rec, ['0xaaa', '0xBBB'])).toMatchObject({ status: 'matched', chainTotal: 13000n, differences: 0, excludedReplayTransfers: 2 });
    const stray = { ...rec, differences: [...rec.differences, { status: 'chain_only', txHash: '0xccc', chainAmount: 1n }] };
    expect(adjustReconcile(stray, ['0xaaa', '0xbbb'])).toMatchObject({ status: 'differences', differences: 1, excludedReplayTransfers: 2 });
    expect(adjustReconcile({ ...rec, differences: [{ status: 'ledger_only', txHash: '0xaaa', chainAmount: 0n }] }, ['0xaaa'])).toMatchObject({ status: 'differences', excludedReplayTransfers: 0 });
  });

  it('07 a missing suspect is skipped with a note, and the rest still run', async () => {
    const { base } = await boot(createBeacon({}), { labEndpoints: { shapeshifter: 'http://127.0.0.1:1' } });
    const { taskId } = await (await post(base, '/api/lab/run', { cases: ['shapeshifter', 'redirect'] })).json();
    const t = await finish(base, taskId);
    expect(t.result.steps.map((s) => s.id)).toEqual(['redirect']);
    const chat = (await (await fetch(`${base}/api/tasks/${taskId}/chat`)).json()).messages;
    expect(chat.some((m) => m.kind === 'notice' && m.text.includes('Shapeshifter is not running'))).toBe(true);
  });

  it('09 a transient 402 on a good payment is retried with a fresh signature and reported as not a replay', async () => {
    const atlas = world.listings.find((l) => l.id === 'atlas');
    const proxy = express();
    let failed = 0;
    proxy.get('/countries', async (req, res) => {
      if (req.headers['payment-signature'] && failed < 1) { failed++; return res.status(402).json({ error: 'transient' }); }
      const r = await fetch(`${atlas.endpoint}?${new URLSearchParams(req.query)}`, { headers: req.headers['payment-signature'] ? { 'payment-signature': req.headers['payment-signature'] } : {} });
      r.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) res.setHeader(k, v); });
      res.status(r.status).send(Buffer.from(await r.arrayBuffer()));
    });
    const proxyBase = await serve(proxy);
    const listings = world.listings.map((l) => (l.id === 'atlas' ? { ...l, endpoint: `${proxyBase}/countries` } : l));
    const { base } = await boot(createBeacon({}), { listings: async () => listings });
    const { taskId } = await (await post(base, '/api/lab/run', { cases: ['replay'] })).json();
    const t = await finish(base, taskId);
    expect(failed).toBe(1);
    expect(t.result.replay.retries).toEqual({ first: 1, parallel: 0 });
    expect(t.result.replay).toMatchObject({ stage1: 200, winners: 1, pass: true });
    const chat = (await (await fetch(`${base}/api/tasks/${taskId}/chat`)).json()).messages;
    expect(chat.some((m) => m.kind === 'notice' && m.text.includes('transient error, not a replay'))).toBe(true);
    expect(chat.some((m) => m.kind === 'alert' && m.text.startsWith('Replay blocked'))).toBe(true);
  });

  it('08 the closing report may be written by the model only if its numbers come from the facts; otherwise the template is used', async () => {
    const facts = factsFromLab({
      results: [{ id: 'overquote', suspect: 'Overquote', outcome: 'blocked', ruleId: 'M-17', reason: 'asked 10 times', paid: '0', wouldHavePaid: '20000' }, { id: 'hollow', suspect: 'Hollow', outcome: 'rejected', ruleId: 'M-24', reason: 'bad schema', paid: '8000' }],
      totals: { spent: 8000n }, verification: { chainOk: true, reconcile: { status: 'matched', ledgerTotal: 8000n, chainTotal: 8000n } }, replay: null, cfg,
    });
    const good = await createBeacon({ llm: createLlm({ mock: () => 'Overquote was refused (M-17). Hollow took 0.008 USDC and was rejected. Spent 0.008 USDC in total.' }) }).labReport(facts);
    expect(good.source).toBe('model');
    const bad = await createBeacon({ llm: createLlm({ mock: () => 'I lost 0.777 USDC.' }) }).labReport(facts);
    expect(bad.source).toBe('rules');
    const vague = await createBeacon({ llm: createLlm({ mock: () => 'Everything was stopped and nothing important was lost.' }) }).labReport(facts);
    expect(vague.source).toBe('rules'); // a report that leaves out the spend figure is not used
    expect(bad.text).toContain('Fraud Lab report');
    const budgetOut = await createBeacon({ llm: createLlm({ mock: () => { throw new LlmBudget('full'); } }) }).labReport(facts);
    expect(budgetOut).toMatchObject({ source: 'rules', fallback: 'budget' });
  });
});
