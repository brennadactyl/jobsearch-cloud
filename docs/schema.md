# Schema

The tracker's D1 database as `server/migrations/` builds it: ten tables, from
`0001_schema.sql` through `0010_company_fetch.sql` applied in order. This is the
schema as it exists today. A plan in this folder that changes a table describes
only its change and links here.

## Before reading the columns

Four things hold the schema together that no column name shows.

**There are no foreign keys.** No migration declares a `REFERENCES` constraint.
Every relationship in the diagram — a row's owner, the track it is filed under,
the lead an application came from — is maintained by `server/src/db.js`, which
scopes every statement to the caller's `user_id`. SQLite will accept a row that
points at a user, track or lead that does not exist, or at someone else's. That
is why most of `server/verify-local.mjs` is checks that one user's rows cannot
reach another's.

**Apart from `users` itself, `company_fetch` is the only table with no
`user_id`.** It holds facts about a company's public careers site, shared by
every account. What may and may not be stored in it is set out at the top of
`server/migrations/0010_company_fetch.sql`: a row describes a website, never a
search.

**`company_sweeps` reaches `company_fetch` through `normalize()`.**
`company_fetch.company_key` is `normalize(name)` from `server/src/exclude.js` —
lowercased, each run of characters outside `a-z0-9` replaced by one space,
trimmed. `company_sweeps.company` holds the name as written, so the match is
`normalize(company_sweeps.company) = company_fetch.company_key`, computed in
JavaScript. Comparing the raw strings misses: `F5, Networks` is stored under
`f5 networks`.

**Every other relationship is a value match within one user.**
`leads.search`, `screened.search`, `company_sweeps.search` and
`search_runs.track_key` hold a `tracks.key`; `tracks.fed_by` holds a sibling
track's key. `applications.leadId` holds `leads.id` as text — `''` for an
application added by hand — so the join is `leadId = CAST(leads.id AS TEXT)`.
Each of these also matches on `user_id`, since track keys are only unique per
user.

## Diagram

`PK` and `UK` are constraints SQLite enforces. `FK` marks a column the code
joins on; nothing enforces it.

```mermaid
erDiagram
    users          ||--o{ sessions       : "signs in with"
    users          ||--o{ tracks         : owns
    users          ||--o{ search_runs    : owns
    users          ||--o{ leads          : owns
    users          ||--o{ screened       : owns
    users          ||--o{ applications   : owns
    users          ||--o{ meta           : owns
    users          ||--o{ company_sweeps : owns
    tracks         ||--|| search_runs    : "last run of"
    tracks         |o--o{ tracks         : "fed_by"
    tracks         ||--o{ leads          : "filed under"
    tracks         ||--o{ screened       : "filed under"
    tracks         ||--o{ company_sweeps : "rotation of"
    leads          |o--o{ applications   : "applied to"
    company_fetch  |o--o{ company_sweeps : "normalize(company)"

    users {
        TEXT id PK
        TEXT name UK "COLLATE NOCASE"
        TEXT password_hash
        TEXT password_salt
        INTEGER iterations
        TEXT created_at
    }
    sessions {
        TEXT id PK "SHA-256 of the token"
        TEXT user_id FK
        TEXT created_at
        TEXT label
    }
    tracks {
        TEXT user_id PK, FK
        TEXT key PK
        TEXT label
        TEXT full_description
        INTEGER sort_order
        TEXT role_search_line
        TEXT target_companies
        TEXT search_note
        TEXT resume_line
        TEXT fit_clause
        TEXT fit_disqualifier
        TEXT fit_filter_step
        TEXT leads_note
        TEXT doc_file
        TEXT doc_summary
        TEXT doc_update_line
        TEXT intro_note
        TEXT report_line
        TEXT screened_examples
        TEXT schedule_time
        TEXT fed_by FK
        INTEGER sweep_cursor
    }
    search_runs {
        TEXT user_id PK, FK
        TEXT track_key PK, FK
        TEXT last_run_at
        TEXT last_run_on
        TEXT status
        INTEGER leads_added
        INTEGER screened_added
        INTEGER delisted
        TEXT note
    }
    leads {
        INTEGER id PK
        TEXT user_id FK, UK
        TEXT search FK, UK
        TEXT found
        TEXT company
        TEXT title
        TEXT location
        TEXT url UK "unique with user_id and search"
        TEXT verified
        TEXT fit
        TEXT status
        TEXT notes
        TEXT team
        TEXT setup
        TEXT source
        TEXT link
        TEXT lastContact
        TEXT nextAction
        TEXT nextActionDate
        TEXT resume
        TEXT referral
        TEXT comp
    }
    screened {
        INTEGER id PK
        TEXT user_id FK, UK
        TEXT search FK, UK
        TEXT url UK "unique with user_id and search"
        TEXT company
        TEXT title
        TEXT location
        TEXT reason
        TEXT date
        TEXT added_by
    }
    applications {
        INTEGER id PK
        TEXT leadId FK "leads.id as text"
        TEXT company
        TEXT title
        TEXT dateApplied
        TEXT status
        TEXT notes
        TEXT team
        TEXT setup
        TEXT source
        TEXT link
        TEXT lastContact
        TEXT nextAction
        TEXT nextActionDate
        TEXT resume
        TEXT referral
        TEXT comp
        TEXT dateRecruiterScreen
        TEXT dateTechScreen
        TEXT dateOnsite
        TEXT dateOffer
        TEXT dateRejected
        TEXT dateWithdrawn
        TEXT user_id FK
        TEXT location
        TEXT autofill
        TEXT autofill_note
    }
    meta {
        TEXT user_id PK, FK
        TEXT key PK
        TEXT value
    }
    company_sweeps {
        TEXT user_id PK, FK
        TEXT search PK, FK
        TEXT company PK "name as written"
        TEXT last_swept
        TEXT board
        TEXT note
        INTEGER position
    }
    company_fetch {
        TEXT company_key PK "normalize of the name"
        TEXT display_name
        TEXT board
        TEXT endpoint
        TEXT url_shape
        TEXT dead_signal
        TEXT note
        TEXT verified_on
        TEXT retracted_on
        TEXT retracted_note
    }
```

## Conventions

These hold across every table, so the per-table notes below leave them out.

- Every column outside a primary key is `NOT NULL`. Unset is `''` for text and
  `0` for integers, never `NULL`.
- Columns with no default, which every insert must supply: `users.name`,
  `sessions.user_id`, `tracks.label`, `leads.user_id`, `leads.search`,
  `leads.found`, `leads.company`, `leads.title`, `leads.url`, `leads.verified`,
  `screened.user_id`, `screened.search`, `screened.url`, `screened.date`,
  `applications.dateApplied` and `meta.value`.
- `applications.user_id` is not on that list. `0002_multi_user.sql` added it
  with `ALTER TABLE`, so it defaults to `''`, and an insert that omits it
  succeeds with no owner.
- The only defaults other than `''` and `0` are `leads.status` (`New`),
  `applications.status` (`Applied`) and `users.iterations` (`100000`).
- `leads.id`, `screened.id` and `applications.id` are `AUTOINCREMENT`, unique
  across all users.
- `user_id` has its own index on `sessions`, `leads`, `screened` and
  `applications`. The other user-scoped tables lead their primary key with it.
- The diagram lists columns in the order a database built from empty holds
  them. The live D1 predates `0001_schema.sql` and holds some in a different
  order; nothing reads a column by position.

## Tables

### users

One row per account. `id` is a GUID, and is what every `user_id` holds. `name`
is for login and display only, unique regardless of case. `password_hash` and
`password_salt` are base64 PBKDF2-SHA256; an empty hash means login is disabled.

### sessions

One row per issued bearer token. `id` is the base64 SHA-256 of the token, not
the token. Sessions do not expire; logging out deletes the row. `label` says
where the token lives, such as `browser` or `scheduled-search`.

### tracks

One row per track: a tab on the page and, unless `fed_by` is set, a nightly
search of its own.

- `label`, `full_description` and `sort_order` draw the tab.
- `role_search_line` through `schedule_time` are the search config
  `server/src/prompt.js` composes the prompt from, stored as prose.
  `target_companies` is a JSON array of names; `schedule_time` is local
  `HH:mm`, read by `scripts/setup-scheduler.ps1`.
- `fed_by` names a sibling track whose search fills this tab. A track with it
  set has no search of its own.
- `sweep_cursor` is how far this track's search has read through its
  `company_sweeps` rows, by `position`.

### search_runs

One row per track, created and removed with it when config is saved: the last
run only, not a history. Written by `POST /api/runs`.

- `last_run_at` is an ISO 8601 UTC instant; `last_run_on` is the run's own
  local `YYYY-MM-DD`.
- `status` is `ok` or `error`, and `''` before any run.
- `leads_added`, `screened_added` and `delisted` count that run's work.

### leads

One row per posting a search found and verified live. Unique on
`(user_id, search, url)`; adding leads dedups on that with `INSERT OR IGNORE`.

- `found` and `verified` are `YYYY-MM-DD`: first found, and last confirmed live.
- `status` is one of `LEAD_STATUS` in `server/src/routes/leads.js`.
- `team` through `comp` are the freeform fields shared with `applications`
  (`EXTRA_FIELDS` in `server/src/db.js`).
- A posting confirmed taken down is deleted and its URL written to `screened`,
  unless an application points at the lead, which keeps it.

### screened

One row per posting a search looked at and did not add, so later runs skip it.
Unique on `(user_id, search, url)`, as `leads` is.

- `reason` is free text. A deleted delisted lead leaves the reason
  `posting taken down` (`DELISTED_REASON` in `server/src/db.js`).
- `added_by` is `run` for a row a search wrote, `hand` for a posting a person
  removed from their board, and `''` for older rows that could not be
  attributed (`0007_screened_added_by.sql`). Run records count only `run`.

### applications

One row per job applied to: created when a lead moves to `Applied`, or added by
hand.

- `leadId` is the originating `leads.id` as text, `''` if added by hand.
- `status` is one of `APP_STATUS` in `server/src/routes/applications.js`.
- `team` through `comp` are the same freeform fields as on `leads`.
- `dateRecruiterScreen` through `dateWithdrawn` record when the application
  first reached each stage; `dateApplied` covers `Applied`.
- `location` is copied from the lead when the application is created.
- `autofill` is `''` (not read yet), `filled` or `failed`, with the reason for a
  failure in `autofill_note`. The nightly fill reads rows with a `link`,
  `autofill = ''`, and a blank `company`, `title` or `location`.

### meta

Per-user key/value rows. The keys in use:

- `updated` — the day of the last data change, `YYYY-MM-DD`
- page display: `display_title`, `overview_label`, `applications_label`,
  `all_leads_label`, `stale_run_hours`
- `priority_locations` and `excluded_companies` — JSON arrays
- search prompt prose: `geo_scope_line`, `scope_clause`, `scope_disqualifier`,
  `location_guidance`, `footer_note`, `pronouns`

A setting with no row falls back to `DEFAULT_SETTINGS` in `server/src/db.js`.

### company_sweeps

One row per company in one track's rotation.

- `company` is the name as written; it reaches `company_fetch` through
  `normalize()`, above.
- `position` is the company's fixed place in this track's log, shuffled once
  (`0008_sweep_cursor.sql`). `tracks.sweep_cursor` is how far the search has
  read.
- `last_swept` is the `YYYY-MM-DD` the company was last attempted, `''` for
  never. It is a record, and does not choose what runs next.
- `board` is the JSON job-board kind once confirmed (`greenhouse`, `ashby`,
  `workday cxs`, …), `''` if none is known.
- `note` is what this search learned about the company.

### company_fetch

One row per company careers site, shared by every account. `company_key` is the
`normalize()`d name; `display_name` is the name as written.

- `board` uses the same vocabulary as `company_sweeps.board`. `endpoint` is the
  slug, host or URL template that reaches the board; `url_shape` is the shape of
  one posting's URL, where the endpoint does not imply it.
- `dead_signal` is what a stated dead posting looks like on this site, `''` for
  no known signal.
- `verified_on` is the `YYYY-MM-DD` a run last confirmed the row worked.
- A wrong row is retracted, not deleted: `retracted_on` and `retracted_note` are
  set, reads return only the retraction, and runs can no longer update the row.
