import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store, Budget, FakeSigner, pay, loadConfig, USDC_ADDRESS, createLogger, redact, runWithConcurrency, type PayRequest, type ChainReader } from '../src';
import { startFakeSeller, SELLER_PAYTO, type Mode, type FakeSeller } from './helpers/fakeSeller';

const cfg0 = loadConfig(join(__dirname, '..', '..', '..', 'config', 'rules.config.json'));
const cfg = { ...cfg0, requestTimeoutMs: 400, maxBodyBytes: 5000 };
const sellers: FakeSeller[] = [];
afterEach(async () => { await Promise.all(sellers.splice(0).map((s) => s.close())); });

async function setup(mode: Mode, budget = 50000n, opts: { redirectTo?: string; chain?: ChainReader } = {}) {
  const s = await startFakeSeller(mode, { redirectTo: opts.redirectTo });
  sellers.push(s);
  const store = new Store(':memory:', 'rs');
  const b = new Budget(store, cfg);
  b.openTask('t1', budget);
  const signer = new FakeSigner();
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));
  const req = (i = 1): PayRequest => ({
    requestId: `r${i}`, taskId: 't1', seller: { id: 'fake', name: 'Fake', category: 'data' },
    listing: { price: 1000n, payTo: SELLER_PAYTO, network: 'eip155:84532', asset: USDC_ADDRESS }, listingHash: 'h', url: s.url,
  });
  const deps = { store, budget: b, signer, cfg, log, chain: opts.chain };
  return { s, store, b, signer, lines, req, deps };
}
const eventTypes = (store: Store, id: string) => store.events().filter((e) => e.requestId === id).map((e) => e.eventType);

describe('guard.pay (TC-2.3)', () => {
  it('01 honest paid call', async () => {
    const t = await setup('honest');
    const r = await pay(t.deps, t.req());
    expect(r.status).toBe('paid');
    expect(r.paid).toBe(1000n);
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(eventTypes(t.store, 'r1')).toEqual(['intent', 'signed', 'sent', 'final']);
    expect(t.b.totals('t1')).toMatchObject({ spent: 1000n, reserved: 0n });
    expect(t.signer.calls).toHaveLength(1);
    expect(t.store.verifyChain().ok).toBe(true);
  });
  it('02 price lie refused before signing', async () => {
    const t = await setup('overprice');
    const r = await pay(t.deps, t.req());
    expect(r).toMatchObject({ status: 'refused', ruleId: 'M-17', paid: 0n, signed: false });
    expect(t.signer.calls).toHaveLength(0);
    expect(eventTypes(t.store, 'r1')).toEqual(['intent', 'final']);
    expect(t.b.totals('t1').reserved).toBe(0n);
    expect(t.s.hits.paid).toBe(0);
  });
  for (const [mode, rule] of [['wrongPayTo', 'S-06'], ['wrongAsset', 'S-14'], ['wrongNetwork', 'S-15']] as const) {
    it(`03 ${mode} refused (${rule})`, async () => {
      const t = await setup(mode);
      const r = await pay(t.deps, t.req());
      expect(r).toMatchObject({ status: 'refused', ruleId: rule });
      expect(t.signer.calls).toHaveLength(0);
    });
  }
  it('04 multiple accepts: signs only the matching entry', async () => {
    const t = await setup('multiAccepts');
    const r = await pay(t.deps, t.req());
    expect(r.status).toBe('paid');
    const signedFor = t.signer.calls[0] as { accepts: Array<{ amount: string }> };
    expect(signedFor.accepts).toHaveLength(1);
    expect(signedFor.accepts[0].amount).toBe('1000');
  });
  it('05 terms change between requests (S-24)', async () => {
    const t = await setup('changeTerms');
    const r = await pay(t.deps, t.req());
    expect(r).toMatchObject({ status: 'refused', ruleId: 'S-24' });
    expect(t.signer.calls).toHaveLength(0);
  });
  it('06 cross-host redirect never receives a payment header (S-25)', async () => {
    const other = await startFakeSeller('honest');
    sellers.push(other);
    const t = await setup('redirect', 50000n, { redirectTo: other.url });
    const r = await pay(t.deps, t.req());
    expect(r).toMatchObject({ status: 'refused', ruleId: 'S-25' });
    expect(other.hits.paid).toBe(0);
    expect(t.signer.calls).toHaveLength(0);
  });
  it('06b redirect on the paid request is held, not followed', async () => {
    const other = await startFakeSeller('honest');
    sellers.push(other);
    const t = await setup('redirectPaid', 50000n, { redirectTo: other.url });
    const r = await pay(t.deps, t.req());
    expect(r.status).toBe('pending');
    expect(other.hits.paid).toBe(0);
    expect(t.b.totals('t1').reserved).toBe(1000n);
  });
  it('07 timeout after signing is held (S-28)', async () => {
    const t = await setup('hang');
    const r = await pay(t.deps, t.req());
    expect(r).toMatchObject({ status: 'pending', verdict: 'HOLD', signed: true });
    expect(t.b.totals('t1').reserved).toBe(1000n);
    expect(t.store.listEntries()[0].status).toBe('pending');
    expect(t.store.getIntent('r1')?.state).toBe('sent');
  });
  it('08 5xx after signing: failed once the nonce is unused (S-27)', async () => {
    const t = await setup('error5xx', 50000n, { chain: { authorizationState: async () => false } });
    const r = await pay(t.deps, t.req());
    expect(r).toMatchObject({ status: 'failed', verdict: 'RELEASE' });
    expect(t.b.totals('t1')).toMatchObject({ reserved: 0n, spent: 0n });
  });
  it('08b 5xx with unknown chain state is held', async () => {
    const t = await setup('error5xx');
    expect((await pay(t.deps, t.req())).status).toBe('pending');
  });
  it('09 200 without PAYMENT-RESPONSE is pending, not paid (S-29)', async () => {
    const t = await setup('noPaymentResponse');
    expect((await pay(t.deps, t.req())).status).toBe('pending');
  });
  it('10 oversized body aborts the read and records a rejected paid call (S-36)', async () => {
    const t = await setup('bigBody');
    const r = await pay(t.deps, t.req());
    expect(r).toMatchObject({ status: 'rejected', ruleId: 'S-36', paid: 1000n });
  });
  it('junk body (not JSON) is paid, output rejected', async () => {
    const t = await setup('junk');
    expect(await pay(t.deps, t.req())).toMatchObject({ status: 'rejected', paid: 1000n });
  });
  it('11 parallel calls, budget for two: signer called exactly twice', async () => {
    const t = await setup('honest', 2500n);
    const out = await runWithConcurrency(5, [1, 2, 3, 4, 5].map((i) => () => pay(t.deps, t.req(i))));
    expect(out.filter((o) => o.status === 'paid')).toHaveLength(2);
    expect(out.filter((o) => o.status === 'refused')).toHaveLength(3);
    expect(t.signer.calls).toHaveLength(2);
    expect(t.b.totals('t1').spent).toBe(2000n);
  });
  it('12 key and signature never reach a log line (M-37, M-38)', async () => {
    const key = '0x' + 'b'.repeat(64);
    for (const mode of ['honest', 'overprice', 'error5xx', 'junk'] as Mode[]) {
      const t = await setup(mode);
      await pay(t.deps, t.req());
      for (const l of t.lines) { expect(l).not.toContain(key); expect(l).not.toMatch(/fake-signature/); }
    }
    expect(redact(`PAYMENT-SIGNATURE: ${'A'.repeat(60)} key=${key} private_key=${key}`)).not.toContain(key);
    expect(redact(`PAYMENT-SIGNATURE: ${'A'.repeat(60)}`)).not.toContain('AAAAAAAAAA');
  });
  it('13 only signer.ts references the private key variable; planner never imports the signer', () => {
    const src = join(__dirname, '..', 'src');
    for (const f of readdirSync(src, { recursive: true }) as string[]) {
      if (!/\.ts$/.test(f) || f === 'signer.ts') continue;
      expect(readFileSync(join(src, f), 'utf8'), f).not.toContain('BEACON_PRIVATE_KEY');
    }
  });
  it('one authorisation per request id (M-51)', async () => {
    const t = await setup('honest');
    await pay(t.deps, t.req(1));
    const again = await pay(t.deps, t.req(1));
    expect(again.status).toBe('refused');
    expect(t.signer.calls).toHaveLength(1);
  });
});
