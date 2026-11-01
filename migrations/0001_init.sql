-- auto: what the collector found (other hubs + GitHub), refreshed on every sync
-- data: what people set by hand; always wins over auto, never touched by the collector
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  repo TEXT,
  auto TEXT NOT NULL DEFAULT '{}',
  data TEXT NOT NULL DEFAULT '{}',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  synced TEXT
);

CREATE UNIQUE INDEX entries_repo ON entries (repo) WHERE repo IS NOT NULL;

CREATE TABLE audit (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  entry TEXT NOT NULL,
  login TEXT NOT NULL,
  action TEXT NOT NULL,
  change TEXT,
  at TEXT NOT NULL
);

CREATE INDEX audit_entry ON audit (entry);
