import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fromUsdc, formatUsdc, parseUnits, Listing, decodePaymentRequired, ParseError, USDC_ADDRESS } from '../src';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const accept = { scheme: 'exact', network: 'eip155:84532', asset: USDC_ADDRESS, amount: '1000', payTo: '0xc4A183e8fA3d4093ec16D580182ae7056C878643', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } };
const header = (over: object = {}) => b64({ x402Version: 2, resource: { url: 'https://x' }, accepts: [{ ...accept, ...over }] });
const listing = {
  name: 'Atlas', category: 'scraping', endpoint: 'https://example.com/atlas/countries', price: '5000', network: 'eip155:84532',
  asset: USDC_ADDRESS, payTo: '0xc4A183e8fA3d4093ec16D580182ae7056C878643', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, description: 'ok',
};
const code = (fn: () => unknown) => { try { fn(); return 'no-throw'; } catch (e) { return e instanceof ParseError ? e.code : `other:${(e as Error).name}`; } };

describe('money', () => {
  it('TC-1.1-01 conversions', () => {
    expect(fromUsdc('0.005')).toBe(5000n);
    expect(formatUsdc(5000n)).toBe('0.005');
    expect(fromUsdc('0.1')).toBe(100000n);
  });
  it('TC-1.1-02 rejects floats and signs', () => {
    for (const s of ['0.5', '-1', '1e3', '1,000', '']) expect(() => parseUnits(s)).toThrow();
  });
  it('TC-1.1-03 round trip property', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 100_000_000n }), (x) => fromUsdc(formatUsdc(x)) === x), { numRuns: 1000 });
  });
});

describe('listing', () => {
  it('TC-1.1-04 accepts and checksums', () => {
    const l = Listing.parse({ ...listing, payTo: listing.payTo.toLowerCase() });
    expect(l.payTo).toBe(listing.payTo);
    expect(l.method).toBe('GET');
  });
  it('TC-1.1-05 rejections', () => {
    const bad: object[] = [
      { price: '100001' }, { network: 'eip155:8453' }, { asset: 'USDC' }, { endpoint: 'http://x.com' },
      { payTo: '0x123' }, { outputSchema: { type: 5 } }, { category: 'other' },
    ];
    for (const o of bad) expect(Listing.safeParse({ ...listing, ...o }).success, JSON.stringify(o)).toBe(false);
  });
});

describe('payment-required decode', () => {
  it('TC-1.1-06 positive', () => {
    const p = decodePaymentRequired(header());
    expect(p.accepts[0].amount).toBe(1000n);
  });
  it('TC-1.1-07 typed failures', () => {
    expect(code(() => decodePaymentRequired('!!notbase64'))).toBe('BAD_BASE64');
    expect(code(() => decodePaymentRequired(Buffer.from('nope').toString('base64')))).toBe('BAD_JSON');
    expect(code(() => decodePaymentRequired(b64({})))).toBe('BAD_SHAPE');
    expect(code(() => decodePaymentRequired(b64({ x402Version: 2, accepts: [] })))).toBe('EMPTY_ACCEPTS');
    for (const amount of ['1.5', '-5', '0', '1e3']) expect(code(() => decodePaymentRequired(header({ amount })))).toBe('BAD_AMOUNT');
  });
  it('TC-1.1-08 unknown fields dropped', () => {
    const p = decodePaymentRequired(header({ run: 'rm -rf' }));
    expect('run' in p.accepts[0]).toBe(false);
  });
  it('TC-1.1-09 fuzz: only ParseError', () => {
    fc.assert(fc.property(fc.string(), (s) => { const c = code(() => decodePaymentRequired(s)); return c === 'no-throw' || !c.startsWith('other'); }), { numRuns: 500 });
    fc.assert(fc.property(fc.jsonValue(), (j) => { const c = code(() => decodePaymentRequired(b64(j))); return c === 'no-throw' || !c.startsWith('other'); }), { numRuns: 500 });
  });
});
