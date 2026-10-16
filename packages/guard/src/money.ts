// All money is bigint units (USDC has 6 decimals). Floats never touch money (X-14).
export const NETWORK = 'eip155:84532';
export const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const MAX_PRICE = 100000n; // 0.10 USDC (P-17)
export const UNITS_PER_USDC = 1_000_000n;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Digits only: "5000" -> 5000n. Rejects signs, decimals, exponents, separators, empty. */
export function parseUnits(s: string): bigint {
  if (typeof s !== 'string' || !/^\d{1,30}$/.test(s)) throw new MoneyError(`not a unit amount: ${JSON.stringify(s)}`);
  return BigInt(s);
}

/** "0.005" -> 5000n. At most 6 decimals. */
export function fromUsdc(s: string): bigint {
  if (typeof s !== 'string' || !/^\d{1,15}(\.\d{1,6})?$/.test(s)) throw new MoneyError(`not a USDC amount: ${JSON.stringify(s)}`);
  const [w, f = ''] = s.split('.');
  return BigInt(w) * UNITS_PER_USDC + BigInt((f + '000000').slice(0, 6));
}

/** 5000n -> "0.005". Always at least 3 decimals; further trailing zeros trimmed. */
export function formatUsdc(u: bigint): string {
  if (u < 0n) throw new MoneyError('negative amount');
  const w = u / UNITS_PER_USDC;
  let f = (u % UNITS_PER_USDC).toString().padStart(6, '0');
  while (f.length > 3 && f.endsWith('0')) f = f.slice(0, -1);
  return `${w}.${f}`;
}

export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
