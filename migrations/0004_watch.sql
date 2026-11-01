-- the release watcher (cron): when each repo's releases feed was last checked, and its ETag
ALTER TABLE entries ADD COLUMN watched TEXT;
ALTER TABLE entries ADD COLUMN watch_etag TEXT;
