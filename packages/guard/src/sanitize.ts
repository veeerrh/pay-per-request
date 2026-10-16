// Seller text is data, never instructions (M-26, M-60, S-37, S-83). The planner only receives typed, short, cleaned values.
const INJECTION: RegExp[] = [
  /\b(ignore|disregard|forget)\b.{0,40}\b(instruction|instructions|budget|previous|above|rules?|limits?)\b/i,
  /\bsystem prompt\b/i,
  /\bpay\s+\d/i,
  /\byou\s+(must|should|need to)\s+(now\s+)?(pay|transfer|send|ignore)\b/i,
  /\boverride\b.{0,20}\b(budget|limit|guard|rules?)\b/i,
];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export const MAX_STRING = 200;

export const looksLikeInjection = (s: string): boolean => INJECTION.some((re) => re.test(s));

export interface Sanitized<T = unknown> {
  value: T;
  quarantined: boolean;
  removed: string[]; // JSON paths of removed fields
}

/** Strips control characters, truncates strings, and removes (quarantines) instruction-like text. */
export function sanitizeForPlanner(input: unknown): Sanitized {
  const removed: string[] = [];
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === 'string') {
      const clean = v.replace(CONTROL, '').slice(0, MAX_STRING);
      if (looksLikeInjection(v)) { removed.push(path); return undefined; }
      return clean;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`)).filter((x) => x !== undefined);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const w = walk(x, `${path}.${k}`);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    return v;
  };
  const value = walk(input, '$');
  return { value, quarantined: removed.length > 0, removed };
}

/** Listing names and descriptions: plain text only, markup removed, instruction-like text replaced (M-60, S-75). */
export function sanitizeListingText(text: string, max = 500): string {
  let t = String(text ?? '').replace(CONTROL, '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, '');
  t = t.replace(/[<>]/g, '');
  if (looksLikeInjection(t)) t = '[removed: instruction-like text]';
  return t.slice(0, max).trim();
}
