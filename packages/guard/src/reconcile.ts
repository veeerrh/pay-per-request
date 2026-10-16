import type { Store } from './store/store';
import type { ReconcileChain } from './chain';

export type RowMatch = 'match' | 'ledger_only' | 'chain_only' | 'amount_mismatch' | 'pending_reconcile';
export interface ReconcileRow {
  requestId: string | null;
  txHash: string | null;
  ledgerAmount: bigint;
  chainAmount: bigint;
  status: RowMatch;
}
export interface ReconcileResult {
  /** false whenever anything differs OR the chain could not be read. Never true on a failed read. */
  ok: boolean;
  status: 'matched' | 'differences' | 'unverified';
  ledgerTotal: bigint;
  chainTotal: bigint;
  rows: ReconcileRow[];
  differences: ReconcileRow[];
  wallet?: { balance: bigint; note: string };
  error?: string;
}

/**
 * Compares paid ledger rows with USDC transfers OUT of the buyer wallet since the session started (M-34, T-02).
 * Wallet balance is only a cross-check because faucet top-ups change it (M-68).
 */
export async function reconcile(d: { store: Store; chain: ReconcileChain; buyerAddress: string; fromBlock: bigint; sessionId?: string }): Promise<ReconcileResult> {
  const entries = d.store.listEntries(d.sessionId);
  const moved = entries.filter((e) => e.status === 'paid' || e.status === 'rejected');
  const pending = entries.filter((e) => e.status === 'pending');
  const ledgerTotal = moved.reduce((s, e) => s + BigInt(String(e.paid ?? '0')), 0n);

  let transfers;
  try {
    transfers = await d.chain.getTransfersFrom(d.buyerAddress, d.fromBlock);
  } catch (e) {
    return { ok: false, status: 'unverified', ledgerTotal, chainTotal: 0n, rows: [], differences: [], error: `could not read the chain: ${(e as Error).message}` };
  }
  const byHash = new Map(transfers.map((t) => [t.txHash.toLowerCase(), t]));
  const rows: ReconcileRow[] = [];
  const used = new Set<string>();

  for (const e of moved) {
    const hash = e.txHash ? String(e.txHash).toLowerCase() : null;
    const amount = BigInt(String(e.paid ?? '0'));
    const t = hash ? byHash.get(hash) : undefined;
    if (!t) { rows.push({ requestId: String(e.id), txHash: hash, ledgerAmount: amount, chainAmount: 0n, status: 'ledger_only' }); continue; }
    used.add(hash as string);
    rows.push({ requestId: String(e.id), txHash: hash, ledgerAmount: amount, chainAmount: t.value, status: t.value === amount ? 'match' : 'amount_mismatch' });
  }
  for (const e of pending) rows.push({ requestId: String(e.id), txHash: null, ledgerAmount: 0n, chainAmount: 0n, status: 'pending_reconcile' });
  for (const t of transfers) if (!used.has(t.txHash.toLowerCase())) rows.push({ requestId: null, txHash: t.txHash, ledgerAmount: 0n, chainAmount: t.value, status: 'chain_only' });

  // A matched row is confirmed only once its receipt exists and succeeded (M-36). New event, never an edit.
  let receiptError: string | undefined;
  for (const r of rows.filter((x) => x.status === 'match')) {
    const entry = moved.find((e) => String(e.id) === r.requestId);
    if (!entry || entry.txConfirmed) continue;
    try {
      if ((await d.chain.getReceiptStatus(r.txHash as string)) === 'success') {
        d.store.appendEvent({ requestId: r.requestId as string, taskId: String(entry.taskId), eventType: 'confirmed', payload: { txConfirmed: true } });
      }
    } catch (e) { receiptError = (e as Error).message; }
  }

  const chainTotal = transfers.reduce((s, t) => s + t.value, 0n);
  const differences = rows.filter((r) => r.status !== 'match');
  let wallet: ReconcileResult['wallet'];
  try { wallet = { balance: await d.chain.balanceOf(d.buyerAddress), note: 'cross-check only; faucet top-ups change the balance' }; } catch { /* optional */ }
  const ok = differences.length === 0 && !receiptError;
  return { ok, status: ok ? 'matched' : receiptError && differences.length === 0 ? 'unverified' : 'differences', ledgerTotal, chainTotal, rows, differences, wallet, error: receiptError };
}
