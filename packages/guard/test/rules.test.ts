import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, evaluateHeader, compareTerms, USDC_ADDRESS, type Facts, type Accept } from '../src';
import mutations from './fixtures/402-mutations.json';

const SELLER = '0xc4A183e8fA3d4093ec16D580182ae7056C878643';
const BUYER = '0xADb43a17Cb94d4125f45522d815060B58A71dcCb';
const honest = (): Accept => ({ scheme: 'exact', network: 'eip155:84532', asset: USDC_ADDRESS, amount: 1000n, payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } });
const facts = (over: Partial<Facts> = {}): Facts => ({
  listing: { price: 1000n, payTo: SELLER, network: 'eip155:84532', asset: USDC_ADDRESS },
  snapshotHash: 'h1', liveListingHash: 'h1', accepts: [honest()], buyerAddress: BUYER,
  config: { maxTimeoutSeconds: 120, oddDropRatioPct: 50 }, ...over,
});

function apply(a: Accept, patch: Record<string, unknown> | undefined, ctx: { buyer: string }): Accept {
  const p = { ...(patch ?? {}) } as Record<string, unknown>;
  if (p.payTo === 'BUYER') p.payTo = ctx.buyer;
  if (typeof p.amount === 'string') p.amount = /^\d+$/.test(p.amount) && p.amount !== '0' ? BigInt(p.amount) : p.amount;
  return { ...a, ...p } as Accept;
}

describe('TC-1.2 table-driven mutation suite (S-05..S-26)', () => {
  for (const m of mutations as any[]) {
    it(`${m.id} ${m.name}`, () => {
      const f = facts();
      if (m.listed) f.listing.price = BigInt(m.listed);
      if (m.listedPayTo === 'BUYER') f.listing.payTo = BUYER;
      let ev;
      if (m.header !== undefined) ev = evaluateHeader(m.header, f);
      else if (m.accepts !== undefined) ev = evaluate({ ...f, accepts: m.accepts.map((e: any) => apply(honest(), e.patch, { buyer: BUYER })) });
      else {
        const a = apply(honest(), m.patch, { buyer: BUYER });
        // amounts that the decoder itself rejects go through the header path, like a real 402
        if (typeof a.amount !== 'bigint') {
          const hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ ...a, amount: String(a.amount) }] })).toString('base64');
          ev = evaluateHeader(hdr, f);
        } else ev = evaluate({ ...f, accepts: [a] });
      }
      expect(ev.decision.verdict).toBe(m.expect.verdict);
      if (m.expect.ruleId) expect(ev.decision.ruleId).toBe(m.expect.ruleId);
      if (m.expect.suspend) expect(ev.decision.suspend).toBe(true);
      if (m.expect.alarm) expect(ev.decision.alarm).toBe(true);
      if (m.expect.chosenIndex !== undefined) expect(ev.chosenIndex).toBe(m.expect.chosenIndex);
      if (m.expect.noteIncludes) expect(ev.verdicts.some((v) => (v.note ?? '').includes(m.expect.noteIncludes))).toBe(true);
    });
  }
});

describe('TC-1.2 other', () => {
  it('01 honest 402 allowed', () => {
    const ev = evaluate(facts());
    expect(ev.decision.verdict).toBe('ALLOW');
    expect(ev.verdicts.some((v) => v.verdict === 'REFUSE')).toBe(false);
  });
  it('02 price lie reason names the multiple', () => {
    const ev = evaluate(facts({ accepts: [{ ...honest(), amount: 10000n }] }));
    expect(ev.decision.reason).toContain('10 times');
  });
  it('12 changed terms detected (S-24)', () => {
    expect(compareTerms([honest()], [honest()])).toBeNull();
    expect(compareTerms([honest()], [{ ...honest(), amount: 2000n }])?.ruleId).toBe('S-24');
  });
  it('13 purity: same input same output, no I/O in rule files', () => {
    const f = facts({ accepts: [{ ...honest(), amount: 5000n }] });
    expect(JSON.stringify(evaluate(f))).toBe(JSON.stringify(evaluate(f)));
    const dir = join(__dirname, '..', 'src', 'rules');
    for (const file of readdirSync(dir)) {
      const src = readFileSync(join(dir, file), 'utf8');
      expect(src, file).not.toMatch(/fetch\(|node:fs|require\('fs'\)|Date\.now|new Date|Math\.random/);
    }
  });
  it('14 listing edited mid-task keeps the snapshot (S-73)', () => {
    const ev = evaluate(facts({ liveListingHash: 'h2' }));
    expect(ev.decision.verdict).toBe('ALLOW');
    expect(ev.verdicts.some((v) => v.ruleId === 'M-54')).toBe(true);
  });
});
