import type { Database } from "bun:sqlite";

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inode (
  inode_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'dir', 'symlink')),
  mode INTEGER NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL,
  ctime_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dirent (
  parent_inode_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  inode_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (parent_inode_id, name),
  FOREIGN KEY (parent_inode_id) REFERENCES inode(inode_id) ON DELETE CASCADE,
  FOREIGN KEY (inode_id) REFERENCES inode(inode_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS dirent_inode_idx ON dirent(inode_id);

CREATE TABLE IF NOT EXISTS extent (
  inode_id INTEGER NOT NULL,
  file_version INTEGER NOT NULL,
  logical_offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  object_offset INTEGER NOT NULL DEFAULT 0,
  object_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  compression TEXT,
  PRIMARY KEY (inode_id, file_version, logical_offset),
  FOREIGN KEY (inode_id) REFERENCES inode(inode_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS object_ref (
  object_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('blob', 'pack', 'wal-inline')),
  ref_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cache_entry (
  object_key TEXT PRIMARY KEY,
  local_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  last_access_ms INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  pin_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('clean', 'downloading', 'materialized'))
);

CREATE INDEX IF NOT EXISTS cache_lru_idx ON cache_entry(pin_count, last_access_ms);

CREATE TABLE IF NOT EXISTS remote_tx (
  seq INTEGER PRIMARY KEY,
  txid TEXT UNIQUE NOT NULL,
  parent_txid TEXT,
  wal_key TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
`;

export function initSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  const root = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM inode WHERE inode_id = 1").get();
  if (!root || root.n === 0) {
    const now = Date.now();
    db.query("INSERT INTO inode(inode_id, kind, mode, size, mtime_ms, ctime_ms, version) VALUES (1, 'dir', ?, 0, ?, ?, 0)").run(0o755, now, now);
  }
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getMeta(db: Database, key: string): string | undefined {
  const row = db.query<{ value: string }>("SELECT value FROM meta WHERE key = ?").get(key);
  return row?.value;
}

export function getMetaNumber(db: Database, key: string, fallback = 0): number {
  const value = getMeta(db, key);
  return value === undefined ? fallback : Number(value);
}
