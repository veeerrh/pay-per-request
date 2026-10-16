import { describe, it, expect } from 'vitest';
import { assertPublicEndpoint, SsrfError } from '../src';

const lookupTo = (address: string) => async () => [{ address }];
const bad = async (url: string, addr = '93.184.216.34') => { try { await assertPublicEndpoint(url, { lookup: lookupTo(addr) }); return 'ok'; } catch (e) { return e instanceof SsrfError ? e.message : 'other'; } };

describe('SSRF guard (M-02, S-53)', () => {
  it('accepts a public https host', async () => expect(await bad('https://example.com/x')).toBe('ok'));
  it('rejects http', async () => expect(await bad('http://example.com/x')).toContain('https'));
  it('rejects private, loopback, link-local and reserved IP literals', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.9', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
      expect(await bad(`https://${ip}/x`), ip).toContain('not allowed');
    }
    expect(await bad('https://[::1]/x')).toContain('not allowed');
    expect(await bad('https://[::ffff:127.0.0.1]/x')).toContain('not allowed');
  });
  it('rejects a host name that resolves to a private address (DNS rebinding shape)', async () => {
    expect(await bad('https://evil.example/x', '127.0.0.1')).toContain('not allowed');
    expect(await bad('https://evil.example/x', '10.1.2.3')).toContain('not allowed');
  });
  it('rejects credentials and unresolvable hosts', async () => {
    expect(await bad('https://user:pw@example.com/x')).toContain('credentials');
    await expect(assertPublicEndpoint('https://nope.example/x', { lookup: async () => { throw new Error('ENOTFOUND'); } })).rejects.toThrow(/resolved/);
  });
  it('local development may allow http localhost only when explicitly enabled', async () => {
    await expect(assertPublicEndpoint('http://localhost:4011/countries', { allowPrivate: true })).resolves.toBeTruthy();
    await expect(assertPublicEndpoint('http://localhost:4011/countries')).rejects.toThrow();
  });
});
