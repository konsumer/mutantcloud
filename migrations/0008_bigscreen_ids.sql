-- big-screen builds: <base>-bigscreen, not a numbered copy of the base id
UPDATE entries SET id = 'choralrootfm-bigscreen' WHERE id = 'choralrootfm1' AND repo = 'pfkellogg/choralrootfm1';
UPDATE entries SET id = 'jiant-bigscreen' WHERE id = 'jiant-2' AND repo = 'pfkellogg/jiant';
UPDATE entries SET id = 'skiff-bigscreen' WHERE id = 'skiff-2' AND repo = 'pfkellogg/skiff';
UPDATE releases SET entry = 'choralrootfm-bigscreen' WHERE entry = 'choralrootfm1' AND EXISTS (SELECT 1 FROM entries WHERE id = 'choralrootfm-bigscreen');
UPDATE releases SET entry = 'jiant-bigscreen' WHERE entry = 'jiant-2' AND EXISTS (SELECT 1 FROM entries WHERE id = 'jiant-bigscreen');
UPDATE releases SET entry = 'skiff-bigscreen' WHERE entry = 'skiff-2' AND EXISTS (SELECT 1 FROM entries WHERE id = 'skiff-bigscreen');
UPDATE audit SET entry = 'choralrootfm-bigscreen' WHERE entry = 'choralrootfm1' AND EXISTS (SELECT 1 FROM entries WHERE id = 'choralrootfm-bigscreen');
UPDATE audit SET entry = 'jiant-bigscreen' WHERE entry = 'jiant-2' AND EXISTS (SELECT 1 FROM entries WHERE id = 'jiant-bigscreen');
UPDATE audit SET entry = 'skiff-bigscreen' WHERE entry = 'skiff-2' AND EXISTS (SELECT 1 FROM entries WHERE id = 'skiff-bigscreen');
