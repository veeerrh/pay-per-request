export type VerdictKind = 'ALLOW' | 'REFUSE' | 'RELEASE' | 'ACCEPT_FLAG' | 'HOLD' | 'STOP_TASK';
export type LedgerStatus = 'paid' | 'refused' | 'failed' | 'rejected' | 'pending';

export interface Verdict {
  verdict: VerdictKind;
  ruleId: string;
  reason: string;
  alarm?: boolean;
  suspend?: boolean;
  note?: string;
}

const STATUS: Record<VerdictKind, LedgerStatus> = {
  ALLOW: 'paid',
  REFUSE: 'refused',
  RELEASE: 'failed',
  ACCEPT_FLAG: 'rejected',
  HOLD: 'pending',
  STOP_TASK: 'refused',
};

/** Verdict to ledger status (design 4.2). */
export const statusFor = (v: VerdictKind): LedgerStatus => STATUS[v];
