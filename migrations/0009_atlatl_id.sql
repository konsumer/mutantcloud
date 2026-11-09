-- Atlatl was listed under its maker's login: its id is its name
UPDATE entries SET id = 'atlatl' WHERE id = 'likst4' AND NOT EXISTS (SELECT 1 FROM entries WHERE id = 'atlatl');
UPDATE releases SET entry = 'atlatl' WHERE entry = 'likst4' AND EXISTS (SELECT 1 FROM entries WHERE id = 'atlatl');
UPDATE audit SET entry = 'atlatl' WHERE entry = 'likst4' AND EXISTS (SELECT 1 FROM entries WHERE id = 'atlatl');
