import type { RulesConfig } from './config';
import type { PayRequest, PayResult } from './pay';
import type { SellerReputation } from './reputation';
import { selectCandidates, type Candidate, type SellerListing } from './selector';
import { fmtUnits } from './rules/types';

export type StopCode = 'no_eligible_seller' | 'fallback_exhausted' | 'budget_too_low' | 'budget_exhausted';
export interface StepAttempt { sellerId: string; sellerName: string; why: string; result: PayResult }
export interface StepOutcome {
  /** The accepted purchase, if any. */
  accepted?: { candidate: Candidate; result: PayResult };
  attempts: StepAttempt[];
  stop?: { code: StopCode; message: string };
}

export interface StepDeps {
  category: string;
  listings: SellerListing[];
  reputation: Map<string, SellerReputation>; // snapshot at step start (S-68)
  exclusions: Set<string>; // shared across the task; updated immediately on a refusal (M-13)
  remaining: () => bigint;
  buyerAddress: string;
  cfg: RulesConfig;
  spentBySeller: Map<string, bigint>;
  /** Turns a candidate into a request and runs guard.pay(). Injected so this stays testable. */
  pay: (c: Candidate) => Promise<PayResult>;
}

/**
 * Tries eligible sellers in order. A refusal, failure or junk output excludes that seller for the rest of
 * the task and moves to the next one, up to the fallback limit (M-47). Never loops, never exceeds the budget.
 */
export async function runStep(d: StepDeps): Promise<StepOutcome> {
  const attempts: StepAttempt[] = [];
  let tried = 0;
  // Task-wide exclusion is for sellers that LIED (refused) or sent junk (rejected), M-13. A plain failure or
  // timeout only excludes the seller for this call, so one transient error cannot kill a whole step.
  const local = new Set<string>();
  const blocked = () => new Set([...d.exclusions, ...local]);
  const first = selectCandidates({ category: d.category, listings: d.listings, reputation: d.reputation, exclusions: blocked(), remaining: d.remaining(), buyerAddress: d.buyerAddress, cfg: d.cfg, spentBySeller: d.spentBySeller });
  const order = first.candidates.map((c) => c.id);

  for (const id of order) {
    if (tried >= d.cfg.fallbackLimit) break;
    if (blocked().has(id)) continue; // another parallel call in this task may have just excluded it
    const fresh = selectCandidates({ category: d.category, listings: d.listings, reputation: d.reputation, exclusions: blocked(), remaining: d.remaining(), buyerAddress: d.buyerAddress, cfg: d.cfg, spentBySeller: d.spentBySeller });
    const c = fresh.candidates.find((x) => x.id === id);
    if (!c) continue; // became unaffordable or excluded meanwhile
    tried++;
    const result = await d.pay(c);
    attempts.push({ sellerId: c.id, sellerName: c.name, why: c.why, result });
    if (result.status === 'paid') {
      d.spentBySeller.set(c.id, (d.spentBySeller.get(c.id) ?? 0n) + result.paid);
      return { accepted: { candidate: c, result }, attempts };
    }
    if (result.paid > 0n) d.spentBySeller.set(c.id, (d.spentBySeller.get(c.id) ?? 0n) + result.paid);
    if (result.verdict === 'STOP_TASK') return { attempts, stop: { code: 'budget_exhausted', message: result.reason } };
    if (result.status === 'refused' || result.status === 'rejected') d.exclusions.add(c.id); // liars and junk sellers: never again in this task (M-13)
    else local.add(c.id); // failed or held: do not retry within this call
  }

  // Nothing was bought. Explain exactly why.
  const now = selectCandidates({ category: d.category, listings: d.listings, reputation: d.reputation, exclusions: blocked(), remaining: d.remaining(), buyerAddress: d.buyerAddress, cfg: d.cfg, spentBySeller: d.spentBySeller });
  if (tried >= d.cfg.fallbackLimit) {
    const list = attempts.map((a) => `${a.sellerName} (${a.result.status}: ${a.result.reason})`).join('; ');
    return { attempts, stop: { code: 'fallback_exhausted', message: `fallback limit of ${d.cfg.fallbackLimit} reached for ${d.category}. Tried: ${list}` } };
  }
  const unaffordable = first.skipped.concat(now.skipped).filter((s) => s.code === 'unaffordable');
  if (unaffordable.length && now.candidates.length === 0) {
    const cheapest = d.listings.filter((l) => l.category === d.category && !blocked().has(l.id) && unaffordable.some((u) => u.id === l.id)).sort((a, b) => (a.price < b.price ? -1 : 1))[0];
    const need = cheapest ? cheapest.price : 0n;
    return { attempts, stop: { code: 'budget_too_low', message: `${d.category} step needs ${fmtUnits(need)} units (${cheapest?.name ?? 'cheapest eligible seller'}) but only ${fmtUnits(d.remaining())} remain; ${fmtUnits(need - d.remaining())} more units are needed` } };
  }
  return { attempts, stop: { code: 'no_eligible_seller', message: `no eligible seller for ${d.category}: ${now.skipped.map((s) => `${s.id} (${s.reason})`).join('; ') || 'none are registered'}` } };
}

export type { PayRequest };
