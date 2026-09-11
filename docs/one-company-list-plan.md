# One company list

There is one list of companies. A search keeps an index into it, not a copy of
it.

## Context

Each search owns its own rotation today, and the four have drifted apart:

```
engineering-management   56      SWE   71
product                  66      CPM   79
```

272 rows covering 139 distinct companies — 1.96x duplication. 22 companies sit
in all four rotations, 49 in two, 59 in exactly one. The same website facts get
written four times into four `note` fields: adding six sports companies on
2026-09-11 wrote NFL's Greenhouse token and Fetch's JS-shell wall into four
copies of user-scoped storage.

The list is global — one list across every person, not one per account.

`COVERAGE_BATCH` goes from 12 to 24. A merged list of 139 at 12 a night is a
12-day cycle; at 24 it is 6, which is where the four rotations sit now.

## The schema

Every table, as it stands after this plan. Three changes are marked; everything
else is today's shape.

There are no `FOREIGN KEY` constraints in this database. The lines below are
relationships the code maintains, not ones SQLite enforces — which is why
`verify-local.mjs` spends most of its checks proving one user's rows cannot
reach another's. `company_sweeps` joins `company_fetch` through
`normalize()` from `exclude.js`, not on a raw string.

```mermaid
erDiagram
    users          ||--o{ sessions       : "signs in with"
    users          ||--o{ tracks         : owns
    users          ||--o{ leads          : owns
    users          ||--o{ screened       : owns
    users          ||--o{ applications   : owns
    users          ||--o{ meta           : owns
    users          ||--o{ company_sweeps : owns
    tracks         ||--|| search_runs    : "last run of"
    tracks         ||--o{ company_sweeps : "rotation state of"
    tracks         ||--o{ leads          : "filed under"
    tracks         ||--o{ screened       : "filed under"
    tracks         |o--o| tracks         : fed_by
    leads          ||--o| applications   : "applied to"
    company_fetch  ||--o{ company_sweeps : "swept by"

    users {
        TEXT id PK
        TEXT name
        TEXT password_hash
        TEXT password_salt
        INTEGER iterations
        TEXT created_at
    }
    sessions {
        TEXT id PK
        TEXT user_id FK
        TEXT created_at
        TEXT label
    }
    tracks {
        TEXT user_id PK
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
        TEXT user_id PK
        TEXT track_key PK
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
        TEXT user_id FK
        TEXT search FK
        TEXT url UK
        TEXT found
        TEXT company
        TEXT title
        TEXT location
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
        TEXT user_id FK
        TEXT search FK
        TEXT url UK
        TEXT company
        TEXT title
        TEXT location
        TEXT reason
        TEXT date
        TEXT added_by
    }
    applications {
        INTEGER id PK
        INTEGER leadId FK
        TEXT user_id FK
        TEXT company
        TEXT title
        TEXT location
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
        TEXT autofill
        TEXT autofill_note
    }
    company_sweeps {
        TEXT user_id PK
        TEXT search PK
        TEXT company_key PK "was company - now the normalize() key"
        TEXT last_swept
        TEXT note
    }
    company_fetch {
        TEXT company_key PK
        INTEGER position "moved here from company_sweeps"
        TEXT display_name
        TEXT board "no longer also on company_sweeps"
        TEXT endpoint
        TEXT url_shape
        TEXT dead_signal
        TEXT note
        TEXT verified_on
        TEXT retracted_on
        TEXT retracted_note
    }
    meta {
        TEXT user_id PK
        TEXT key PK
        TEXT value
    }
```

`company_fetch` is the only table with no `user_id`. `meta` holds the per-user
prose settings the prompt reads; `sessions` holds bearer tokens.

## The approach

### 1. Membership becomes global

`company_fetch` is the list. It is already global, already keyed by
`company_key`, and already carries `display_name`. It gains one column:

```sql
ALTER TABLE company_fetch ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
```

A company is on the list when it has a row. `position` moves here from
`company_sweeps` so every search's cursor indexes the same log. Assign positions
shuffled, per `0008_sweep_cursor.sql` — a list is typed in alphabetically or
grouped by theme, and position decides who is covered first every cycle and who
is dropped when a run runs short.

Two things follow, and both are behaviour changes rather than renames.

`db.upsertCompanyFetch` refuses to write a row unless it carries a fact
(`board || endpoint || url_shape || dead_signal || note`) — "a typed list is not
evidence". Registering a company is now exactly that write, so the guard becomes
membership-first: create the row, facts optional.

`handleGetCoverage` attaches `known` whenever a row exists. With membership rows
that would hand a run an empty `known` and imply something is known about a
company nothing has looked at yet. Attach it only when a fact field is populated.

### 2. What stays per search

`company_sweeps` keeps `(user_id, search, company_key, last_swept, note)` and
loses `company`, `board` and `position`. `tracks.sweep_cursor` stays as it is —
how far this search has read.

`note` stays, explicitly. It holds what a search learned about a company for
itself — "65 reqs reconfirmed via Greenhouse board, 2 existing tracked leads
still open", "no open backend/SWE roles, reconfirms stable no-roles state" — and
243 of 272 rows carry one, 50,755 characters. It has no other home:
`upsertCompanyFetch` deliberately excludes it because "prose is where a search's
own reasoning leaks", so dropping it here deletes it. Step 9d also tells every
run that `note` "stays on this search's row", which would stop being true.

This resolves issue #2. `board` lives in `company_fetch` only.

### 3. The batch doubles

`COVERAGE_BATCH` 12 → 24, holding the cycle at 6 days.

`0005_company_sweeps.sql` picked 12 as "what one run can actually verify
properly". Runs currently cover 12 in 700–1500s, so 24 is roughly double the
work in a night. Read the run lengths and the sweep counts for the first week
and move the number if runs start finishing short.

Read step 9e before the batch number takes the blame. It re-fetches when
companies in a slice were unreadable, so a bad night compounds on top of 24
rather than 12 — CPM swept 39 across three batches on 2026-09-11 with the batch
still at 12.

### 4. Migration

Merge the four rotations into one list of 139, keyed by `normalize()`. Preserve
every search's `last_swept` per company, so no search re-sweeps its whole list
the first night. Set each search's cursor to its position in the new log.

Two facts currently duplicated across four `note` fields move into
`company_fetch` by hand, since they are what the table is for and neither is
there yet:

- NFL — Greenhouse token `nflcareers`, 43 jobs, full JD in the API
- Fetch — `jobs.gem.com/fetch` serves the same 4.8KB JS shell for the board and
  every detail page, no JSON-LD, no `og:description`; `fetch.com/careers/jobs`
  is plain-fetchable at ~2MB and carries titles

## The privacy boundary this changes

`0010_company_fetch.sql` forbids company lists in shared storage: "a person's
target companies are their strategy". That holds while the lists differ. Under
one global list, membership distinguishes nobody — but it is not nothing, and
the header should say what it now is rather than being left to contradict the
schema.

What becomes public is the union. Each person knows what they added, so the
remainder is attributable to "one of the other two" — and better than an even
guess, because the companies are characteristic: a games studio or a
sports-betting company that someone did not add is not a coin flip between two
strangers, and under pooled discovery its presence also says a run surfaced it
recently. Attribution degrades rather than holding.

What does stay scoped is the record of who looked and when: `last_swept`, the
cursor and `note` remain per user and per search. Say it that way in the header.
A rule that overstates its own protection is the kind people rely on.

Amend 0010's header in the same change. A rule that no longer describes the
schema is worse than no rule.

## Files

- `server/migrations/00NN_one_company_list.sql` — `position` added to
  `company_fetch`, `company_sweeps` reduced
- `server/migrations/0010_company_fetch.sql` — header amended
- `server/src/db.js` — `getCoverage`, `recordSweeps`, `setSweepCursor`,
  `countCoverage` against the new shape; `upsertCompanyFetch` writes membership
  without requiring a fact
- `server/src/routes/coverage.js` — `COVERAGE_BATCH`, and the response keeps its
  shape
- `server/README.md` — the coverage contract

## Verification

`verify-local.mjs`: two users' searches draw from the same list, each keeps its
own `last_swept` and cursor, one search sweeping a company does not stamp it for
another, and a company registered by one account appears in another's rotation.

The response shape `{companies, total, batch, cursor}` does not change, so
`./tracker companies` and the prompt's step 1c are untouched.

## Not in scope

Whether a company with a confirmed board should stop consuming a rotation slot.
It would change the revisit rate again and is worth its own decision once the
batch change has a week behind it.

A shared field for a wall. "DraftKings 403s a plain fetch", "Sportradar renders
a client-side shell", "NBA's Phenom site exposes no JSON endpoint", "ESPN hires
through Disney" are facts about websites and poolable in principle, but nothing
in `company_fetch` holds them: `board` and `endpoint` describe a board that
works, `dead_signal` describes a dead posting, and its `note` column is never
written. So they stay in per-search notes and every search rediscovers them —
the expensive kind, since a negative result is what somebody already spent a
night proving.
