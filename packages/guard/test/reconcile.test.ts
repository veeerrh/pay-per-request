import { describe, it, expect } from 'vitest';
import { Store, reconcile, type ReconcileChain, type ChainTransfer } from '../src';

const ME = '0xADb43a17Cb94d4125f45522d815060B58A71dcCb';
const H1 = '0x' + '01'.repeat(32);
const H2 = '0x' + '02'.repeat(32);
const H3 = '0x' + '03'.repeat(32);

function mockChain(transfers: ChainTransfer[], over: Partial<ReconcileChain> = {}): ReconcileChain {
  return {
    authorizationState: async () => false,
    blockNumber: async () => 100n,
    getTransfersFrom: async () => transfers,
    getReceiptStatus: async () => 'success',
    balanceOf: async () => 19_000_000n,
    ...over,
  };
}
const t = (txHash: string, value: bigint): ChainTransfer => ({ txHash, to: '0xseller', value, blockNumber: 1n });

function ledger(rows: Array<{ id: string; status: string; paid: string; txHash?: string | null }>) {
  const s = new Store(':memory:', 'rs');
  for (const r of rows) {
    s.appendEvent({ requestId: r.id, taskId: 't1', eventType: 'intent', payload: { seller: 'S', status: 'pending', paid: '0' } });
    if (r.status !== 'pending') s.appendEvent({ requestId: r.id, taskId: 't1', eventType: 'final', payload: { status: r.status, paid: r.paid, txHash: r.txHash ?? null, txConfirmed: false } });
  }
  return s;
}
const run = (s: Store, chain: ReconcileChain) => reconcile({ store: s, chain, buyerAddress: ME, fromBlock: 1n });

describe('reconciliation (TC-3.3)', () => {
  it('01 exact match, then confirmation events (M-36)', async () => {
    const s = ledger([{ id: 'a', status: 'paid', paid: '5000', txHash: H1 }, { id: 'b', status: 'rejected', paid: '8000', txHash: H2 }, { id: 'c', status: 'refused', paid: '0' }]);
    const r = await run(s, mockChain([t(H1, 5000n), t(H2, 8000n)]));
    expect(r).toMatchObject({ ok: true, status: 'matched', ledgerTotal: 13000n, chainTotal: 13000n });
    expect(s.listEntries().filter((e) => e.txConfirmed)).toHaveLength(2);
    expect(s.verifyChain().ok).toBe(true);
  });
  it('02 ledger-only row', async () => {
    const s = ledger([{ id: 'a', status: 'paid', paid: '5000', txHash: H1 }]);
    const r = await run(s, mockChain([]));
    expect(r.ok).toBe(false);
    expect(r.differences[0]).toMatchObject({ status: 'ledger_only', ledgerAmount: 5000n });
  });
  it('03 amount mismatch shows both numbers', async () => {
    const s = ledger([{ id: 'a', status: 'paid', paid: '5000', txHash: H1 }]);
    const r = await run(s, mockChain([t(H1, 4000n)]));
    expect(r.differences[0]).toMatchObject({ status: 'amount_mismatch', ledgerAmount: 5000n, chainAmount: 4000n });
  });
  it('04 chain-only transfer out of Beacon (alarm)', async () => {
    const s = ledger([{ id: 'a', status: 'paid', paid: '5000', txHash: H1 }]);
    const r = await run(s, mockChain([t(H1, 5000n), t(H3, 1000n)]));
    expect(r.ok).toBe(false);
    expect(r.differences).toEqual([expect.objectContaining({ status: 'chain_only', chainAmount: 1000n })]);
  });
  it('05 unreadable chain is unverified, never ok', async () => {
    const s = ledger([{ id: 'a', status: 'paid', paid: '5000', txHash: H1 }]);
    const r = await run(s, mockChain([], { getTransfersFrom: async () => { throw new Error('HTTP 429'); } }));
    expect(r).toMatchObject({ ok: false, status: 'unverified' });
    expect(r.error).toContain('429');
  });
  it('07 empty session is ok with zero totals', async () => {
    const r = await run(new Store(':memory:', 'rs'), mockChain([]));
    expect(r).toMatchObject({ ok: true, ledgerTotal: 0n, chainTotal: 0n });
  });
  it('pending rows are reported, not silently ignored', async () => {
    const s = ledger([{ id: 'a', status: 'pending', paid: '0' }]);
    const r = await run(s, mockChain([]));
    expect(r.ok).toBe(false);
    expect(r.differences[0].status).toBe('pending_reconcile');
  });
  it('missing receipt does not confirm', async () => {
    const s = ledger([{ id: 'a', status: 'paid', paid: '5000', txHash: H1 }]);
    await run(s, mockChain([t(H1, 5000n)], { getReceiptStatus: async () => 'missing' }));
    expect(s.listEntries()[0].txConfirmed).toBe(false);
  });
});
