-- admins can lock an entry: then only admins can edit it, its versions or its visibility
ALTER TABLE entries ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
