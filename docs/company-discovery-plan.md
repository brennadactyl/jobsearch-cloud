# Company discovery as its own nightly job

One nightly job grows the shared company list. The searches stop doing it: a
search covers the companies it is served, and only this job or a person adds a
company to the list.

This changes the company list described in [schema.md](schema.md)
(`company_fetch`, `company_sweeps`) and the search prompt built by
`server/src/prompt.js`.

## Context

Every search runs step 3b, "look outside that list", and adds what it finds
through step 9d: `POST /api/coverage` creates a list row for any company it has
not seen. The list is shared by every search and every account, but each search
picks its industries and candidates alone, with no record of what any search
tried before.

On 2026-09-11 the four searches checked DraftKings three times, the Seattle
Kraken three times, and Albertsons and the Mariners twice each. SWE and product
both hit Sportradar's Cloudflare block. Each track's baseline doc also carries
its own numbered "broader discovery" step and a prose log of industries tried.

## The approach

### 1. The discovery log

A new table records every company evaluated for the list, so none is evaluated
twice inside its retry window.

**The log is shared, not per-user**, and `0014`'s own comment says so. It is the
second table after `company_fetch` with no `user_id`, for the same reason: one
job serves the whole deployment, and a per-account log would have every account
re-evaluating the companies another had already ruled out - the duplication this
plan exists to end. The nightly cap is therefore deployment-wide by design.

What keeps that safe is what the table may hold: a row describes a company and
nothing else. No `user_id`, no track key, and no role, level or location text in
`note` - "no Seattle or remote-US engineering or product postings", never
"nothing at Brenna's level". A row that named a search would leak one person's
search behaviour into everyone's view, which is the line `company_fetch` already
holds.

One row per company, updated in place. The PK is `company_key`, so a
`suggested` row becomes `added` or `no_match` later, keeping its `first_on` and
moving its `last_on`. **`added` is terminal**: the company is on the list and the
list is its record from then on. The nightly cap counts the day's `added` rows,
which is only a stable number if nothing re-logs one.

`evidence_url` is provenance - recorded once, never re-fetched, and never used
to decide anything later. The retry windows are constants in
`server/src/discovery.js` rather than columns: a window is policy, and a copy of
it on every row cannot be changed without a migration.

`company_discovery`

| column | |
|---|---|
| `company_key` | PK, `normalize()` of the name |
| `display_name` | |
| `industry` | the industry it was found under; `''` for a suggestion or a manual add |
| `outcome` | `suggested`, `added`, `no_match`, `unreadable`, `not_found` |
| `source` | `job`, `search`, `person` |
| `evidence_url` | for `added`: the live posting that qualified it |
| `note` | |
| `first_on`, `last_on` | local dates |

| outcome | meaning | served again |
|---|---|---|
| `suggested` | a search covered a company not on the list (§4) | to the next job run |
| `added` | joined the list | never - the list is its record |
| `no_match` | real employer, no current posting matching any search | after 60 days |
| `unreadable` | no route to its listings worked | after 30 days |
| `not_found` | no such employer could be identified | never |

Notes name no role, level or person: "no Seattle or remote-US engineering or
product postings", not "nothing at Brenna's level".

### 2. The job

`scripts/run-discovery.ps1`, registered by `setup-scheduler.ps1` as one task for
the machine, `JobSearch-Discovery`, daily at 04:00 - after the last search slot
and before the 06:30 application fill. It follows `run-fill.ps1`: every account
under `<DataDir>`, all on one tracker URL, one `claude -p` turn, logged to
`<DataDir>\logs\discovery.log`.

The runner prepares, before the model starts:

- `searches.json` - for every account, every track with its own search (no
  `fed_by`): `label`, `full_description`, `role_search_line`, and the account's
  `priority_locations` and `excluded_companies`, read from each account's
  `/api/config` with its own token. No resume, leads or names.
- `tracker.ps1` and the `tracker` shim, with `TRACKER_URL` and
  `TRACKER_API_TOKEN` for the first account in sorted order, and no
  `TRACKER_SEARCH`.
- the prompt, from `GET /api/prompt/_discovery` - a reserved key beside
  `_applications`, the same text for every caller (`buildDiscoveryPrompt`).

The model:

1. Runs `./tracker discovery`, which writes `discovery.json`: tonight's
   industries, pending suggestions, every company on the list, every company
   inside its retry window, and tonight's remaining add cap.
2. Evaluates the suggestions, then searches tonight's industries for employers
   hiring any role in `searches.json` in that account's locations. It skips
   companies on the list, inside a retry window, or excluded by any account.
3. For each candidate, finds the listings route and verifies at least one
   current posting to the search prompt's step-4 standard. One verified posting
   matching one search's role and locations qualifies the company.
4. Writes `discovered.json` - `{company, industry, outcome, board, endpoint,
   url_shape, wall, evidence_url, note}` per candidate - and runs
   `./tracker discovered discovered.json`.
5. Reports counts by outcome and names the companies added.

The job files no leads. A qualifying posting is evidence for the company; the
searches find it when their cursor reaches that company.

### 3. Server rules

What is served and what is written is decided in `server/src/discovery.js` and
the routes, not in the prompt.

`GET /api/discovery` returns:

- `industries` - the `DISCOVERY_INDUSTRIES_PER_RUN` (2) industries whose most
  recent `last_on` is oldest; never-tried industries first, ties in list order.
  The list is `DISCOVERY_INDUSTRIES`, today's step-3b industries. Computed over
  rows whose `industry` is non-empty, so a suggestion or a manual add - both
  `industry: ''` - never marks an industry as explored. Reading twice in one run
  returns the same pair, since nothing is logged until the run reports.
- `suggestions`, `list`, `recent` (rows inside their retry window), and
  `remaining` - `DISCOVERY_ADD_CAP` (6) minus today's `added` rows with
  `source = 'job'`.

`POST /api/discovery` takes `{on, source, found: [...]}` and returns
`{added, logged, known, too_soon, over_cap}`:

- A demo account gets 403, as on `POST /api/coverage`.
- A company already on the list, matched through `normalize()`, is `known` and
  writes nothing. A retracted company still has its row, so it reads as `known`
  too - it cannot be "added" again.
- `added` appends to `company_fetch` after the highest position, shuffled within
  the call - the same insertion `POST /api/coverage` does today. That makes this
  route the second caller of `db.addCompanies`, which writes the one table every
  account reads; say so where it is called, since every neighbouring write in
  `db.js` is scoped to one user. No `company_sweeps` row is written and no
  cursor moves. Past the cap, a `job` add is `over_cap`; a `person` add is never
  capped.
- **`addCompanies` runs before `upsertCompanyFetch`, and facts are written only
  for companies that just joined or were already on the list.**
  `upsertCompanyFetch` is an upsert, not an update: it creates a
  `company_fetch` row for a key it doesn't find, and its INSERT sets no
  `position`, which is `NOT NULL DEFAULT 0`. So a `board` sent with a
  `no_match` would plant a company at position 0, on top of whatever the
  rotation currently has at the front, and a cursor would step over one of them.
  `handleRecordSweeps` already does it in this order; the new route must too.
- `no_match`, `unreadable` and `not_found` are logged, and refused as
  `too_soon` inside the company's retry window. An `added` is never `too_soon`.
- Exclusions are not consulted: each search's slice already drops its own
  account's excluded companies (`GET /api/coverage`).

`POST /api/coverage` stops creating companies. A swept company that is not on
the list is **logged as a suggestion and nothing else is written for it**: no
`company_sweeps` row, and no shared facts either - not even when the report
carries a `board` or a `wall`. Skipping `addCompanies` is not enough on its own,
because `upsertCompanyFetch` would create the row itself, at position 0. A sweep row for a company that is not on the list
would point at a `company_key` with no list entry, which breaks the invariant
0011 established and 0012 was checked against: every sweep row joins a company
on the list.

So the row is logged as `suggested` with `source = 'search'` and no search key,
once per company, and the response reports `suggested` in place of `added`,
alongside `recorded`, which counts only the companies that were on the list.

### 4. The searches

A search covers the companies it is served and reports what it covered.

- `prompt.js`: step 3b and its post-mortem comment go. Step 1c loses "step 3b
  sends you outside it on purpose". Step 9d's "a company not already in the
  list is created by this call" becomes "a company not on the list is passed to
  the discovery job". The exclusion note loses "including via broader
  discovery". Step 3 keeps web search as a backup for the served companies.
- `tracker.ps1 swept` prints `suggested=` where it printed `added=`.
- Every track baseline doc with its own "broader discovery" process step loses
  that step; its prose log of industries already tried stays. Reconciled per the
  `change-search-prompt` skill, in the same release.

### 5. Adding a company by hand

`add-target-company` registers a company through `POST /api/discovery` with
`source: "person"` and outcome `added`, in place of `POST /api/coverage` with
`on: ""`. It is the only skill that has to move: `job-search-setup` no longer
registers companies at all.

## Build order

One release. The database session and the prompt session each own a half: a
field the job reports lands in the migration, `tracker.ps1`'s whitelist and the
prompt together.

1. Database: `0013_company_discovery.sql`, `db.js`, `server/src/discovery.js`,
   `routes/discovery.js`, the `POST /api/coverage` change, `docs/schema.md`.
2. Prompt: `buildDiscoveryPrompt`, the search prompt changes, `tracker.ps1`
   (`discovery`, `discovered`, the `swept` summary), the track doc
   reconciliation, both skills.
3. `run-discovery.ps1` and `setup-scheduler.ps1`.
4. Back up, deploy from the main checkout, pull main there, and re-run
   `setup-scheduler.ps1` to register the task.

## Files

- `server/migrations/0014_company_discovery.sql`
- `server/src/discovery.js` - industries, cap, retry windows, industry selection
- `server/src/routes/discovery.js`, `server/src/routes/index.js`,
  `server/src/routes/prompt.js`, `server/src/routes/coverage.js`,
  `server/src/db.js`
- `server/src/prompt.js`
- `scripts/tracker.ps1`, `scripts/run-discovery.ps1`,
  `scripts/setup-scheduler.ps1`
- `.claude/skills/add-target-company/SKILL.md`,
  `.claude/skills/job-search-setup/SKILL.md`
- `server/README.md` - the `POST /api/coverage` response loses `added`
- `docs/schema.md`, `docs/README.md`
- each track's baseline doc in R2

## Verification

`verify-local.mjs`:

- `POST /api/coverage` naming an unknown company leaves the list total
  unchanged, records no sweep for it, and logs one `suggested` row.
- The same call carrying a `board` and a `wall` still writes no
  `company_fetch` row, and nothing sits at position 0 that wasn't there before.
- After that call, no `company_sweeps` row points at a `company_key` missing
  from `company_fetch` - the check 0012 was verified against.
- Nothing the discovery routes return, and nothing they store, carries a
  `user_id` or a track key.
- A job `added` lands at the highest position + 1 and leaves every search's
  cursor where it was.
- A `no_match` inside 60 days of the last one is `too_soon`; an `added` for the
  same company is accepted.
- The seventh job `added` on one date is `over_cap`; a `person` add is not.
- A demo account gets 403 on `POST /api/discovery`.
- `GET /api/discovery` serves the two least-recently-tried industries, and the
  same two until a row is logged against one.
- No search prompt contains step 3b, and `/api/prompt/_discovery` returns 200.

`verify-migration.mjs` gains a block for 0014.

End to end: run `run-discovery.ps1` once by hand. The list total rises by
exactly the `added` count, every cursor is unchanged, and the log rows match the
run's report. The next night's four searches report no discovery.

## Not in scope

Removing companies from the list, and merging duplicate spellings already on it.
