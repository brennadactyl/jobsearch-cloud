# Retire companies from the rotation

Every search reads the whole shared company list, about once a month. Some
companies have given no search anything - no lead and no screened posting -
after many searches have looked, and each one still costs every search a slot
in every cycle. Retiring a company takes it out of the rotation and keeps its
row, so a run that meets it again finds it on the list and doesn't add it back.

Owner: Backend Buddy, with a one-line wording change for Prompt Bro. The
selection is Product Partner's.

## The column

`company_fetch` gains `retired_on` (`YYYY-MM-DD`, `''` for not retired) and
`retired_note` (why, in a sentence). A new migration; `docs/schema.md` in the
same change.

- Retirement is not retraction. A retracted row is a wrong row whose facts are
  withdrawn; a retired row is a right row that isn't worth a slot. A retired
  company keeps its board, endpoint and shape, and runs can still update them.
- Retirement is not exclusion. `excluded_companies` is a person's choice and
  hides that company's leads; a retired company's leads are kept, and a run that
  finds a posting there by any other path records it as usual.

## The slice

`handleGetCoverage` and `upcomingCompanies` in `server/src/routes/coverage.js`
drop retired companies before `sliceAt`, the way excluded companies are dropped,
so they don't use up slots. The cursor is compared against `position`, so the
gaps they leave are ordinary and no search skips or repeats a stretch.

- `GET /api/coverage/<key>?all=1` still lists retired companies, marked
  `retired`, because that is what `./tracker known` checks a name against: a
  retired company missing from it would be added again as new.
- `POST /api/coverage` accepts a report on a retired company and records it
  like any other; it does not un-retire it.

## Retiring and restoring

`POST /api/companies/retire`, `ADMIN_TOKEN` only, beside
`/api/companies/cleanup` in `server/src/routes/admin.js`. Body
`{ companies: [names], note, restore?: true, dryRun?: true }`. Names are
matched through `normalize()` and aliases; any name not on the list refuses the
whole request, naming it. A dry run returns what would change, per company, and
writes nothing. Restoring clears both columns.

Verifiers in `server/verify-local.mjs`, both paths: a retired company is absent
from a search's slice and present in `?all=1`; a report on it is recorded and
leaves it retired; restoring puts it back in the slice at its old position; an
unknown name refuses the request and changes nothing.

## The `known` wording

`scripts/tracker.ps1` tells a run a listed company's "turn comes in the
rotation", which is false for a retired one. When `?all=1` marks a company
`retired`, `known` says it is on the list and retired from the rotation, and to
skip it. Prompt Bro; ships on the pull, after the server change is deployed.

## The selection

Read from a backup across every account, never from one account's page: a
company is a candidate when no lead, application or screened row anywhere names
it (through aliases), and either it has a recorded wall or at least six searches
have swept it. A company in any search's `target_companies` is never a candidate.
The list goes to the user as names before the dry run, and the dry run's answer
goes to her before the write.

## Not being done

Deleting rows, which would let runs re-add them. A per-search cadence that
visits a company less often after it keeps coming up empty for that search -
the larger saving, and its own plan.
