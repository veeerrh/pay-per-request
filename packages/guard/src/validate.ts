import { compileSchema } from './schema';
import { sanityCheck, type SanityContext, type SanityKind } from './sanity';
import { sanitizeForPlanner } from './sanitize';
import type { ValidateFn } from './pay';

export interface ValidatorOptions {
  outputSchema: unknown;
  sanity?: SanityKind;
  context?: SanityContext;
}

/** Builds the validator guard.pay() runs on every paid response: schema, then content sanity, then injection quarantine. */
export function makeValidator(o: ValidatorOptions): ValidateFn {
  const schema = compileSchema(o.outputSchema);
  return (body) => {
    let json: unknown;
    try { json = JSON.parse(body); } catch { return { ok: false, reason: 'response was not valid JSON', ruleId: 'M-24' }; }
    if (!schema(json)) {
      const e = schema.errors?.[0];
      const where = e?.instancePath || (e?.params as { missingProperty?: string } | undefined)?.missingProperty || 'output';
      return { ok: false, reason: `output failed the listed schema at ${where}: ${e?.message ?? 'invalid'}`, ruleId: 'M-24' };
    }
    const bad = sanityCheck(o.sanity, json, o.context ?? {});
    if (bad) return { ok: false, reason: `output failed a content check: ${bad}`, ruleId: 'M-70' };
    const clean = sanitizeForPlanner(json);
    if (clean.quarantined) return { ok: false, reason: `output contained instruction-like text at ${clean.removed.join(', ')}; quarantined`, ruleId: 'S-37' };
    return { ok: true, output: clean.value };
  };
}
