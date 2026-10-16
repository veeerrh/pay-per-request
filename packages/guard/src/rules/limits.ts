import type { RulesConfig } from '../config';
import type { Verdict } from '../contract/verdict';
import { fmtUnits, refuse } from './types';

/** Budget facts, supplied by the store (2.2). Rules stay pure. */
export interface BudgetState {
  remaining: bigint; // task budget minus spent minus reserved
  spentOnSeller: bigint;
  spentOnCategory: bigint;
  spentInSession: bigint;
  spentLastHour: bigint;
  walletBalance: bigint;
  callsInTask: number;
  elapsedSeconds: number;
}

const stop = (ruleId: string, reason: string): Verdict => ({ verdict: 'STOP_TASK', ruleId, reason });

/** Checks a purchase of `price` units against every cap. Returns the first problem, or null if allowed. */
export function limitVerdict(s: BudgetState, price: bigint, cfg: RulesConfig): Verdict | null {
  if (s.callsInTask >= cfg.perTaskCallLimit) return stop('M-21', `task reached its limit of ${cfg.perTaskCallLimit} calls`);
  if (s.elapsedSeconds > cfg.perTaskWallClockSeconds) return stop('M-21', `task ran longer than ${cfg.perTaskWallClockSeconds} seconds`);
  if (price > s.remaining) return refuse('M-15', `needs ${fmtUnits(price)} units, ${fmtUnits(s.remaining)} remain in the budget`);
  if (price > BigInt(cfg.perCallCeiling)) return refuse('M-18', `${fmtUnits(price)} units is above the call ceiling of ${fmtUnits(BigInt(cfg.perCallCeiling))}`);
  if (s.spentOnSeller + price > BigInt(cfg.perSellerCap)) return refuse('M-19', 'per-seller spending cap for this task would be exceeded');
  if (s.spentOnCategory + price > BigInt(cfg.perCategoryCap)) return refuse('M-19', 'per-category spending cap for this task would be exceeded');
  if (s.spentInSession + price > BigInt(cfg.sessionCap)) return refuse('M-58', 'session spending cap reached (S-78)');
  if (s.spentLastHour + price > BigInt(cfg.rollingHourCap)) return refuse('M-58', 'rolling one-hour spending cap reached');
  if (s.walletBalance - price < BigInt(cfg.balanceFloor)) return refuse('M-58', 'wallet balance would fall below the floor');
  return null;
}

/** Task-start check (S-60, S-79): refuse to start when the wallet cannot cover the floor plus the first call. */
export function taskStartVerdict(walletBalance: bigint, minFirstCall: bigint, cfg: RulesConfig): Verdict | null {
  const need = BigInt(cfg.balanceFloor) + minFirstCall;
  if (walletBalance >= need) return null;
  return stop('M-58', `wallet holds ${fmtUnits(walletBalance)} units; needs at least ${fmtUnits(need)} (floor plus first call), ${fmtUnits(need - walletBalance)} missing`);
}
