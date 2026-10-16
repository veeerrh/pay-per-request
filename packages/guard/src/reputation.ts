import type { RulesConfig } from './config';

// Reputation is a pure function of ledger entries: nobody can edit a score (M-08, M-43, S-70).
export type AttemptClass = 'clean' | 'fraud' | 'junk' | 'availability' | 'excluded' | 'unresolved';

/** Refusals that mean the seller lied about price, payee, asset, network or payment terms (M-09, M-42). */
const FRAUD_RULES = new Set(['M-17', 'S-06', 'S-14', 'S-15', 'S-16', 'S-22', 'S-23', 'S-24', 'S-25', 'M-54']);
/** Refusals that are not the seller's fault: budget, caps, our own limits, halted ledger, self payment, duplicates. */
const EXCLUDED_RULES = new Set(['M-15', 'M-18', 'M-19', 'M-21', 'M-58', 'M-62', 'M-51', 'S-26', 'M-14']);

export interface LedgerLike {
  sellerId?: unknown;
  category?: unknown;
  status?: unknown;
  ruleId?: unknown;
  listed?: unknown;
  latencyMs?: unknown;
  time?: unknown;
  callNo?: unknown;
}

export function classify(e: LedgerLike): AttemptClass {
  switch (e.status) {
    case 'paid': return 'clean';
    case 'rejected': return 'junk';
    case 'failed': return 'availability';
    case 'refused': {
      const r = String(e.ruleId ?? '');
      if (EXCLUDED_RULES.has(r)) return 'excluded';
      if (FRAUD_RULES.has(r)) return 'fraud';
      return 'availability'; // malformed 402 and other seller-side oddities
    }
    default: return 'unresolved';
  }
}

export type SellerStatus = 'probation' | 'active' | 'dropped';
export interface SellerReputation {
  sellerId: string;
  attempts: number;
  clean: number;
  fraud: number;
  junk: number;
  availability: number;
  /** clean / attempts, the simple number shown on screen. null when there are no attempts. */
  headline: number | null;
  /** Shrunk score used for ranking: (clean + 1) / (clean + 1 + wf*fraud + wj*junk + wa*availability + 1). */
  score: number;
  medianLatencyMs: number | null;
  medianPrice: bigint | null;
  status: SellerStatus;
  /** A fraud event inside the cooling-off window. */
  suspended: boolean;
  proven: boolean;
  lastRuleId: string | null;
}

const median = <T extends number | bigint>(xs: T[]): T | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = s.length >> 1;
  if (s.length % 2) return s[m];
  const a = s[m - 1], b = s[m];
  return (typeof a === 'bigint' ? (a + (b as bigint)) / 2n : Math.floor(((a as number) + (b as number)) / 2)) as T;
};

export function computeReputation(entries: LedgerLike[], cfg: RulesConfig, nowMs: number): Map<string, SellerReputation> {
  const bySeller = new Map<string, LedgerLike[]>();
  for (const e of entries) {
    if (!e.sellerId) continue;
    const id = String(e.sellerId);
    if (!bySeller.has(id)) bySeller.set(id, []);
    bySeller.get(id)!.push(e);
  }
  const out = new Map<string, SellerReputation>();
  for (const [id, rows] of bySeller) {
    const counted = rows
      .map((e) => ({ e, c: classify(e) }))
      .filter((x) => x.c !== 'excluded' && x.c !== 'unresolved')
      .sort((a, b) => Number(a.e.callNo ?? 0) - Number(b.e.callNo ?? 0))
      .slice(-cfg.reputationWindow);
    const n = (c: AttemptClass) => counted.filter((x) => x.c === c).length;
    const clean = n('clean'), fraud = n('fraud'), junk = n('junk'), availability = n('availability');
    const attempts = counted.length;
    const w = cfg.weights;
    const score = (clean + 1) / (clean + 1 + w.fraud * fraud + w.junk * junk + w.availability * availability + 1);
    const headline = attempts ? clean / attempts : null;
    const lastFraud = counted.filter((x) => x.c === 'fraud').map((x) => Date.parse(String(x.e.time))).filter(Number.isFinite).sort((a, b) => b - a)[0];
    const suspended = lastFraud !== undefined && nowMs - lastFraud < cfg.coolingOffSeconds * 1000;
    const proven = attempts >= cfg.probationAttempts;
    const status: SellerStatus = proven && headline !== null && headline < cfg.dropThreshold ? 'dropped' : proven ? 'active' : 'probation';
    const last = [...counted].reverse().find((x) => x.c !== 'clean');
    out.set(id, {
      sellerId: id, attempts, clean, fraud, junk, availability, headline, score,
      medianLatencyMs: median(counted.map((x) => Number(x.e.latencyMs ?? 0)).filter((v) => v > 0)),
      medianPrice: median(counted.map((x) => BigInt(String(x.e.listed ?? '0')))),
      status, suspended, proven, lastRuleId: last ? String(last.e.ruleId ?? '') || null : null,
    });
  }
  return out;
}

/** What an unseen seller looks like: probation, neutral score. */
export const newSellerReputation = (sellerId: string, cfg: RulesConfig): SellerReputation => ({
  sellerId, attempts: 0, clean: 0, fraud: 0, junk: 0, availability: 0, headline: null, score: 1 / 2,
  medianLatencyMs: null, medianPrice: null, status: 'probation', suspended: false, proven: cfg.probationAttempts <= 0, lastRuleId: null,
});

export interface Rankable { id: string; price: bigint; rep: SellerReputation }

/** Deterministic order (M-46, M-45): proven before unproven, then score desc, price asc, latency asc, id asc. */
export function compareSellers(a: Rankable, b: Rankable): number {
  if (a.rep.proven !== b.rep.proven) return a.rep.proven ? -1 : 1;
  if (a.rep.score !== b.rep.score) return b.rep.score - a.rep.score;
  if (a.price !== b.price) return a.price < b.price ? -1 : 1;
  const la = a.rep.medianLatencyMs ?? Number.MAX_SAFE_INTEGER, lb = b.rep.medianLatencyMs ?? Number.MAX_SAFE_INTEGER;
  if (la !== lb) return la - lb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
