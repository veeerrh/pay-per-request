import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
describe('sqlite smoke', () => {
  it('opens, inserts and reads', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t(v) VALUES (?)').run('ok');
    expect((db.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('ok');
  });
});
