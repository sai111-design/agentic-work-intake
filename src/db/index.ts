/**
 * SQLite via node:sqlite (built into Node >= 22.5) — no native compilation,
 * so `npm install` cannot fail on a missing C++ toolchain.
 *
 * This is the ONLY file that talks to the database driver. Every query in the
 * app uses prepared statements with bound parameters; no SQL is ever built by
 * string concatenation.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

/**
 * Schema is inlined rather than kept in a .sql file so there is no asset-copy
 * step between src/, dist/, and the Docker image — one less thing that can be
 * correct locally and broken in production.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id              TEXT PRIMARY KEY,
  raw_text        TEXT NOT NULL,
  status          TEXT NOT NULL,
  interpretation  TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL REFERENCES requests(id),
  seq             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  classification  TEXT NOT NULL,
  reason          TEXT NOT NULL,
  tool            TEXT,
  tool_input      TEXT,
  status          TEXT NOT NULL,
  output          TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Real output of the create_task tool. UNIQUE(action_id) is what makes that
-- tool idempotent: re-running an approved action cannot duplicate a reminder.
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL REFERENCES requests(id),
  action_id       TEXT NOT NULL UNIQUE REFERENCES actions(id),
  title           TEXT NOT NULL,
  due_at          TEXT,
  status          TEXT NOT NULL DEFAULT 'OPEN',
  created_at      TEXT NOT NULL
);

-- The activity trace. Append-only; never updated or deleted.
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      TEXT NOT NULL REFERENCES requests(id),
  action_id       TEXT REFERENCES actions(id),
  type            TEXT NOT NULL,
  message         TEXT NOT NULL,
  data            TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actions_request ON actions(request_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_request  ON events(request_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_request   ON tasks(request_id);
`;

/**
 * Open a database at `path`, applying the schema idempotently.
 * Pass ':memory:' for tests.
 */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  // WAL lets reads proceed during writes; FK enforcement is off by default in SQLite.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

let singleton: DatabaseSync | null = null;

/** Process-wide handle for the running server. Tests use openDb() directly. */
export function getDb(): DatabaseSync {
  singleton ??= openDb(config.dbPath);
  return singleton;
}

export function closeDb(): void {
  singleton?.close();
  singleton = null;
}

/** One source of timestamp format across every table. */
export function nowIso(): string {
  return new Date().toISOString();
}
