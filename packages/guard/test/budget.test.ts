import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { Store, Budget, runWithConcurrency, runInvariant, loadConfig, type Outcome } from '../src';

const cfg = loadConfig(join(__dirname, '..', '..', '..', 'config', 'rules.config.json'));
const setup = (budget: bigint, c = cfg) => {
  const store = new Store(':memory:', 'rs');
  const b = new Budget(store, c);
  b.openTask('t1', budget);
  return { store, b };
};
const args = (i: number, amount = 5000n) => ({ taskId: 't1', requestId: `r${i}`, sellerId: `s${i}`, category: 'data', amount });
const spend = async (): Promise<Outcome<null>> => ({ outcome: 'spent', value: null });

describe('budget reservation (TC-2.2)', () => {
  it('01 reserve and commit', () => {
    const { b } = setup(12000n);
    const r = b.reserve(args(1));
    expect(r.ok).toBe(true);
    if (r.ok) b.commit(r.id);
    expect(b.totals('t1')).toMatchObject({ spent: 5000n, reserved: 0n, remaining: 7000n });
  });
  it('02 T-03a at concurrency 1', async () => {
    const { b } = setup(12000n);
    const out = await runWithConcurrency(1, [1, 2, 3].map((i) => () => b.withReservation(args(i), spend)));
    expect(out.filter((o) => 'outcome' in o)).toHaveLength(2);
    expect(b.totals('t1').spent).toBe(10000n);
  });
  it('03 T-03b at concurrency 5: exactly 2 reserved, 3 refused', async () => {
    const { b } = setup(12000n);
    const out = await runWithConcurrency(5, [1, 2, 3, 4, 5].map((i) => () => b.withReservation(args(i), async () => { await new Promise((r) => setTimeout(r, 5)); return { outcome: 'spent' as const, value: null }; })));
    expect(out.filter((o) => 'outcome' in o)).toHaveLength(2);
    expect(out.filter((o) => 'verdict' in o)).toHaveLength(3);
    expect(b.totals('t1').spent).toBe(10000n);
  });
  it('04 a throw releases the reservation (S-42)', async () => {
    const { b } = setup(12000n);
    await expect(b.withReservation(args(1), async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(b.totals('t1')).toMatchObject({ reserved: 0n, remaining: 12000n });
  });
  it('05 explicit release after a failed call', async () => {
    const { b } = setup(12000n);
    await b.withReservation(args(1), async () => ({ outcome: 'released', value: null }));
    expect(b.totals('t1').remaining).toBe(12000n);
  });
  it('held keeps the money reserved (M-52)', async () => {
    const { b } = setup(12000n);
    await b.withReservation(args(1), async () => ({ outcome: 'held', value: null }));
    expect(b.totals('t1')).toMatchObject({ reserved: 5000n, remaining: 7000n });
  });
  it('06 caps and floor refuse with a reason', () => {
    const { b } = setup(50000n, { ...cfg, perSellerCap: '4000' });
    const r = b.reserve(args(1));
    expect(r.ok).toBe(false);
    const f = setup(50000n, { ...cfg, balanceFloor: '999999999999' });
    expect(f.b.reserve(args(1)).ok).toBe(false);
  });
  it('duplicate request id cannot be reserved twice', () => {
    const { b } = setup(50000n);
    expect(b.reserve(args(1)).ok).toBe(true);
    const again = b.reserve(args(1));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.verdict.ruleId).toBe('M-51');
  });
});

describe('invariant (TC-2.2)', () => {
  it('07 seed 42, 300 runs: zero violations', async () => {
    const s = await runInvariant({ seed: 42, runs: 300, cfg });
    expect(s.violations).toBe(0);
    expect(s.chainOk).toBe(true);
    expect(s.calls).toBeGreaterThan(10000);
  }, 120000);
  it('08 reproducible', async () => {
    const a = await runInvariant({ seed: 7, runs: 20, cfg });
    const b = await runInvariant({ seed: 7, runs: 20, cfg });
    expect(JSON.stringify({ ...a, maxSeen: String(a.maxSeen) })).toBe(JSON.stringify({ ...b, maxSeen: String(b.maxSeen) }));
  }, 60000);
  it('09 mutation: removing the release-on-throw makes the test fail', async () => {
    class Faulty extends Budget {
      async withReservation(a: any, fn: any): Promise<any> {
        const r = this.reserve(a);
        if (!r.ok) return { verdict: r.verdict };
        const out = await fn(r.id); // no try/finally: a throw leaks the reservation
        if (out.outcome === 'spent') this.commit(r.id); else if (out.outcome === 'released') this.release(r.id);
        return { value: out.value, outcome: out.outcome };
      }
    }
    const s = await runInvariant({ seed: 42, runs: 5, cfg, factory: (st, c) => new Faulty(st, c) });
    expect(s.violations).toBeGreaterThan(0);
  }, 60000);
});
