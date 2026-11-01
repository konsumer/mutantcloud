-- every version ever seen, so old versions stay installable
-- source: github (collector), action (maker's CI), manual (edit form), fmdb / firmwarehub (other hubs)
CREATE TABLE releases (
  entry TEXT NOT NULL,
  version TEXT NOT NULL,
  date TEXT,
  url TEXT,
  prerelease INTEGER NOT NULL DEFAULT 0,
  assets TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  source TEXT NOT NULL,
  added TEXT NOT NULL,
  PRIMARY KEY (entry, version)
);

CREATE INDEX releases_date ON releases (entry, date DESC);
