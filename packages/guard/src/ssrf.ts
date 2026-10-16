import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export type Lookup = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: Lookup = (host) => dns.lookup(host, { all: true });

/**
 * Resolve-then-check (M-02, S-53). Rejects non-HTTPS, embedded credentials, and any host that resolves to a
 * private, loopback, link-local, unique-local, reserved or unspecified address.
 * `allowPrivate` is the local-development exception (D-29); the services refuse to start with it in demo mode.
 */
export async function assertPublicEndpoint(rawUrl: string, opts: { allowPrivate?: boolean; lookup?: Lookup } = {}): Promise<URL> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new SsrfError('not a valid URL'); }
  if (opts.allowPrivate) {
    if (!['http:', 'https:'].includes(u.protocol)) throw new SsrfError('only http or https is allowed');
    return u;
  }
  if (u.protocol !== 'https:') throw new SsrfError('endpoint must use https');
  if (u.username || u.password) throw new SsrfError('credentials in the URL are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  if (ipaddr.isValid(host)) addrs = [host];
  else {
    try { addrs = (await (opts.lookup ?? defaultLookup)(host)).map((a) => a.address); } catch { throw new SsrfError('host name could not be resolved'); }
  }
  if (!addrs.length) throw new SsrfError('host name did not resolve');
  for (const a of addrs) {
    let range: string;
    try { range = ipaddr.process(a).range(); } catch { throw new SsrfError(`unreadable address ${a}`); }
    if (range !== 'unicast') throw new SsrfError(`host resolves to a ${range} address (${a}), which is not allowed`);
  }
  return u;
}
