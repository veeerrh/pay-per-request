import type { Facts } from './contract/facts';
import { decodePaymentRequired, ParseError, type Accept } from './contract/payment-required';
import type { Verdict } from './contract/verdict';
import { networkRule, assetRule } from './rules/asset-network';
import { schemeRule, extraRule, timeoutRule } from './rules/scheme-extra-timeout';
import { payToRule, selfPayRule } from './rules/payee';
import { priceRule, snapshotRule } from './rules/price';
import { refuse, type AcceptRule } from './rules/types';

// Fixed order. The first REFUSE for an entry stops the checks for that entry.
const ACCEPT_RULES: AcceptRule[] = [networkRule, schemeRule, assetRule, extraRule, timeoutRule, payToRule, selfPayRule, priceRule];

export interface Evaluation {
  /** Final answer: ALLOW (chosen set) or the REFUSE that explains why nothing matched. */
  decision: Verdict;
  /** Every verdict seen, so the log can show all of them. */
  verdicts: Verdict[];
  chosen?: Accept;
  chosenIndex?: number;
}

/** Checks every accepts[] entry and chooses the single entry that matches the listing exactly (X-03, S-17). */
export function evaluate(facts: Facts): Evaluation {
  const verdicts: Verdict[] = [];
  const snap = snapshotRule(facts);
  if (snap) verdicts.push(snap);
  if (facts.accepts.length === 0) {
    const v = refuse('S-18', 'accepts[] is empty or missing');
    return { decision: v, verdicts: [v] };
  }
  let firstRefuse: Verdict | undefined;
  for (let i = 0; i < facts.accepts.length; i++) {
    const accept = facts.accepts[i];
    let refused: Verdict | undefined;
    const seen: Verdict[] = [];
    for (const rule of ACCEPT_RULES) {
      const v = rule({ facts, accept });
      if (!v) continue;
      seen.push({ ...v, note: v.note ? `${v.note} [entry ${i}]` : `entry ${i}` });
      if (v.verdict === 'REFUSE') { refused = v; break; }
    }
    verdicts.push(...seen);
    if (!refused) {
      const allow = seen.find((s) => s.verdict === 'ALLOW') ?? { verdict: 'ALLOW' as const, ruleId: 'M-17', reason: 'all checks passed' };
      return { decision: allow, verdicts, chosen: accept, chosenIndex: i };
    }
    firstRefuse ??= refused;
  }
  return { decision: firstRefuse as Verdict, verdicts };
}

/** Header string to Evaluation. Parse failures become REFUSE verdicts (S-18, S-19, S-21). */
export function evaluateHeader(header: string, facts: Omit<Facts, 'accepts'>): Evaluation {
  try {
    return evaluate({ ...facts, accepts: decodePaymentRequired(header).accepts });
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    const id = e.code === 'EMPTY_ACCEPTS' ? 'S-18' : e.code === 'BAD_AMOUNT' ? 'S-21' : 'S-19';
    const v = refuse(id, `402 header rejected: ${e.message}`);
    return { decision: v, verdicts: [v] };
  }
}

/** S-24: terms must not change between the request we checked and the one we sign. */
export function compareTerms(first: Accept[], second: Accept[]): Verdict | null {
  const key = (a: Accept[]) => JSON.stringify(a.map((x) => [x.scheme, x.network, x.asset, x.amount.toString(), x.payTo.toLowerCase(), x.maxTimeoutSeconds, x.extra]));
  return key(first) === key(second) ? null : refuse('S-24', 'the 402 terms changed between requests; re-checking from scratch');
}
