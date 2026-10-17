// Logs run through this redactor (M-38): keys, signatures and payment headers never reach a log line.
const PATTERNS: Array<[RegExp, string]> = [
  [/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, '[redacted-hex64]'], // private keys, signatures halves, nonces
  [/0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/g, '[redacted-signature]'],
  [/(payment-signature["']?\s*[:=]\s*["']?)[A-Za-z0-9+/_=-]{20,}/gi, '$1[redacted]'],
  [/(payment-required["']?\s*[:=]\s*["']?)[A-Za-z0-9+/_=-]{20,}/gi, '$1[redacted]'],
  [/(authorization["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, '$1[redacted]'],
  [/AIza[0-9A-Za-z_-]{30,}/g, '[redacted-api-key]'],
  [/(api[_-]?key["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, '$1[redacted]'],
  [/(private[_-]?key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]'],
  [/[A-Za-z0-9+/]{200,}={0,2}/g, '[redacted-blob]'],
];

export function redact(input: string): string {
  let s = input;
  for (const [re, to] of PATTERNS) s = s.replace(re, to);
  return s;
}

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

/** Wraps any sink so every line is redacted before it is written. */
export function createLogger(sink: (line: string) => void = (l) => console.log(l)): LogFn {
  return (level, msg, data) => {
    let tail = '';
    if (data !== undefined) {
      try { tail = ' ' + JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)); } catch { tail = ' [unserializable]'; }
    }
    sink(redact(`${new Date().toISOString()} ${level} ${msg}${tail}`));
  };
}
