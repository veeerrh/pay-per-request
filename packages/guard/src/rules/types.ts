import type { Accept } from '../contract/payment-required';
import type { Facts } from '../contract/facts';
import type { Verdict } from '../contract/verdict';

export interface AcceptCtx {
  facts: Facts;
  accept: Accept;
}
/** Pure: no network, no clock, no file access. Null means "no opinion". */
export type AcceptRule = (ctx: AcceptCtx) => Verdict | null;
export type GlobalRule = (facts: Facts) => Verdict | null;

export const refuse = (ruleId: string, reason: string, extra: Partial<Verdict> = {}): Verdict => ({ verdict: 'REFUSE', ruleId, reason, ...extra });
export const fmtUnits = (u: bigint): string => u.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
