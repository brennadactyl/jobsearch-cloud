-- company_sweeps, rebuilt on company_key, with the mirrored columns gone.
--
-- What this table is for is one search's memory of one company: when it last
-- tried it, and what it learned there. Everything else it currently holds is a
-- copy of something the shared list already knows.
--
-- 0011_one_company_list.sql made company_fetch the list and moved `position`
-- onto it, but left `company`, `board` and `position` on this table and kept
-- them in step, so that a deploy could be rolled back to the worker that read
-- them. That worker has been gone since 2026-09-11. Issue #2 is the `board`
-- half: the same company's board was stored once per search and once shared,
-- with nothing keeping the copies honest. Four companies had already drifted
-- apart between searches (Amazon AWS, Netflix, World Labs, Costco), and the
-- shared row is the one every reader uses.
--
-- The precondition issue #2 set was that company_fetch must already hold a
-- board for every company that has one here, so that dropping the column loses
-- no knowledge. Measured on the 2026-09-11 backup: 96 companies with a board
-- here, 95 already shared and none in disagreement. The last one, NFL, was
-- recorded on the shared list the same evening, so nothing here is the only
-- copy of anything.
--
-- ---- What changes
--
--   company_sweeps(user_id, search, company_key, last_swept, note)
--
-- `company` goes: readers join on `company_key`, and the name belongs to the
-- list, which holds one spelling per company. `board` and `position` go: both
-- are read from company_fetch and have been since 0011.
--
-- The primary key becomes (user_id, search, company_key), which is also the
-- index a rotation reads, so 0011's separate idx_company_sweeps_key is not
-- recreated - the key itself is that index now.
--
-- ---- What the rebuild does with rows that disagree
--
-- Before 0011 a run wrote whatever spelling it used, so one search can hold two
-- rows for one company ("Cursor (Anysphere)" and "Cursor Anysphere"). Keyed by
-- company_key they are one row, and the merge keeps the later `last_swept` and
-- the note from the most recently swept row that has one. That is what
-- getCoverage already did at read time, so no search's view changes.
--
-- Rows whose `company_key` is '' are dropped. A name of nothing but punctuation
-- normalizes to '', it can never join a list row, and it has been invisible to
-- every reader since 0011.
--
-- Rows whose company is no longer on the list are copied as they are. There are
-- no foreign keys here; a row like that is dead weight, not a fault, and
-- deleting a search's record of a company is not this migration's business.
--
-- ---- This one cannot be walked back
--
-- Dropping a column is the step 0011 deliberately deferred. After it, the
-- worker that is live before this deploy cannot write a sweep at all: its
-- INSERT names `company`, `board` and `position`. `npm run deploy` applies the
-- migration first and uploads the worker seconds later, so there is a short
-- window where the old worker meets the new schema - deploy it when no search
-- is running, and never mid-run. Take a backup first, as with any migration.

CREATE TABLE company_sweeps_by_key (
  user_id    TEXT NOT NULL,
  search     TEXT NOT NULL,               -- track key, matches tracks.key
  company_key TEXT NOT NULL,              -- normalize(name), joins company_fetch
  -- YYYY-MM-DD this search last *attempted* the company, '' for never.
  -- Attempted, not succeeded: a company whose domain refused the fetch is still
  -- stamped, or the rotation retries it every run forever.
  last_swept TEXT NOT NULL DEFAULT '',
  -- What this search learned about the company, in its own words. Never shared:
  -- prose carries one search's reasoning ("nothing at my level here").
  note       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, search, company_key)
);

INSERT INTO company_sweeps_by_key (user_id, search, company_key, last_swept, note)
SELECT s.user_id, s.search, s.company_key,
       MAX(s.last_swept),
       COALESCE((SELECT x.note
                   FROM company_sweeps x
                  WHERE x.user_id = s.user_id
                    AND x.search = s.search
                    AND x.company_key = s.company_key
                    AND x.note <> ''
                  ORDER BY x.last_swept DESC, x.rowid DESC
                  LIMIT 1), '')
  FROM company_sweeps s
 WHERE s.company_key <> ''
 GROUP BY s.user_id, s.search, s.company_key;

DROP TABLE company_sweeps;
ALTER TABLE company_sweeps_by_key RENAME TO company_sweeps;
