import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { scanText, scanFiles } = require('../lib/secrets.js');
const fakeKey = '0x' + 'ab'.repeat(32);

describe('key hygiene scans (TC-8.2)', () => {
  it('flags a key assigned to a key-like name', () => {
    expect(scanText(`BEACON_PRIVATE_KEY=${fakeKey}`)).toHaveLength(1);
    expect(scanText(`const privateKey = "${fakeKey}"`)).toHaveLength(1);
  });
  it('does not flag a bare transaction hash (public evidence)', () => {
    expect(scanText(`tx: ${fakeKey}`)).toHaveLength(0);
    expect(scanText(`https://sepolia.basescan.org/tx/${fakeKey}`)).toHaveLength(0);
  });
  it('flags payment headers, PEM keys and long blobs', () => {
    expect(scanText(`PAYMENT-SIGNATURE: ${'A'.repeat(80)}`)).toHaveLength(1);
    expect(scanText('-----BEGIN PRIVATE KEY-----')).toHaveLength(1);
    expect(scanText('x'.repeat(10) + 'A'.repeat(320))).toHaveLength(1);
  });
  it('finds a planted key in a bundle-like file and in a log, with file and line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-'));
    writeFileSync(join(dir, 'x.js'), `// ok\nconst PRIVATE_KEY = '${fakeKey}';\n`);
    writeFileSync(join(dir, 'a.log'), `line one\nauthorization: ${'Z'.repeat(80)}\n`);
    const hits = scanFiles([join(dir, 'x.js'), join(dir, 'a.log')], { exact: false });
    expect(hits.map((h) => h.line)).toEqual([2, 2]);
  });
  it('clean text passes', () => {
    expect(scanText('const price = 5000; // units')).toHaveLength(0);
  });
});
