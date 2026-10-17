import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadConfig, runStep, USDC_ADDRESS, type SellerListing, type PayResult } from '../src';

const cfg = { ...loadConfig(join(__dirname, '..', '..', '..', 'config', 'rules.config.json')), balanceFloor: '0' };
const BUYER = '0xADb43a17Cb94d4125f45522d815060B58A71dcCb';
const PAYTO = '0x1111111111111111111111111111111111111111';
const L = (id: string, price: bigint): SellerListing => ({ id, name: id, category: 'data', price, payTo: PAYTO, endpoint: `http://x/${id}`, listingHash: `h-${id}` });
const LISTINGS = [L('a', 1000n), L('b', 2000n), L('c', 3000n)];
const paid = (price: bigint): PayResult => ({ status: 'paid', paid: price, verdict: 'ALLOW', ruleId: 'none', reason: '', output: {}, requestId: 'r' } as unknown as PayResult);

async function run(prefer?: () => string | undefined, failFirst = false) {
  const tried: string[] = [];
  const out = await runStep({
    category: 'data', listings: LISTINGS, reputation: new Map(), exclusions: new Set(), remaining: () => 50000n, buyerAddress: BUYER, cfg, spentBySeller: new Map(), prefer,
    pay: async (c) => {
      tried.push(c.id);
      if (failFirst && tried.length === 1) return { ...paid(0n), status: 'failed', paid: 0n, reason: 'down' } as unknown as PayResult;
      return paid(c.price);
    },
  });
  return { tried, out };
}

describe('runStep prefer hook (buyer agent preference)', () => {
  it('01 without a preference the ranking decides (cheapest first when all are unproven)', async () => {
    expect((await run()).tried).toEqual(['a']);
  });
  it('02 an eligible preferred seller goes first', async () => {
    expect((await run(() => 'c')).tried).toEqual(['c']);
  });
  it('03 an unknown or empty preference is ignored: it cannot add a seller', async () => {
    expect((await run(() => 'ghost')).tried).toEqual(['a']);
    expect((await run(() => undefined)).tried).toEqual(['a']);
  });
  it('04 after the preferred seller fails the rest follow in rank order', async () => {
    expect((await run(() => 'c', true)).tried).toEqual(['c', 'a']);
  });
  it('05 a preferred seller that is not affordable is not tried', async () => {
    const tried: string[] = [];
    await runStep({
      category: 'data', listings: LISTINGS, reputation: new Map(), exclusions: new Set(), remaining: () => 1500n, buyerAddress: BUYER, cfg, spentBySeller: new Map(), prefer: () => 'c',
      pay: async (c) => { tried.push(c.id); return paid(c.price); },
    });
    expect(tried).toEqual(['a']);
    expect(USDC_ADDRESS).toBeTruthy();
  });
});
