import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SERVICES, buildEnv } = require('../lib/services.js');

const PARENT = {
  PATH: 'x', GEMINI_API_KEY: 'beacon-key', BEACON_GEMINI_API_KEY: 'beacon-own-key', ATLAS_GEMINI_API_KEY: 'atlas-key', TREMOR_GEMINI_API_KEY: 'tremor-key', BRIEF_GEMINI_API_KEY: 'brief-key',
  BEACON_PRIVATE_KEY: '0xwallet', OPERATOR_TOKEN: 'tok',
};
const envOf = (name) => buildEnv(SERVICES.find((s) => s.name === name), PARENT);
const keyNames = (env) => Object.keys(env).filter((k) => /KEY|TOKEN/.test(k)).sort();

describe('model keys stay with their own agent (T-09)', () => {
  it('01 Atlas receives only its own key', () => {
    expect(keyNames(envOf('atlas'))).toEqual(['ATLAS_GEMINI_API_KEY']);
  });
  it('02 Beacon receives its keys and no seller key', () => {
    const k = keyNames(envOf('beacon'));
    expect(k).toEqual(expect.arrayContaining(['GEMINI_API_KEY', 'BEACON_PRIVATE_KEY']));
    expect(k).not.toContain('ATLAS_GEMINI_API_KEY');
    expect(k).not.toContain('TREMOR_GEMINI_API_KEY');
    expect(k).not.toContain('BRIEF_GEMINI_API_KEY');
  });
  it('03 no seller, registry or gateway process receives a wallet key, the operator token or the shared model key', () => {
    for (const s of SERVICES.filter((x) => x.name !== 'beacon')) {
      const env = buildEnv(s, PARENT);
      expect(env.BEACON_PRIVATE_KEY, s.name).toBeUndefined();
      expect(env.OPERATOR_TOKEN, s.name).toBeUndefined();
      expect(env.GEMINI_API_KEY, s.name).toBeUndefined();
    }
  });
  it('04 a seller never receives another agent\'s model key', () => {
    for (const s of SERVICES.filter((x) => x.name !== 'beacon')) {
      const env = buildEnv(s, PARENT);
      for (const other of ['ATLAS', 'TREMOR', 'BRIEF', 'BEACON']) {
        if (s.name.toUpperCase() !== other) expect(env[`${other}_GEMINI_API_KEY`], `${s.name} got ${other}'s key`).toBeUndefined();
      }
    }
  });
});
