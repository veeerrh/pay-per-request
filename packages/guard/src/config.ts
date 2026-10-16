import { readFileSync } from 'node:fs';
import { z } from 'zod';

const units = z.string().regex(/^\d{1,15}$/, 'must be a digit string of units');

export const RulesConfig = z.object({
  maxTimeoutSeconds: z.number().int().positive().max(3600),
  oddDropRatioPct: z.number().int().min(0).max(100),
  perCallCeiling: units,
  fallbackLimit: z.number().int().min(1).max(10),
  probationAttempts: z.number().int().min(1),
  dropThreshold: z.number().min(0).max(1),
  reputationWindow: z.number().int().min(1),
  weights: z.object({ fraud: z.number().positive(), junk: z.number().positive(), availability: z.number().positive() }),
  coolingOffSeconds: z.number().int().nonnegative(),
  perTaskCallLimit: z.number().int().positive(),
  perTaskWallClockSeconds: z.number().int().positive(),
  perSellerCap: units,
  perCategoryCap: units,
  sessionCap: units,
  rollingHourCap: units,
  balanceFloor: units,
  probationSpendCap: units,
  requestTimeoutMs: z.number().int().positive(),
  maxBodyBytes: z.number().int().positive(),
});
export type RulesConfig = z.infer<typeof RulesConfig>;

/** Loads and validates the config. A bad value throws, so the service refuses to start (TC-1.3-07). */
export function loadConfig(path: string): RulesConfig {
  const parsed = RulesConfig.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid rules config: ${msg}`);
  }
  return parsed.data;
}
