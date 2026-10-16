import type { Store } from './store/store';
import type { Budget } from './budget';
import type { ChainReader } from './chain-types';
import type { LogFn } from './redact';

export type RecoveryOutcome = 'paid' | 'failed' | 'held' | 'error';
export interface RecoveryRow { requestId: string; outcome: RecoveryOutcome; reason: string; txHash?: string }

/**
 * Resolves every purchase that was signed but never finished (M-32, M-52, S-31, S-72).
 * The rule: the budget is released only when the authorisation is known unused AND expired, or never signed.
 */
export async function recoverPending(d: { store: Store; budget: Budget; chain: ChainReader; signerAddress: string; nowSeconds?: () => number; log?: LogFn }): Promise<RecoveryRow[]> {
  const now = d.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const out: RecoveryRow[] = [];
  for (const i of d.store.unfinishedIntents()) {
    const res = d.budget.reservationFor(i.requestId);
    const finish = (status: 'paid' | 'failed', ruleId: string, reason: string, txHash?: string) => {
      d.store.appendEvent({
        requestId: i.requestId, taskId: i.taskId, eventType: 'final',
        payload: { status, paid: status === 'paid' ? i.amount.toString() : '0', txHash: txHash ?? null, txConfirmed: false, ruleId, reason, recovered: true },
      });
      d.store.setIntentState(i.requestId, 'done');
      if (res?.state === 'reserved') (status === 'paid' ? d.budget.commit(res.id) : d.budget.release(res.id));
    };
    try {
      if (!i.nonce) { // crash before signing: no authorisation exists
        finish('failed', 'S-31', 'crashed before signing; nothing was authorised or charged');
        out.push({ requestId: i.requestId, outcome: 'failed', reason: 'never signed' });
        continue;
      }
      const used = await d.chain.authorizationState(d.signerAddress, i.nonce);
      if (used) {
        const use = d.chain.findAuthorizationUse ? await d.chain.findAuthorizationUse(d.signerAddress, i.nonce) : null;
        finish('paid', 'S-72', 'response was lost; the chain shows the authorisation was used, recovered as paid', use?.txHash);
        out.push({ requestId: i.requestId, outcome: 'paid', reason: 'authorisation used on chain', txHash: use?.txHash });
      } else if (i.validBefore !== null && now() > i.validBefore) {
        finish('failed', 'S-31', 'authorisation expired unused; nothing was charged');
        out.push({ requestId: i.requestId, outcome: 'failed', reason: 'expired unused' });
      } else {
        out.push({ requestId: i.requestId, outcome: 'held', reason: 'authorisation unused but still valid; keeping the reservation' });
      }
    } catch (e) {
      d.log?.('warn', `recovery could not read the chain for ${i.requestId}`, { error: (e as Error).message });
      out.push({ requestId: i.requestId, outcome: 'error', reason: `chain read failed: ${(e as Error).message}` });
    }
  }
  return out;
}

export interface GuardStart { spendingHalted: boolean; reason?: string; recovered: RecoveryRow[] }

/** Startup order: verify the ledger chain, then resolve pending purchases, then open for tasks (M-62, S-84). */
export async function startGuard(d: { store: Store; budget: Budget; chain: ChainReader; signerAddress: string; nowSeconds?: () => number; log?: LogFn }): Promise<GuardStart> {
  const c = d.store.verifyChain();
  if (!c.ok) {
    d.log?.('error', 'ledger hash chain is broken; spending halted', { brokenAt: c.brokenAt });
    return { spendingHalted: true, reason: `ledger chain broken at row ${c.brokenAt}`, recovered: [] };
  }
  return { spendingHalted: false, recovered: await recoverPending(d) };
}

/** Re-checks held purchases until they resolve (backs off up to 2 minutes). Returns a stop function. */
export function startRecoveryLoop(d: Parameters<typeof recoverPending>[0], baseMs = 15_000): () => void {
  let stopped = false;
  let delay = baseMs;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    if (stopped) return;
    const rows = await recoverPending(d);
    delay = rows.some((r) => r.outcome === 'error') ? Math.min(delay * 2, 120_000) : baseMs;
    if (!stopped) timer = setTimeout(tick, delay).unref();
  };
  timer = setTimeout(tick, baseMs).unref();
  return () => { stopped = true; clearTimeout(timer); };
}
