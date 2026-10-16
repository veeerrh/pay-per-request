import type { RulesConfig } from './config';
import { compareSellers, newSellerReputation, type SellerReputation } from './reputation';
import { sameAddress } from './money';
import { fmtUnits } from './rules/types';

/**
 * Only typed fields: seller-written text (descriptions, labels) never influences selection (M-12, S-51).
 */
export interface SellerListing {
  id: string;
  name: string;
  category: string;
  price: bigint;
  payTo: string;
  endpoint: string;
  method?: 'GET' | 'POST';
  listingHash: string;
}

export interface Candidate extends SellerListing {
  rep: SellerReputation;
  rank: number;
  why: string;
}
export interface SelectionResult {
  candidates: Candidate[];
  skipped: Array<{ id: string; code: 'self_payment' | 'excluded' | 'dropped' | 'unaffordable' | 'probation_cap'; reason: string }>;
}

export interface SelectInput {
  category: string;
  listings: SellerListing[];
  /** Reputation snapshot taken at step start (S-68). */
  reputation: Map<string, SellerReputation>;
  /** Sellers refused, failed or flagged in THIS task. Applies immediately (M-13). */
  exclusions: Set<string>;
  remaining: bigint;
  buyerAddress: string;
  cfg: RulesConfig;
  /** Units already spent on each seller in this task, for the probation cap (M-45). */
  spentBySeller?: Map<string, bigint>;
}

export function selectCandidates(i: SelectInput): SelectionResult {
  const skipped: SelectionResult['skipped'] = [];
  const eligible: Array<{ l: SellerListing; rep: SellerReputation }> = [];
  for (const l of i.listings.filter((x) => x.category === i.category)) {
    const rep = i.reputation.get(l.id) ?? newSellerReputation(l.id, i.cfg);
    if (sameAddress(l.payTo, i.buyerAddress)) { skipped.push({ id: l.id, code: 'self_payment', reason: 'payTo is the buyer (M-14)' }); continue; }
    if (i.exclusions.has(l.id)) { skipped.push({ id: l.id, code: 'excluded', reason: 'already refused or failed in this task (M-13)' }); continue; }
    if (rep.status === 'dropped') { skipped.push({ id: l.id, code: 'dropped', reason: `dropped: ${rep.clean} clean of ${rep.attempts} attempts (M-44)` }); continue; }
    if (l.price > i.remaining) { skipped.push({ id: l.id, code: 'unaffordable', reason: `costs ${fmtUnits(l.price)} units, ${fmtUnits(i.remaining)} remain (M-47)` }); continue; }
    if (!rep.proven && (i.spentBySeller?.get(l.id) ?? 0n) + l.price > BigInt(i.cfg.probationSpendCap)) {
      skipped.push({ id: l.id, code: 'probation_cap', reason: 'probation spending cap for this task would be exceeded (M-45)' });
      continue;
    }
    eligible.push({ l, rep });
  }
  const ranked = eligible
    .map((x) => ({ id: x.l.id, price: x.l.price, rep: x.rep, l: x.l }))
    .sort(compareSellers)
    .map((x, idx): Candidate => ({
      ...x.l, rep: x.rep, rank: idx + 1,
      why: `ranked #${idx + 1} of ${eligible.length}: ${x.rep.proven ? 'proven' : 'unproven'}, score ${x.rep.score.toFixed(2)}, ${fmtUnits(x.l.price)} units`,
    }));
  return { candidates: ranked, skipped };
}
