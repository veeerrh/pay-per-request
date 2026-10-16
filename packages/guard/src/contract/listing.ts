import { z } from 'zod';
import { getAddress, isAddress } from 'viem';
import { MAX_PRICE, NETWORK, USDC_ADDRESS } from '../money';
import { compileSchema } from '../schema';

const address = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), 'invalid address')
  .transform((s) => getAddress(s.toLowerCase()));

const jsonSchema = z.record(z.string(), z.unknown()).superRefine((s, ctx) => {
  try {
    compileSchema(s);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: `schema does not compile: ${(e as Error).message}` });
  }
});

export const Listing = z.object({
  name: z.string().min(1).max(80),
  category: z.enum(['data', 'inference', 'scraping']),
  endpoint: z.string().url().refine((u) => u.startsWith('https://'), 'endpoint must be https'),
  method: z.enum(['GET', 'POST']).default('GET'),
  price: z
    .string()
    .regex(/^\d{1,9}$/, 'price must be a digit string')
    .refine((p) => BigInt(p) > 0n && BigInt(p) <= MAX_PRICE, 'price must be 1..100000 units'),
  network: z.literal(NETWORK),
  asset: z.string().refine((a) => a.toLowerCase() === USDC_ADDRESS.toLowerCase(), 'asset must be the Base Sepolia USDC address'),
  payTo: address,
  inputSchema: jsonSchema,
  outputSchema: jsonSchema,
  description: z.string().max(500),
  labels: z.array(z.string().max(30)).max(5).default([]),
});
export type Listing = z.infer<typeof Listing>;
