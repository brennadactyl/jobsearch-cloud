# Glossary

The words this codebase uses for its own ideas. Each entry says what the thing
is, why it exists when that isn't obvious, and where the code that defines it
lives. Tables and columns are in [`schema.md`](schema.md); the invite-to-search
flow is in [`onboarding.md`](onboarding.md).

Several ideas go by more than one name, and a few names mean more than one
thing. Those are called out in each entry and collected at the end.

## Searches and tracks

**track** - one row in `tracks`: one tab on the tracker page and, unless it is
fed by another track, one nightly search. Its `key` is a short slug, unique per
person, and every other table points at a track by that key.
The same key goes by several names:

| Name | Where |
|---|---|
| `key` | `tracks.key`, `:key` in API paths (`/api/prompt/:key`) |
| `search` | API request bodies, and the column on `leads`, `screened` and `company_sweeps` |
| `track_key` | `search_runs` |
| `-Task` | `scripts/run-search.ps1` |
| `TRACKER_SEARCH` | the environment variable `scripts/tracker.ps1` reads |
| role | the setup form, where each role becomes one track |

**tab** - one view on the tracker page. The page builds its tabs from the
person's tracks plus three built-in ones: Overview, Applications and All leads
(`client/src/domain/tabs.ts`). A lead whose `search` is not a configured track
is stored but shows on no tab.

**fed_by / root / feed group / branched search** - a track
with `fed_by` set names a sibling whose search files postings into this tab too,
so one search can fill several tabs. The track that actually runs is the
**root**. The root plus every track fed by it is one **feed group**
(`server/src/tracks.js` works out both); such a search is **branched**. Only
one level is followed, so `fed_by` should name a track that runs its own search
(`POST /api/config` checks only that it names another track in the list). A
fed track gets no scheduled task, and `GET /api/prompt/<key>` refuses it with
409. Screened rows and dedup work across the whole group, so a posting one tab
already holds isn't added to another.

**drift** - a run reporting under a track key that no configured track has,
because the task or prompt and the config have fallen out of step. The server
refuses the whole request (`unknownTrack` in `server/src/validate.js`) rather
than store rows no tab would show.

**written up** - a track whose `role_search_line` is set. Until the overnight
run writes it up, the track has no prompt and no task. See
[`onboarding.md`](onboarding.md#why-it-is-split-this-way).

## Postings

**lead** - a posting a search found and verified, in `leads`, with a status the
person moves along (`New`, `Reviewing`, `Applied`, `Not a fit`).

**screened** - a posting URL a search looked at and did not add, in `screened`.
It exists so later runs skip the URL instead of judging it again. A delisted or
hand-removed lead also leaves a screened row behind. `added_by` is `run` or
`hand`.

**dedup** - the check that a posting isn't already a lead or screened. Runs
read the list first (`GET /api/dedup/:key`), and the server checks again when
rows arrive, across the whole feed group.

**canonical URL** - the rule for when two URLs are the same posting
(`canonicalUrl` in `server/src/url.js`). A run of 5 or more digits is taken as
the req id and, with the host, is the identity. Otherwise the path and query
are, minus tracking parameters. It exists because one posting is reachable by
several URLs.

**re-check** - each night a feed group re-opens some of its open leads to
confirm they are still posted. The share is sized so every open lead comes round
within 14 nights, capped at 20 per run. A lead confirmed within the last 7 days
is skipped. The constants are in `server/src/routes/screened.js`.

**verified** - `leads.verified`, the date a run last confirmed the posting is
live (`POST /api/verified`); the page labels it "Confirmed live". Not the same
as `company_fetch.verified_on`, the date a fact about reaching a company's site
was confirmed.

**delist** - acting on a run's report that a posting is gone: the lead is
deleted and its URL written to `screened` in one transaction, so later runs
skip it and the date it came down is kept. A lead marked
`Applied`, or one an application points at, is kept (`server/src/routes/delisting.js`).

## Companies and the rotation

**company list** - `company_fetch`, one list shared by every account and
every search. A company is on the list when it has a row there. Rows are joined
by `company_key`, which is `normalize(name)` from `server/src/exclude.js`.

**rotation** - how a search works through the company list a slice at a time,
so no run starts from the top of the list each night. Only a company's
`position` on the list decides what is served (`server/src/routes/coverage.js`).

**slice / batch** - the companies one run is served tonight: the next
`COVERAGE_BATCH` (24) from the cursor, wrapping at the end, skipping excluded
companies. `?scope=batch` on dedup is a wider window of two slices.

**cursor** - `tracks.sweep_cursor`, how far along the list one search has
read. It moves only when a dated sweep is recorded, never on a read.

**cycle** - one full pass: every company in the rotation, or every open lead in
the re-checks, reached once before any is reached twice.

**sweep / swept** - one search's attempt at one company, recorded through
`POST /api/coverage` (`./tracker swept`) whether or not the fetch worked.
`company_sweeps.last_swept` is when this search last tried the company, and
its `note` is what this search learned there.

**seeding** - `POST /api/coverage` with `on: ""`: adds companies to the list
without recording a sweep. With `start_here` it also points a new search's
cursor at them.

**board** - in `company_fetch`, the kind of job board a company's listings are
served from (`greenhouse`, `ashby`, ...). Elsewhere, and on the page, "board"
also means a person's own list of leads.

**endpoint** - the slug, host or URL template that reaches a company's board.

**url_shape** - how one posting's URL is built, when the endpoint doesn't
imply it.

**wall** - a shared record that no route to a company's listings worked. It is
served to runs only once recorded on two separate dates and within seven days
of the last, so one bad night doesn't make every search skip a company. A row
reporting a wall alongside a board or endpoint shares nothing.

**dead_signal** - what a taken-down posting looks like on a given company's
site. The server stores and serves it, but `tracker.ps1` doesn't send it, so
runs don't write it.

**retracted** - a wrong `company_fetch` row is retracted rather than deleted:
reads return only the retraction, runs can't update it, and the company stays
on the list.

**known** - three meanings. The `known` object on a company in
`GET /api/coverage` holds the shared facts above. `./tracker known "<company>"`
asks whether a company is already on the list. "Already known" in dedup means a
URL that matches a lead or screened row.

**excluded_companies** - a per-person list of companies they will never work
for. It is enforced in code (`server/src/exclude.js`) as well as named in the
prompt, because a list in a prompt is only a request. Matching is on whole
words, and an entry of two characters or fewer must equal the whole name.

## Applications and the fill

**fill / autofill** - the nightly machine-wide run (`scripts/run-fill.ps1`,
task `JobSearch-Applications`) that reads the posting behind each application
logged as nothing but a URL, and fills in its empty fields. Code and the column
say `autofill`; scripts, task names and the page say fill.
`applications.autofill` is `''` (not read yet), `filled` or `failed`.

**waiting / stuck** - an application's fill state on the page (`fillState` in
`client/src/domain/rows.ts`). **waiting** means tonight's fill will read it.
The test must match `getAutofillQueue` in `server/src/db.js`, or a row promises
a fill no run attempts. **stuck** means the fill failed and no run will retry,
so the person types it in. Unrelated to the `waiting` drill, which means waiting
on the company to reply.

**sent vs Applied** - the status `Applied` is one stage. "Sent" (`sent` in
`client/src/domain/drills.ts`) is any application past `To Apply`, including
interviews, offers and rejections, and it is what the Overview's "Applied"
counts use.

## Runs and scheduling

**run** - one headless `claude -p` session. A search run is `run-search.ps1`
for one track; the fill and onboarding runs each cover every account on the
machine.

**run record** - `search_runs`: one row per track holding its last run only
(`POST /api/runs`, `./tracker run`), returned as `last_run` on each track by
`GET /api/config`. It exists to tell "ran and found nothing" from "stopped
running". Counts are computed by the server from that day's rows.

**stale** - a track tab whose last run is older than `stale_run_hours`
(default 36) shows an amber dot; a last run that reported an error shows red
(`client/src/domain/runs.ts`). A track that has never run is not flagged.

**run lock** - a named mutex (`scripts/run-lock.ps1`) that makes a search or
fill wait for the one already running, because every run on the machine shares
one Claude CLI account. `run-search.ps1` and `run-fill.ps1` take it.

**`./tracker`** - `scripts/tracker.ps1`, copied into each run directory. The
prompt makes every API call through it, and it stamps the track key and local
date on each.

**purge** - `POST /api/purge` (ADMIN_TOKEN only): deletes every row a removed
track left behind. Removing a track from config alone keeps them.

## Documents and folders

**baseline doc** - a track's Markdown doc, stored in R2 at
`<user-id>/docs/<file>`. `tracks.doc_file` names it, falling back to
`docs/tracked_<key>_postings.md`. A run reads it first and may edit it; it
holds judgement the database has no column for. Not the repo's `docs/` folder.
(`run-search.ps1` also calls its pre-run snapshot of `last_run.at` a baseline.)

**documents / kind** - a person's files live in three folders: `docs`,
`resumes` and `reference`. A document's `kind` is its first path segment. Every
run downloads all three, and only `docs/` edits are written back.

**data dir / silo** - the private folder outside git that the scripts work in:
`-DataDir`, else `JOB_SEARCH_DATA_DIR`, else `private\` at the repo root. It
holds one folder per user id (`tracker.json`, `logs\`), plus machine logs and
`deployment.json`. "Silo" is the same folder, named in the scripts' help text.
Layout: [`../private.example/README.md`](../private.example/README.md).

**run dir** - `<DataDir>\<user-id>\.run\<key>`, wiped and refilled every run
with that person's documents and `./tracker`. The CLI runs inside it.

## The tracker page

**drill** - a named rule that narrows a tab to some of its rows (`waiting`,
`tier:0:open`, ...), carried in the `?drill=` URL parameter
(`client/src/domain/drills.ts`).

**drill invariant** - an Overview figure and the rows it opens come from one
predicate: the count is `drillRows(...).length`, never a second copy of the
rule, so a number and its list cannot disagree. `drills.test.ts` enforces it.

**Open filter** - a leads tab's default status filter: `New` or `Reviewing`,
the leads still waiting on a decision. `All` shows every status.

**location tier / priority / geo / area** - one idea under several names.
`priority_locations` is the places a person wants searched first, as they typed
them, in rank order. Each lead and application carries an `area`: the entry of
that list the nightly run placed it in, kept only when it matches an entry
exactly, ignoring case (`storedArea`). A row's tier is its area's position in
the list, 0 highest; a row with no area, or an area no longer ranked, has no
tier and sorts last (`client/src/domain/geo.ts`). The default Priority sort
puts `Not a fit` last, then orders by tier, then newest.

**location settings** - `search_locations`, `excluded_locations`,
`priority_locations` and `location_note`: where a person's searches look, as
they typed it, printed into every prompt and combined by a fixed rule. See
[`onboarding.md`](onboarding.md#where-a-search-looks).

## Accounts

**onboarding / setup / intake / write-up** - onboarding is the whole path from
invite to working search. The setup form's answers are stored as the person's
**intake** (`intake` table), and sending them creates their tracks. The
**write-up** is the overnight run's half: the prose on each track, written
through `POST /api/writeup`. See [`onboarding.md`](onboarding.md).

**session / search token** - a bearer token in `sessions`, labelled by where it
lives: `browser` for a sign-in, `scheduled-search` for the one in a machine's
`tracker.json`. Either reads and writes everything its account owns.

**ADMIN_TOKEN** - the deployment's operator secret. It creates accounts,
mints invites and search tokens, resets passwords and purges retired tracks.
It never signs anyone in. Machine copy: `deployment.json`.

**demo account** - `users.demo = 1`: an account whose data is invented, for
showing the page. It cannot write to the shared company list or send setup, so
invented companies never reach real searches.

## Names with more than one meaning

| Name | Meanings |
|---|---|
| search | a track key; one nightly run; the page's text search box |
| task | a track key (`-Task`); a Windows Scheduled Task (`JobSearch-<id8>-<key>`) |
| board | a company's job board kind; a person's own list of leads |
| batch | a slice of 24; two slices in `?scope=batch` |
| known | coverage's facts object; the `./tracker known` command; a URL already in dedup |
| baseline | a track's doc; `run-search.ps1`'s snapshot of the last run record |
| setup | the setup form; a lead or application's work arrangement field; `setup-scheduler.ps1`; the job-search-setup skill |
| waiting | an application's fill state; the drill for applications waiting on the company |
| verified | `leads.verified` (posting live); `company_fetch.verified_on` (a site fact) |
