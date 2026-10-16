export interface HttpResult {
  status: number;
  headers: Headers;
  body: string;
  truncated: boolean;
}

export class HttpError extends Error {
  constructor(public kind: 'timeout' | 'network' | 'too_large', message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * One request with an abort timeout, manual redirects (a 3xx is returned as-is, never followed)
 * and a streamed body read with a byte cap (M-25, S-25, S-36).
 */
export async function limitedFetch(
  f: typeof fetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  opt: { timeoutMs: number; maxBytes: number },
): Promise<HttpResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opt.timeoutMs);
  try {
    const res = await f(url, { ...init, redirect: 'manual', signal: ac.signal });
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > opt.maxBytes) { truncated = true; await reader.cancel(); break; }
        chunks.push(value);
      }
    }
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), truncated };
  } catch (e) {
    if (ac.signal.aborted) throw new HttpError('timeout', `no complete response within ${opt.timeoutMs} ms`);
    throw new HttpError('network', (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
