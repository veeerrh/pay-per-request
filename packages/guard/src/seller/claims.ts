import Database from 'better-sqlite3';

/**
 * One authorisation unlocks one response (M-28, M-72, X-08). The claim is a unique-key insert made
 * BEFORE any work runs, so five parallel replays of one header produce exactly one winner.
 */
export class ClaimStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS nonce_claims(nonce TEXT PRIMARY KEY, payer TEXT, claimed_at TEXT NOT NULL)');
  }
  /** True if this call won the claim. */
  claim(nonce: string, payer = ''): boolean {
    try {
      this.db.prepare('INSERT INTO nonce_claims(nonce, payer, claimed_at) VALUES (?,?,?)').run(nonce.toLowerCase(), payer, new Date().toISOString());
      return true;
    } catch (e) {
      if (String((e as { code?: string }).code).startsWith('SQLITE_CONSTRAINT')) return false;
      throw e;
    }
  }
  /** Gives the claim back when the work failed and nothing was settled (M-30). */
  release(nonce: string): void {
    this.db.prepare('DELETE FROM nonce_claims WHERE nonce=?').run(nonce.toLowerCase());
  }
  has(nonce: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM nonce_claims WHERE nonce=?').get(nonce.toLowerCase());
  }
  close(): void { this.db.close(); }
}
