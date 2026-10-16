// Field names confirmed against @x402/core 2.28.0 (PaymentRequirements / PaymentRequired, v2).
import { z } from 'zod';

export type ParseCode = 'BAD_BASE64' | 'BAD_JSON' | 'BAD_SHAPE' | 'EMPTY_ACCEPTS' | 'BAD_AMOUNT';

export class ParseError extends Error {
  constructor(
    public code: ParseCode,
    message: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

export interface Accept {
  scheme: string;
  network: string;
  asset: string;
  amount: bigint;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}
export interface PaymentRequiredParsed {
  x402Version: number;
  error?: string;
  resource?: Record<string, unknown>;
  accepts: Accept[];
}

// zod objects strip unknown fields by default: they are ignored, never executed (S-19).
const RawAccept = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.unknown(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number(),
  extra: z.record(z.string(), z.unknown()).default({}),
});
const Raw = z.object({
  x402Version: z.number(),
  error: z.string().optional(),
  resource: z.record(z.string(), z.unknown()).optional(),
  accepts: z.array(z.unknown()),
});

export function decodePaymentRequired(header: string): PaymentRequiredParsed {
  if (typeof header !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(header)) throw new ParseError('BAD_BASE64', 'header is not valid base64');
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw new ParseError('BAD_JSON', 'header is not valid JSON');
  }
  const top = Raw.safeParse(json);
  if (!top.success) throw new ParseError('BAD_SHAPE', 'header is not a payment-required object');
  if (top.data.accepts.length === 0) throw new ParseError('EMPTY_ACCEPTS', 'accepts[] is empty');
  const accepts = top.data.accepts.map((a, i): Accept => {
    const r = RawAccept.safeParse(a);
    if (!r.success) throw new ParseError('BAD_SHAPE', `accepts[${i}] is malformed`);
    const amt = r.data.amount;
    if (typeof amt !== 'string' || !/^\d{1,30}$/.test(amt) || BigInt(amt) === 0n) {
      throw new ParseError('BAD_AMOUNT', `accepts[${i}].amount must be a positive integer string`);
    }
    return { ...r.data, amount: BigInt(amt) };
  });
  return { x402Version: top.data.x402Version, error: top.data.error, resource: top.data.resource, accepts };
}
