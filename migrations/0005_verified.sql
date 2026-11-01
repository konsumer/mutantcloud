-- when the release watcher last re-checked a listing's downloads (files that can change in place)
ALTER TABLE entries ADD COLUMN verified TEXT;
