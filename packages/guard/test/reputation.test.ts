import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadConfig, computeReputation, compareSellers, newSellerReputation, classify, type LedgerLike } from '../src';

const cfg = loadConfig(join(__dirname, '..', '..', '..', 'config', 'rules.config.json'));
const NOW = Date.parse('2026-10-17T12:00:00Z');
let n = 0;
const row = (sellerId: string, status: string, ruleId = '', over: Partial<LedgerLike> = {}): LedgerLike => ({
  sellerId, category: 'data', status, ruleId, listed: '2000', latencyMs: 500, time: new Date(NOW - 10 * 60_000).toISOString(), callNo: ++n, ...over,
});
const rep = (rows: LedgerLike[]) => computeReputation(rows, cfg, NOW);

describe('reputation (TC-4.1)', () => {
  it('01 cold start: all unproven and tied, so price decides', () => {
    const rs = ['a', 'b', 'c'].map((id, i) => ({ id, price: BigInt(5000 - i * 1000), rep: newSellerReputation(id, cfg) }));
    expect(rs.sort(compareSellers).map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(rs.every((r) => r.rep.status === 'probation')).toBe(true);
  });
  it('02 three price lies: dropped, headline 0, suspended', () => {
    const r = rep([row('x', 'refused', 'M-17'), row('x', 'refused', 'M-17'), row('x', 'refused', 'M-17')]).get('x')!;
    expect(r).toMatchObject({ status: 'dropped', headline: 0, fraud: 3, suspended: true });
  });
  it('03 one junk on a new seller stays on probation with a lower score', () => {
    const r = rep([row('h', 'rejected', 'M-24')]);
    expect(r.get('h')!.status).toBe('probation');
    expect(r.get('h')!.score).toBeLessThan(newSellerReputation('z', cfg).score);
  });
  it('04 weights: fraud costs more than availability', () => {
    const r = rep([row('A', 'refused', 'S-06'), row('A', 'refused', 'S-06'), row('B', 'failed', 'M-29'), row('B', 'failed', 'M-29')]);
    expect(r.get('A')!.score).toBeLessThan(r.get('B')!.score);
  });
  it('05 shrinkage: a long clean record outranks one lucky call', () => {
    const rows = [row('X', 'paid'), ...Array.from({ length: 40 }, () => row('Y', 'paid')), row('Y', 'failed'), row('Y', 'failed')];
    const m = rep(rows);
    expect(compareSellers({ id: 'Y', price: 1n, rep: m.get('Y')! }, { id: 'X', price: 1n, rep: m.get('X')! })).toBeLessThan(0);
  });
  it('06 window of 50: old failures fall out', () => {
    const rows = [...Array.from({ length: 10 }, () => row('W', 'failed')), ...Array.from({ length: 50 }, () => row('W', 'paid'))];
    expect(rep(rows).get('W')).toMatchObject({ attempts: 50, clean: 50, availability: 0 });
  });
  it('07 budget refusals and self payment are not held against a seller', () => {
    const r = rep([row('E', 'refused', 'M-15'), row('E', 'refused', 'M-58'), row('E', 'refused', 'S-26'), row('E', 'paid')]).get('E')!;
    expect(r).toMatchObject({ attempts: 1, clean: 1, fraud: 0 });
    expect(classify(row('E', 'refused', 'M-15'))).toBe('excluded');
  });
  it('08 recompute is deterministic and order independent (S-70)', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`s${i % 4}`, ['paid', 'failed', 'rejected', 'paid'][i % 4]));
    const a = rep(rows), b = rep([...rows].reverse());
    const ser = (m: Map<string, unknown>) => JSON.stringify([...m].sort((x, y) => (x[0] < y[0] ? -1 : 1)), (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(ser(a)).toBe(ser(b));
  });
  it('09 medians including an even count', () => {
    const r = rep([row('M', 'paid', '', { latencyMs: 100 }), row('M', 'paid', '', { latencyMs: 300 }), row('M', 'paid', '', { latencyMs: 900 }), row('M', 'paid', '', { latencyMs: 500 })]).get('M')!;
    expect(r.medianLatencyMs).toBe(400);
    expect(r.medianPrice).toBe(2000n);
  });
  it('malformed 402 counts as availability, a price lie as fraud', () => {
    expect(classify(row('q', 'refused', 'S-19'))).toBe('availability');
    expect(classify(row('q', 'refused', 'M-17'))).toBe('fraud');
  });
  it('cooling off ends the suspension', () => {
    const old = row('F', 'refused', 'S-06', { time: new Date(NOW - 3600_000).toISOString() });
    expect(rep([old]).get('F')!.suspended).toBe(false);
  });
});
