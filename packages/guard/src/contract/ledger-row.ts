import { z } from 'zod';

export const LedgerRow = z.object({
  id: z.string(),
  callNo: z.number().int().positive(),
  taskId: z.string(),
  time: z.string(),
  buyer: z.string(),
  sellerId: z.string(),
  seller: z.string(),
  category: z.enum(['data', 'inference', 'scraping']),
  listed: z.string().regex(/^\d+$/),
  asked: z.string().regex(/^\d+$/),
  paid: z.string().regex(/^\d+$/),
  status: z.enum(['paid', 'refused', 'failed', 'rejected', 'pending']),
  latencyMs: z.number().int().nonnegative(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(),
  txConfirmed: z.boolean(),
  ruleId: z.string(),
  reason: z.string(),
  listingHash: z.string(),
  ruleSetHash: z.string(),
});
export type LedgerRow = z.infer<typeof LedgerRow>;
