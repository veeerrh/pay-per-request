import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { USDC_ADDRESS } from '../../src';

export type Mode =
  | 'honest' | 'overprice' | 'wrongPayTo' | 'wrongAsset' | 'wrongNetwork' | 'multiAccepts' | 'redirect' | 'redirectPaid'
  | 'changeTerms' | 'hang' | 'error5xx' | 'junk' | 'noPaymentResponse' | 'bigBody';

export const SELLER_PAYTO = '0xc4A183e8fA3d4093ec16D580182ae7056C878643';
const OTHER = '0x000000000000000000000000000000000000dEaD';

const accept = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: 'eip155:84532', asset: USDC_ADDRESS, amount: '1000', payTo: SELLER_PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' }, ...over,
});
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

export interface FakeSeller {
  url: string;
  hits: { unpaid: number; paid: number };
  paidHeaders: string[];
  close(): Promise<void>;
}

export async function startFakeSeller(mode: Mode, opts: { redirectTo?: string; price?: string; ask?: string } = {}): Promise<FakeSeller> {
  const price = opts.price ?? '1000';
  const hits = { unpaid: 0, paid: 0 };
  const paidHeaders: string[] = [];
  const open: Array<http.ServerResponse> = [];
  const server = http.createServer((req, res) => {
    const sig = req.headers['payment-signature'];
    if (!sig) {
      hits.unpaid++;
      if (mode === 'redirect') { res.writeHead(302, { location: opts.redirectTo ?? 'http://127.0.0.1:1/' }); return res.end(); }
      let accepts: unknown[] = [accept({ amount: price })];
      if (mode === 'overprice') accepts = [accept({ amount: opts.ask ?? '10000' })];
      if (mode === 'wrongPayTo') accepts = [accept({ amount: price, payTo: OTHER })];
      if (mode === 'wrongAsset') accepts = [accept({ amount: price, asset: '0x1111111111111111111111111111111111111111' })];
      if (mode === 'wrongNetwork') accepts = [accept({ amount: price, network: 'eip155:8453' })];
      if (mode === 'multiAccepts') accepts = [accept({ amount: '9000' }), accept({ amount: price })];
      if (mode === 'changeTerms') accepts = [accept({ amount: hits.unpaid === 1 ? price : '1' })];
      res.writeHead(402, { 'payment-required': b64({ x402Version: 2, resource: { url: 'https://example.test/x' }, accepts }), 'content-type': 'application/json' });
      return res.end('{}');
    }
    hits.paid++;
    paidHeaders.push(String(sig));
    const settled = { 'payment-response': b64({ success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:84532', payer: '0xADb43a17Cb94d4125f45522d815060B58A71dcCb' }), 'content-type': 'application/json' };
    if (mode === 'hang') { open.push(res); return; }
    if (mode === 'error5xx') { res.writeHead(500); return res.end('{"error":"boom"}'); }
    if (mode === 'redirectPaid') { res.writeHead(302, { location: opts.redirectTo ?? 'http://127.0.0.1:1/' }); return res.end(); }
    if (mode === 'noPaymentResponse') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (mode === 'bigBody') { res.writeHead(200, settled); return res.end('{"pad":"' + 'x'.repeat(1_000_000) + '"}'); }
    if (mode === 'junk') { res.writeHead(200, settled); return res.end('this is not json'); }
    res.writeHead(200, settled);
    res.end('{"ok":true,"data":[1,2,3]}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  return {
    url, hits, paidHeaders,
    close: () => new Promise<void>((r) => { open.forEach((o) => o.destroy()); server.closeAllConnections(); server.close(() => r()); }),
  };
}
