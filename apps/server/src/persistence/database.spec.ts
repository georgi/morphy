import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  resolveDbPath,
  SCHEMA_VERSION,
  type Db,
} from './database';

describe('database', () => {
  describe('schema', () => {
    let db: Db;
    beforeEach(() => {
      db = openDatabase(':memory:');
    });
    afterEach(() => db.close());

    it('creates all four tables plus schema_version', () => {
      const names = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'games',
          'collections',
          'eval_cache',
          'import_jobs',
          'schema_version',
        ]),
      );
    });

    it('records the current schema_version', () => {
      const row = db
        .prepare('SELECT version FROM schema_version LIMIT 1')
        .get() as { version: number };
      expect(row.version).toBe(SCHEMA_VERSION);
    });

    it('creates the expected indexes', () => {
      const idx = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(idx).toEqual(
        expect.arrayContaining([
          'idx_games_white',
          'idx_games_black',
          'idx_games_eco',
          'idx_games_source',
          'idx_games_collection',
          'idx_games_created_at',
        ]),
      );
    });

    it('migrate is idempotent (re-running does not duplicate schema_version or error)', () => {
      migrate(db);
      migrate(db);
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM schema_version')
        .get() as { n: number };
      expect(count.n).toBe(1);
    });

    it('fails fast when the stored schema version is newer than the build', () => {
      db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION + 1);
      expect(() => migrate(db)).toThrow(/newer than this build/);
    });
  });

  describe('on-disk database', () => {
    it('enables WAL and persists across reopen', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chess-db-'));
      const path = join(dir, 'lib.db');
      try {
        const db1 = openDatabase(path);
        expect(String(db1.pragma('journal_mode', { simple: true })).toLowerCase()).toBe(
          'wal',
        );
        db1.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
        db1.close();

        // Reopen: migration is idempotent and the file is reused.
        const db2 = openDatabase(path);
        const tables = db2
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
          .get() as { n: number };
        expect(tables.n).toBeGreaterThanOrEqual(5);
        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('resolveDbPath', () => {
    const original = { ...process.env };
    afterEach(() => {
      process.env = { ...original };
    });

    it('honors CHESS_DB_PATH above everything', () => {
      process.env.CHESS_DB_PATH = '/tmp/custom.db';
      process.env.NODE_ENV = 'test';
      expect(resolveDbPath()).toBe('/tmp/custom.db');
    });

    it('defaults to :memory: under NODE_ENV=test', () => {
      delete process.env.CHESS_DB_PATH;
      process.env.NODE_ENV = 'test';
      expect(resolveDbPath()).toBe(':memory:');
    });

    it('defaults to ~/.morphy/library.db otherwise', () => {
      delete process.env.CHESS_DB_PATH;
      process.env.NODE_ENV = 'production';
      expect(resolveDbPath()).toMatch(/\.morphy\/library\.db$/);
    });
  });
});
