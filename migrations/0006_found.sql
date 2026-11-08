-- repos the collector found on GitHub but didn't list (no installable package yet, a copy of a listed build, ...):
-- admins look through them on the site, then list or dismiss each one
CREATE TABLE found (
  repo TEXT PRIMARY KEY,
  info TEXT NOT NULL DEFAULT '{}',
  why TEXT NOT NULL,
  first TEXT NOT NULL,
  seen TEXT NOT NULL,
  dismissed TEXT
);
