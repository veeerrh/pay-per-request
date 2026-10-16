import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RulesConfig } from './config';

/** JSON with sorted keys, so equal configs always hash the same. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** sha256 over the canonical config plus the contents of the rule files (M-63, A-21). */
export function ruleSetHash(cfg: RulesConfig, rulesDir: string = join(__dirname, 'rules')): string {
  const h = createHash('sha256');
  h.update(stableStringify(cfg));
  for (const f of readdirSync(rulesDir).filter((n) => /\.(js|ts)$/.test(n) && !n.endsWith('.d.ts') && !n.endsWith('.map')).sort()) {
    h.update(`\n#${f}\n`);
    h.update(readFileSync(join(rulesDir, f)));
  }
  return h.digest('hex');
}
