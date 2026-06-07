import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Injection token for the shared {@link Database} connection. Repositories
 * inject this rather than `Database` directly so tests can supply an in-memory
 * connection without DI gymnastics.
 */
export const DATABASE = Symbol('DATABASE');

export type Db = Database.Database;

/** Bump when a non-idempotent schema change ships; mismatch fails fast on boot. */
export const SCHEMA_VERSION = 1;

/**
 * Resolve the on-disk database path from the environment.
 *  - `CHESS_DB_PATH` wins when set.
 *  - tests (`NODE_ENV==='test'`) default to an in-memory DB.
 *  - otherwise `~/.morphy/library.db`.
 */
export function resolveDbPath(): string {
  if (process.env.CHESS_DB_PATH) return process.env.CHESS_DB_PATH;
  if (process.env.NODE_ENV === 'test') return ':memory:';
  return join(homedir(), '.morphy', 'library.db');
}

/**
 * Idempotent schema. `CREATE TABLE IF NOT EXISTS` for all four tables plus their
 * indexes, run on every boot. A `schema_version` row records the version we
 * migrated to; an unexpected stored version fails fast (see {@link migrate}).
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS games (
  id            TEXT PRIMARY KEY,
  white         TEXT,
  black         TEXT,
  result        TEXT,
  eco           TEXT,
  opening       TEXT,
  date          TEXT,
  ply_count     INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL DEFAULT 'manual',
  collection_id TEXT REFERENCES collections(id),
  has_analysis  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  data          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_white ON games(white);
CREATE INDEX IF NOT EXISTS idx_games_black ON games(black);
CREATE INDEX IF NOT EXISTS idx_games_eco ON games(eco);
CREATE INDEX IF NOT EXISTS idx_games_source ON games(source);
CREATE INDEX IF NOT EXISTS idx_games_collection ON games(collection_id);
CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',
  source_ref  TEXT,
  game_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_cache (
  fen_norm   TEXT NOT NULL,
  depth      INTEGER NOT NULL,
  multipv    INTEGER NOT NULL,
  engine_id  TEXT NOT NULL,
  eval_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (fen_norm, depth, multipv, engine_id)
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  params        TEXT,
  status        TEXT NOT NULL,
  total         INTEGER,
  imported      INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  collection_id TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);
`;

/**
 * Run the idempotent schema migration and record/verify the schema version.
 * A stored version newer than the code we run fails fast with a clear message
 * (the DB was written by a future build); same-or-absent is fine.
 */
export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);
  backfillColumns(db);
  const row = db
    .prepare('SELECT version FROM schema_version LIMIT 1')
    .get() as { version: number } | undefined;
  if (row === undefined) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
      SCHEMA_VERSION,
    );
    return;
  }
  if (row.version > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${row.version} is newer than this build supports (${SCHEMA_VERSION}). ` +
        `Upgrade the app or point CHESS_DB_PATH at a compatible database.`,
    );
  }
  if (row.version < SCHEMA_VERSION) {
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
}

/**
 * Add columns introduced after a table first shipped, for on-disk DBs created by
 * an earlier build whose `CREATE TABLE IF NOT EXISTS` lacked them. Idempotent:
 * checks the live column set first and only adds what's missing (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`). `import_jobs.collection_id` was added here.
 */
function backfillColumns(db: Db): void {
  const cols = (
    db.prepare('PRAGMA table_info(import_jobs)').all() as { name: string }[]
  ).map((c) => c.name);
  if (!cols.includes('collection_id')) {
    db.exec('ALTER TABLE import_jobs ADD COLUMN collection_id TEXT');
  }
}

/**
 * Open a better-sqlite3 connection at `dbPath`, enable WAL (skipped for
 * `:memory:`, which has no journal file), and run migrations. Synchronous: the
 * whole point of better-sqlite3 is that it fits NestJS without forcing async.
 */
export function openDatabase(dbPath: string = resolveDbPath()): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  migrate(db);
  return db;
}
