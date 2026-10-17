import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { Store, Budget, FakeSigner, loadConfig, recoverPending, startGuard, pay, USDC_ADDRESS, type ChainReader } from '../src';
import { startFakeSeller, SELLER_PAYTO } from './helpers/fakeSeller';

const cfg = { ...loadConfig(join(__dirname, '..', '..', '..', 'config', 'rules.config.json')), requestTimeoutMs: 300 };
const ME = '0xADb43a17Cb94d4125f45522d815060B58A71dcCb';
const NOW = 1_000_000;
const NONCE = '0x' + '11'.repeat(32);
const LISTING = { price: 1000n, payTo: SELLER_PAYTO, network: 'eip155:84532', asset: USDC_ADDRESS };

function world() {
  const store = new Store(':memory:', 'rs');
  const budget = new Budget(store, cfg);
  budget.openTask('t1', 20000n);
  return { store, budget };
}
type World = ReturnType<typeof world>;

/** A purchase that was signed and sent, then the process "crashed". */
function crashed(w: World, id: string, validBefore: number, nonce: string | null = NONCE) {
  const r = w.budget.reserve({ taskId: 't1', requestId: id, sellerId: 's', category: 'data', amount: 5000n });
  expect(r.ok).toBe(true);
  w.store.appendEvent({ requestId: id, taskId: 't1', eventType: 'intent', payload: { seller: 'S', sellerId: 's', category: 'data', listed: '5000', asked: '5000', paid: '0', status: 'pending' } });
  w.store.createIntent({ requestId: id, taskId: 't1', sellerId: 's', amount: 5000n });
  if (nonce) {
    w.store.setIntentState(id, 'sent', { nonce, validBefore });
    w.store.appendEvent({ requestId: id, taskId: 't1', eventType: 'signed', payload: { nonce, validBefore } });
  }
}
const chainWith = (used: boolean, hash?: string): ChainReader => ({
  authorizationState: async () => used,
  findAuthorizationUse: async () => (hash ? { txHash: hash } : null),
});
const rec = (w: World, chain: ChainReader) => recoverPending({ ...w, chain, signerAddress: ME, nowSeconds: () => NOW });
const payReq = (id: string, url: string) => ({
  requestId: id, taskId: 't1', seller: { id: 's', name: 'S', category: 'data' }, listing: LISTING, listingHash: 'h', url,
});

describe('crash recovery (TC-2.5)', () => {
  it('01 used nonce becomes paid and commits the reservation', async () => {
    const w = world();
    crashed(w, 'r1', NOW + 30);
    const out = await rec(w, chainWith(true, '0x' + 'cd'.repeat(32)));
    expect(out[0]).toMatchObject({ outcome: 'paid' });
    expect(w.store.listEntries()[0]).toMatchObject({ status: 'paid', txHash: '0x' + 'cd'.repeat(32) });
    expect(w.budget.totals('t1')).toMatchObject({ spent: 5000n, reserved: 0n });
    expect(w.store.verifyChain().ok).toBe(true);
  });
  it('02 unused and expired becomes failed and releases', async () => {
    const w = world();
    crashed(w, 'r1', NOW - 5);
    expect((await rec(w, chainWith(false)))[0].outcome).toBe('failed');
    expect(w.store.listEntries()[0].status).toBe('failed');
    expect(w.budget.totals('t1')).toMatchObject({ spent: 0n, reserved: 0n });
  });
  it('03 unused but still valid stays held; retrying the same request id is refused', async () => {
    const w = world();
    crashed(w, 'r1', NOW + 30);
    expect((await rec(w, chainWith(false)))[0].outcome).toBe('held');
    expect(w.store.listEntries()[0].status).toBe('pending');
    expect(w.budget.totals('t1').reserved).toBe(5000n);
    const s = await startFakeSeller('honest');
    const signer = new FakeSigner();
    try {
      const r = await pay({ store: w.store, budget: w.budget, signer, cfg }, payReq('r1', s.url));
      expect(r.status).toBe('refused');
      expect(signer.calls).toHaveLength(0);
    } finally {
      await s.close();
    }
  });
  it('04 chain read error changes nothing', async () => {
    const w = world();
    crashed(w, 'r1', NOW - 5);
    const out = await rec(w, { authorizationState: async () => { throw new Error('rpc down'); } });
    expect(out[0].outcome).toBe('error');
    expect(w.store.listEntries()[0].status).toBe('pending');
    expect(w.budget.totals('t1').reserved).toBe(5000n);
  });
  it('05 broken ledger at startup halts spending', async () => {
    const w = world();
    crashed(w, 'r1', NOW + 30);
    w.store.db.exec('DROP TRIGGER ledger_no_update');
    w.store.db.prepare("UPDATE ledger_events SET payload='{}' WHERE seq=2").run();
    const g = await startGuard({ ...w, chain: chainWith(false), signerAddress: ME });
    expect(g.spendingHalted).toBe(true);
    expect(g.reason).toContain('broken');
    const r = await pay({ store: w.store, budget: w.budget, signer: new FakeSigner(), cfg, halted: () => g.spendingHalted }, payReq('x', 'http://127.0.0.1:1/x'));
    expect(r).toMatchObject({ status: 'refused', verdict: 'STOP_TASK', ruleId: 'M-62' });
  });
  it('06 late settle: held first, then paid without double counting (S-72)', async () => {
    const w = world();
    crashed(w, 'r1', NOW + 30);
    expect((await rec(w, chainWith(false)))[0].outcome).toBe('held');
    expect((await rec(w, chainWith(true, '0x' + 'ee'.repeat(32))))[0].outcome).toBe('paid');
    expect(w.budget.totals('t1')).toMatchObject({ spent: 5000n, reserved: 0n, remaining: 15000n });
  });
  it('07 idempotent: a second run does nothing', async () => {
    const w = world();
    crashed(w, 'r1', NOW - 5);
    await rec(w, chainWith(false));
    const before = w.store.events().length;
    expect(await rec(w, chainWith(false))).toHaveLength(0);
    expect(w.store.events().length).toBe(before);
  });
  it('crash before signing: nothing authorised, released', async () => {
    const w = world();
    crashed(w, 'r1', 0, null);
    expect((await rec(w, chainWith(false)))[0]).toMatchObject({ outcome: 'failed', reason: 'never signed' });
    expect(w.budget.totals('t1').reserved).toBe(0n);
  });
});

describe('recovery never races a live call', () => {
  it('skips an intent that is still in flight in this process', async () => {
    const { inFlight } = await import('../src/inflight');
    const w = world();
    crashed(w, 'live1', NOW + 30);
    inFlight.add('live1');
    try {
      expect(await rec(w, chainWith(true, '0x' + 'cd'.repeat(32)))).toHaveLength(0);
      expect(w.budget.totals('t1').reserved).toBe(5000n); // untouched
    } finally { inFlight.delete('live1'); }
    expect((await rec(w, chainWith(true)))[0].outcome).toBe('paid'); // once the call is gone, recovery resolves it
  });
  it('commit and release are idempotent for the state they already hold', () => {
    const w = world();
    const r = w.budget.reserve({ taskId: 't1', requestId: 'x', sellerId: 's', category: 'data', amount: 1000n });
    if (!r.ok) throw new Error('reserve failed');
    w.budget.commit(r.id);
    expect(() => w.budget.commit(r.id)).not.toThrow();
    expect(() => w.budget.release(r.id)).toThrow();
  });
});
