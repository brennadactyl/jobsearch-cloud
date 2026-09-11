-- One company list for every search, and a shared wall with an expiry.
--
-- Each search used to own its own rotation. The four live ones had drifted to
-- 56, 66, 71 and 79 companies - 272 rows over 139 distinct companies, 22 of
-- them in all four - and one fact about a careers site could be written into
-- four separate rows. Brenna's call on 2026-09-11: one list, and a search keeps
-- an index into it rather than a copy of it. Global, across every person.
--
-- ---- The list is company_fetch
--
-- company_fetch was already global and already keyed by normalize(). A company
-- is on the list when it has a row there. `position` moves here, so every
-- search's cursor indexes the same log. company_sweeps keeps what is genuinely
-- per search: last_swept, when this search last tried a company, and note, what
-- this search learned there for itself - 243 of the 272 rows carry one.
--
-- This file only adds. company_sweeps keeps `company`, `board` and `position`
-- physically and they are kept in step, so the worker from before this change
-- still runs against the schema after it. Dropping them means rebuilding the
-- table to move its primary key from `company` to `company_key`, which is the
-- one step here that cannot be walked back - so it waits for a later migration,
-- after this one has run in production.
--
-- ---- 0010's boundary
--
-- 0010 says no company list may live in shared storage, because a person's
-- target companies are their strategy. This puts one there. 0010 is applied and
-- cannot be edited, so the amendment lives here: membership is now visible
-- across the deployment. Attribution degrades rather than holding - each person
-- knows what they added, the companies are characteristic, and under pooled
-- discovery a company's presence also says a run surfaced it recently. What
-- stays scoped is the record of who looked and when: last_swept, the cursor,
-- and note.
--
-- ---- normalize() in SQL
--
-- company_sweeps rows are keyed by the name a run wrote; company_fetch rows by
-- normalize() from src/exclude.js - lower-case, every run of characters outside
-- [a-z0-9] to one space, trimmed. SQLite has no regex, so the backfill spells
-- it out: every ASCII punctuation and whitespace character becomes a space,
-- runs collapse, the ends trim. On 2026-09-11 the live names used eight of
-- those characters and no non-ASCII at all. verify-migration.mjs holds the
-- expression to the JS function for every character it covers.
--
-- Re-check the live character set immediately before deploying. SQLite's
-- lower() is ASCII-only, so a name containing a non-ASCII letter would get a
-- key the JS side never produces, and would appear on the list twice.
--
-- On the live data this merges exactly one pair: "Cursor (Anysphere)" and
-- "Cursor Anysphere" become one company. Both rows stay in company_sweeps until
-- the rebuild, and readers take the most recent last_swept.
--
-- ---- Positions and cursors
--
-- One shuffle over the whole list, for 0008's reason: a list somebody typed is
-- alphabetical or grouped by theme, and position decides who is covered first
-- every cycle and who is dropped when a run runs short.
--
-- The permutation is written to a scratch table before it is applied, so that
-- RANDOM() is evaluated once. Inside a correlated subquery it can be
-- re-evaluated per outer row, which would hand two companies the same place
-- and let the cursor step over one of them.
--
-- Every search's cursor restarts at 0. The old cursors were positions in lists
-- that no longer exist, and there is no honest mapping from one shuffle onto
-- another. last_swept is untouched, so nothing a run learned is lost; the cost
-- is that the first cycle afterwards may reach a company that one search swept
-- a few days ago.
--
-- ---- board
--
-- Copied into company_fetch wherever company_fetch has none, and never over one
-- it has - but only from a row some run has actually swept. Readers switch to
-- the shared table in the same change, so leaving those behind would strip the
-- board hint from every company no run has re-confirmed yet. A board on a row
-- nobody has swept was typed in with the list, and a typed list is not
-- evidence (0010), so it does not become a shared fact.
--
-- ---- wall
--
-- What stops a fetch at this company, pooled across every search. wall_dates
-- counts the separate dates it has been recorded on; it is served only once
-- that reaches 2, and only for seven days after wall_last_on - see
-- db.getCompanyFetch. Reporting a board or an endpoint clears it, since a fetch
-- that worked is the only evidence that settles the question. Empty on every
-- existing row: no run has sent one yet.
--
-- ---- What this does not change
--
-- Which facts travel. note stays out of the shared table and dead_signal stays
-- unwritten - a wrong dead_signal feeds delisting, which removes rows.

ALTER TABLE company_fetch ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE company_fetch ADD COLUMN wall TEXT NOT NULL DEFAULT '';
ALTER TABLE company_fetch ADD COLUMN wall_first_on TEXT NOT NULL DEFAULT '';
ALTER TABLE company_fetch ADD COLUMN wall_last_on TEXT NOT NULL DEFAULT '';
ALTER TABLE company_fetch ADD COLUMN wall_dates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE company_sweeps ADD COLUMN company_key TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_company_sweeps_key ON company_sweeps(user_id, search, company_key);

-- normalize() from src/exclude.js, spelled out. Generated, not hand-typed: one
-- replace() per ASCII punctuation or whitespace character, then enough
-- space-collapsing passes for a run of 64, then trim.
UPDATE company_sweeps SET company_key = trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(company), char(1), ' '), char(2), ' '), char(3), ' '), char(4), ' '), char(5), ' '), char(6), ' '), char(7), ' '), char(8), ' '), char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' '), char(14), ' '), char(15), ' '), char(16), ' '), char(17), ' '), char(18), ' '), char(19), ' '), char(20), ' '), char(21), ' '), char(22), ' '), char(23), ' '), char(24), ' '), char(25), ' '), char(26), ' '), char(27), ' '), char(28), ' '), char(29), ' '), char(30), ' '), char(31), ' '), '!', ' '), '"', ' '), '#', ' '), '$', ' '), '%', ' '), '&', ' '), '''', ' '), '(', ' '), ')', ' '), '*', ' '), '+', ' '), ',', ' '), '-', ' '), '.', ' '), '/', ' '), ':', ' '), ';', ' '), '<', ' '), '=', ' '), '>', ' '), '?', ' '), '@', ' '), '[', ' '), '\', ' '), ']', ' '), '^', ' '), '_', ' '), '`', ' '), '{', ' '), '|', ' '), '}', ' '), '~', ' '), char(127), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '));

-- Every company in any rotation joins the list. A retracted shared row is
-- already on it and is left alone: its board is a withdrawn fact.
INSERT INTO company_fetch (company_key, display_name, board)
SELECT company_key, MIN(company), MAX(CASE WHEN last_swept <> '' THEN board ELSE '' END)
  FROM company_sweeps
 WHERE company_key <> ''
 GROUP BY company_key
ON CONFLICT(company_key) DO UPDATE SET
  display_name = CASE WHEN company_fetch.display_name = '' THEN excluded.display_name ELSE company_fetch.display_name END,
  board        = CASE WHEN company_fetch.board = ''        THEN excluded.board        ELSE company_fetch.board END
WHERE company_fetch.retracted_on = '';

CREATE TABLE company_fetch_shuffle AS
  SELECT company_key AS k, ROW_NUMBER() OVER (ORDER BY RANDOM()) - 1 AS rn
    FROM company_fetch;

UPDATE company_fetch
   SET position = (SELECT rn FROM company_fetch_shuffle WHERE k = company_fetch.company_key);

DROP TABLE company_fetch_shuffle;

-- Kept in step for the previous worker, which orders a search by this column.
UPDATE company_sweeps
   SET position = COALESCE(
     (SELECT position FROM company_fetch WHERE company_fetch.company_key = company_sweeps.company_key), 0);

UPDATE tracks SET sweep_cursor = 0;
