import { Store } from './store/store';
import { Budget, runWithConcurrency } from './budget';
import type { RulesConfig } from './config';

export interface InvariantSummary {
  seed: number;
  runs: number;
  calls: number;
  maxSeen: bigint; // largest (spent + reserved) seen at any step, relative to its budget it must never exceed it
  violations: number;
  firstViolation?: string;
  chainOk: boolean;
}

// Small seeded PRNG so every run is reproducible from the seed (A-20).
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface InvariantOpts {
  seed: number;
  runs: number;
  cfg: RulesConfig;
  /** Test hook: build a (possibly faulty) Budget to prove the test can catch bugs. */
  factory?: (store: Store, cfg: RulesConfig) => Budget;
}

/** Hundreds of random parallel purchases against one budget. Asserts spent + reserved <= budget after every step. */
export async function runInvariant(o: InvariantOpts): Promise<InvariantSummary> {
  const rnd = mulberry32(o.seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const cfg: RulesConfig = { ...o.cfg, perTaskCallLimit: 1_000_000, perSellerCap: '1000000000', perCategoryCap: '1000000000', sessionCap: '1000000000000', rollingHourCap: '1000000000000', balanceFloor: '0', perCallCeiling: '100000' };
  const sum: InvariantSummary = { seed: o.seed, runs: o.runs, calls: 0, maxSeen: 0n, violations: 0, chainOk: true };
  const fail = (msg: string) => { sum.violations++; sum.firstViolation ??= msg; };

  for (let run = 0; run < o.runs; run++) {
    const store = new Store(':memory:', 'invariant');
    const budget = o.factory ? o.factory(store, cfg) : new Budget(store, cfg);
    const total = BigInt(int(5000, 60000));
    const taskId = `t${run}`;
    budget.openTask(taskId, total);
    const check = (where: string) => {
      const t = budget.totals(taskId);
      if (t.spent + t.reserved > total) fail(`run ${run} ${where}: spent ${t.spent} + reserved ${t.reserved} > budget ${total}`);
      if (t.spent + t.reserved > sum.maxSeen) sum.maxSeen = t.spent + t.reserved;
    };
    let held = 0n;
    const n = int(50, 300);
    const jobs = Array.from({ length: n }, (_, i) => {
      const price = BigInt(int(1000, 10000));
      const kind = ['pay', 'fail', 'throw', 'hold', 'pay'][int(0, 4)];
      const yields = int(0, 5);
      return async () => {
        sum.calls++;
        try {
          const r = await budget.withReservation({ taskId, requestId: `r${run}_${i}`, sellerId: `s${i % 4}`, category: 'data', amount: price }, async () => {
            check('after reserve');
            for (let k = 0; k < yields; k++) await Promise.resolve();
            if (kind === 'throw') throw new Error('boom');
            if (kind === 'hold') held += price;
            return { outcome: kind === 'pay' ? ('spent' as const) : kind === 'hold' ? ('held' as const) : ('released' as const), value: null };
          });
          void r;
        } catch { /* expected for 'throw' */ }
        check('after settle');
      };
    });
    await runWithConcurrency(int(1, 5), jobs);
    const t = budget.totals(taskId);
    // Held reservations stay reserved on purpose (crash recovery owns them); nothing else may remain reserved.
    if (t.reserved !== held) fail(`run ${run}: reserved ${t.reserved} at the end, expected only held ${held}`);
    if (!store.verifyChain().ok) sum.chainOk = false;
    store.close();
  }
  return sum;
}
