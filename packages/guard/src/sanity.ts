// Content checks beyond the JSON Schema (M-70, S-35): a well-formed answer can still be absurd.
export interface SanityContext {
  now?: Date;
  top?: number;
  country?: string;
  days?: number;
  minMag?: number;
  countries?: string[];
  knownCountries?: string[];
}
export type SanityKind = 'atlas' | 'tremor' | 'brief';
type Check = (out: any, ctx: SanityContext) => string | null;

const atlas: Check = (out, ctx) => {
  const list = out?.countries;
  if (!Array.isArray(list) || list.length === 0) return 'no countries returned';
  if (ctx.top !== undefined && list.length !== ctx.top) return `expected ${ctx.top} countries, got ${list.length}`;
  for (const c of list) {
    if (!Number.isFinite(c.population) || c.population <= 0) return `country ${c.name}: population must be above zero`;
    if (c.area_km2 !== undefined && !(c.area_km2 > 0)) return `country ${c.name}: area must be above zero`;
  }
  return null;
};

const tremor: Check = (out, ctx) => {
  if (ctx.country && String(out?.country).toLowerCase() !== ctx.country.toLowerCase()) return `answer is for ${out?.country}, not ${ctx.country}`;
  const now = (ctx.now ?? new Date()).getTime();
  const slack = 3_600_000;
  for (const q of out?.quakes ?? []) {
    if (!(q.magnitude >= 0 && q.magnitude <= 10)) return `magnitude ${q.magnitude} is outside 0 to 10`;
    if (ctx.minMag !== undefined && q.magnitude < ctx.minMag) return `magnitude ${q.magnitude} is below the requested minimum ${ctx.minMag}`;
    if (ctx.days !== undefined) {
      const t = Date.parse(q.time);
      if (!Number.isFinite(t)) return 'quake time is not a valid date';
      if (t < now - ctx.days * 86_400_000 - slack || t > now + slack) return `quake time ${q.time} is outside the requested ${ctx.days} day window`;
    }
  }
  return null;
};

const brief: Check = (out, ctx) => {
  const list = out?.briefs;
  if (!Array.isArray(list) || list.length === 0) return 'no briefs returned';
  if (ctx.countries && list.length !== ctx.countries.length) return `expected ${ctx.countries.length} briefs, got ${list.length}`;
  for (const b of list) {
    if (!['low', 'medium', 'high'].includes(b.readiness)) return `readiness "${b.readiness}" is not low, medium or high`;
    if (ctx.knownCountries && !ctx.knownCountries.includes(b.country)) return `country "${b.country}" is not in the list that was bought`;
  }
  return null;
};

const CHECKS: Record<SanityKind, Check> = { atlas, tremor, brief };
export const sanityCheck = (kind: SanityKind | undefined, out: unknown, ctx: SanityContext): string | null => (kind ? CHECKS[kind](out, ctx) : null);
