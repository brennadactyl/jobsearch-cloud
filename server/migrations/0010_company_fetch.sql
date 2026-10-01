-- Shared company fetch intelligence: how to reach a company's job board, and
-- what its pages look like when a posting is gone.
--
-- ============================================================================
-- THIS IS THE ONE TABLE IN THIS DATABASE WITH NO user_id.
-- ============================================================================
--
-- Every other table is user-scoped, and verify-local.mjs spends most of its
-- checks proving that two people's data cannot reach each other. This table is
-- a deliberate exception to that, so the boundary it sits on has to be stated
-- rather than assumed:
--
--   What may live here: facts about the public internet. "This employer's
--   Workday CXS slug is not the one its name would suggest." "That employer's
--   job ids changed length when it moved to a different ATS." "This board's API
--   returns the whole board in one fetch." None of that is anyone's job search.
--   Two strangers hitting the same careers site learn the same thing, and there
--   is no version of it that is private to one of them.
--
--   The examples here name no employer on purpose. A reader cannot tell an
--   illustration from an entry, so naming real ones would say which companies
--   this deployment's searches cover - which is the other half of this very
--   boundary.
--
--   What may NOT live here, ever: anything that answers "who is looking at
--   this company, and what did they decide?" No company lists (a person's
--   target companies are their strategy), no screening reasons, no lead or
--   application data, no per-person dates, and no record of which account
--   contributed a row. That last one is why there is no `verified_by` column
--   and deliberately so: "this account's search verified that company on this
--   day" is a fact about the account, not about the company, and a column
--   holding it would leak one person's rotation to everyone else by inference.
--
-- The rule in one line: a row here describes a *website*, never a *search*.
-- Per-company knowledge that is entangled with a person - whether the company
-- is worth watching, when their rotation last reached it - stays in
-- company_sweeps, which is user-scoped and stays that way.
--
-- Why a table and not a shared document. The same reason the rotation is a
-- table: a doc is not read by the thing that needs it. A track whose doc said
-- "add what you discover" ran for days and finished with an empty list, because
-- the doc told runs to write names into prose no run ever reads. Separate track
-- docs have each independently recorded the same employer as unreachable - every
-- one of them wrong, and wrong for the same reason, since each run tested the
-- same stale id format - and correcting it meant hand-editing every doc that
-- held it. Knowledge that has to be copied by hand between searches is
-- knowledge that will be wrong in at least one of them.
CREATE TABLE IF NOT EXISTS company_fetch (
  -- normalize() from src/exclude.js: lowercased, punctuation collapsed to
  -- single spaces, trimmed. Reused rather than reinvented so "Acme Networks",
  -- "acme networks" and "Acme, Networks" are one row, and so this table matches
  -- names the same way the exclusion list already does.
  --
  -- Deliberately NOT fuzzy beyond that. Merging "Acme" with "Acme Studios"
  -- would be convenient right up until two genuinely different boards
  -- share a row and each overwrites the other. A miss here is cheap - it reads
  -- as "nothing known yet", which is where every company starts - so the
  -- failure mode of being too strict is a run doing the work it would have
  -- done anyway.
  company_key TEXT PRIMARY KEY,

  -- The name as a human would write it, for display and for reports. Not the
  -- join key: `company_key` is.
  display_name TEXT NOT NULL DEFAULT '',

  -- The JSON board kind, same vocabulary company_sweeps.board already uses
  -- ('greenhouse', 'ashby', 'lever', 'workday cxs', ...). Empty means none
  -- known. Kept as the same vocabulary on purpose: a run reporting a sweep
  -- already sends this field, so sharing it costs no new prompt wording.
  board TEXT NOT NULL DEFAULT '',

  -- The bit that is worth more than the board kind and that nothing currently
  -- stores: the actual reachable thing. A slug, host or full URL template -
  -- 'acmejobs', 'wd504', or
  -- 'https://boards-api.greenhouse.io/v1/boards/acme/jobs'. Knowing a company
  -- is "workday cxs" saves nothing if the tenant slug still has to be guessed,
  -- and guessing it is what fails: a slug that doesn't follow from the name
  -- defeats every run that tries, every night, until someone records it here.
  endpoint TEXT NOT NULL DEFAULT '',

  -- The URL shape an individual posting takes, when it is not derivable from
  -- the endpoint - e.g.
  -- 'apply.careers.microsoft.com/careers/job/<19-digit id>'. This is where a
  -- migrated ID space gets recorded, which is the thing that made a live
  -- domain look dead to three separate searches.
  url_shape TEXT NOT NULL DEFAULT '',

  -- What a *stated* death looks like here: a 404, a redirect target, or exact
  -- page text. Only ever a stated one.
  --
  -- Read the warning in the run prompt before writing this field. A run has
  -- compared pages it could not read, found two strings they shared, concluded
  -- those meant "closed", and delisted live postings on it; the strings were
  -- boilerplate present in every response from that host.
  -- A signal inferred by comparing pages is not a dead signal, however cleanly
  -- it appears to split the sample it was derived from - it will always split
  -- that sample, because that is the sample it came from. Leave this empty
  -- rather than guessing: empty means "no way known to tell dead from live
  -- here", which is both true and safe, and it is the correct value for most
  -- companies.
  dead_signal TEXT NOT NULL DEFAULT '',

  -- Anything else about reaching this company that a later run would want:
  -- rate limits, a mirror that works when the main site does not, a JS shell
  -- with no static content. About the site. Never about a search.
  note TEXT NOT NULL DEFAULT '',

  -- YYYY-MM-DD a run last confirmed this actually worked. A shared fact that
  -- nobody has re-checked in two months is a rumour, and the reader should be
  -- able to see its age rather than trusting it flat.
  verified_on TEXT NOT NULL DEFAULT '',

  -- Set when a row turns out to be wrong. The row stays: the trail is how the
  -- next person avoids re-deriving the same mistake, and deleting it invites
  -- exactly that. Readers must treat a retracted row as "no facts known" and
  -- show the note, not silently fall back to the fields above it.
  --
  -- This exists because a wrong shared fact is worse than a wrong private one.
  -- The bad dead-signal above damaged one search; had it been in this table it
  -- would have damaged every search on the deployment the same night.
  retracted_on TEXT NOT NULL DEFAULT '',
  retracted_note TEXT NOT NULL DEFAULT ''
);
