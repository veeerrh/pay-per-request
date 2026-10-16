import type { RulesConfig } from './config';
import type { Accept } from './contract/payment-required';
import type { ListingSnapshot } from './contract/facts';
import type { Verdict } from './contract/verdict';
import { evaluate } from './engine';
import { limitVerdict, type BudgetState } from './rules/limits';

// Dry-run is pure: it never imports the signer, the store or the network (A-18).
export interface DryStep {
  label: string;
  sellerId: string;
  category: string;
  listing: ListingSnapshot;
  accepts: Accept[];
}
export interface DryResult {
  label: string;
  verdict: Verdict;
  allVerdicts: Verdict[];
  wouldSpend: bigint;
  remainingAfter: bigint;
}

export function dryRun(steps: DryStep[], budget: bigint, cfg: RulesConfig, buyerAddress: string, walletBalance: bigint): DryResult[] {
  const out: DryResult[] = [];
  const spent = { total: 0n, bySeller: new Map<string, bigint>(), byCat: new Map<string, bigint>() };
  let calls = 0;
  for (const s of steps) {
    const ev = evaluate({
      listing: s.listing, snapshotHash: 'dry', liveListingHash: 'dry', accepts: s.accepts, buyerAddress,
      config: { maxTimeoutSeconds: cfg.maxTimeoutSeconds, oddDropRatioPct: cfg.oddDropRatioPct },
    });
    let verdict = ev.decision;
    let wouldSpend = 0n;
    if (verdict.verdict === 'ALLOW' && ev.chosen) {
      const price = ev.chosen.amount;
      const state: BudgetState = {
        remaining: budget - spent.total, spentOnSeller: spent.bySeller.get(s.sellerId) ?? 0n, spentOnCategory: spent.byCat.get(s.category) ?? 0n,
        spentInSession: spent.total, spentLastHour: spent.total, walletBalance: walletBalance - spent.total, callsInTask: calls, elapsedSeconds: 0,
      };
      const lim = limitVerdict(state, price, cfg);
      if (lim) verdict = lim;
      else {
        wouldSpend = price;
        spent.total += price;
        spent.bySeller.set(s.sellerId, (spent.bySeller.get(s.sellerId) ?? 0n) + price);
        spent.byCat.set(s.category, (spent.byCat.get(s.category) ?? 0n) + price);
        calls += 1;
      }
    }
    out.push({ label: s.label, verdict, allVerdicts: ev.verdicts, wouldSpend, remainingAfter: budget - spent.total });
  }
  return out;
}
