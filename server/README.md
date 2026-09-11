# Job Search Tracker API (Cloudflare Worker + D1)

The API-only backend: a JSON API over Cloudflare D1 (SQLite). Every lead,
application and screened posting is its own row with its own atomic write, so
a search posting new leads while someone edits a status can't clobber either
change, and the headless search CLI can update it with a `curl` call.

This worker serves **no HTML**. The tracker webpage is
[`../client/`](../client/), a separate Worker serving static assets from its
own origin and calling this API cross-origin (CORS is on, see `src/http.js`).
Server and client deploy independently, as long as both match the API below.

No personal data lives in this repo - it lives only in D1 once deployed.

One deployment holds **any number of people's job searches**. Every row
carries a `user_id`, and every request is scoped to whoever's token made it,
so people sharing a worker and a database see entirely separate tracks,
leads, applications, page titles and location rules.

## Code layout

- `src/index.js` - the entry point: the CORS preflight (`OPTIONS`), resolving
  the caller's session, building the one `Db` scoped to that person, and
  dispatching to the route table. It knows about no individual endpoint.
- `src/routes/index.js` - the route table: which method and path map to which
  handler, in two lists split by whether the caller is known yet. Adding an
  endpoint is one line here plus one exported function in the module beside
  it.
- `src/routes/*.js` - one module per resource (`leads.js`, `applications.js`,
  `screened.js`, `config.js`, `coverage.js`, `runs.js`, `prompt.js`,
  `data.js`, `documents.js`, `accounts.js`, `admin.js`, `update.js`,
  `delisting.js`). Each holds its endpoints' parsing, validation and response
  shaping, with each endpoint's contract documented on its handler. None
  touches D1 - every one is handed a `Db`.
- `src/http.js` - every `Response` this worker builds: `json()`, `text()`, the
  two canned refusals, and `CORS_HEADERS` on all of them. Route modules never
  construct a `Response` themselves, or their error replies lose the CORS
  header.
- `src/validate.js` - the checks more than one route makes: `isoDate`, the
  unknown-track refusals, the exclusion matcher, `isDocumentPath`.
- `src/auth.js` - passwords (PBKDF2 via Web Crypto), session tokens, and
  looking a bearer token up to a user. The only file that touches either.
- `src/db.js` - all D1 access for a person's own data. Every instance is
  bound to one user id at construction, so no query can forget to filter.
- `src/r2.js` - all R2 access for their documents: resumes, and the per-track
  baseline doc the nightly search reads and edits. Every key is prefixed with
  the owner's id at construction, so no method can address another person's
  object. A key is `<user-id>/<relative path>`, with no table beside it: `kind`
  is the first path segment and R2's own `list()` returns the rest.
- `src/prompt.js` - composes the two prompts the scheduled runs execute:
  `buildSearchPrompt`, one track's daily search, from that track's config; and
  `buildAutofillPrompt`, the nightly fill for applications logged as a bare
  URL, which is the same text for everybody.
- `verify-local.mjs`, `verify-migration.mjs`, `verify-schema-doc.mjs` - the
  checks to run before a deploy. See [Verifying a change](#verifying-a-change).
- `migrations/` - the numbered schema migrations. What they build, table by
  table, is [`../docs/schema.md`](../docs/schema.md).

## One-time setup

You need to do the account creation and login yourself - not something that
can be done on your behalf.

> **PowerShell and "running scripts is disabled on this system".** Windows'
> default execution policy blocks the PowerShell shims Node installs, so `npm`,
> `npx` and a globally installed `wrangler` all fail that way - including
> `npm run deploy`. The `.cmd` beside each one is unaffected
> (`npx.cmd wrangler ...`, `npm.cmd run deploy`), or allow local scripts once
> with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Commands here are
> written plainly and work as shown in `cmd.exe` and Git Bash.

### First: turn on R2

**Do this before either path below.** This worker binds an R2 bucket for
documents - resumes and each track's baseline doc (see [`src/r2.js`](src/r2.js)).
R2 is off by default on a new Cloudflare account, and nothing can create a
bucket until it is switched on: the deploy button's auto-provisioning and
`wrangler` alike fail with

```
Please enable R2 through the Cloudflare Dashboard. [code: 10042]
```

To enable it: **[dash.cloudflare.com](https://dash.cloudflare.com/) → R2 Object
Storage** (under **Storage & databases**) **→ Overview**, then complete the
checkout flow to add an R2 subscription. Cloudflare wants billing details on
file, but the subscription has a free allowance - 10 GB of storage, 1 million
writes and 10 million reads a month, no egress charges - and this deployment's
documents run to about a megabyte.

Confirm it took (in PowerShell, `npx.cmd` - see the note above):

```bash
npx wrangler r2 bucket list
```

An empty list is the answer you want. The 10042 above means it did not take.

Without R2 the tracker still runs: every other endpoint works, and the four
`/api/documents` routes answer 503 saying documents are not configured. The
searches then need their baseline docs and resumes on the machine that runs
them.

### Quick deploy (recommended)

No Node.js or `wrangler` CLI required locally - the build/deploy happens in
Cloudflare's own environment.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/server)

1. Click the button, sign in to Cloudflare (creates a free account if you
   don't have one), and accept the defaults on the setup page it shows you.
2. It forks this `server/` directory into a new repo in your own GitHub, and
   reads `wrangler.toml` to auto-provision a D1 database (filling in
   `database_id` for you) and the R2 documents bucket. `package.json`'s
   `deploy` script (`wrangler d1 migrations apply DB --remote && wrangler
   deploy`) runs the schema migrations and deploys in one step.

   The bucket is only auto-provisioned if you enabled R2 first - see above.
   Skip that and this step is where it fails.
3. It lands you on your new Worker's dashboard. Go to **Settings → Variables
   and Secrets** and add a secret named `ADMIN_TOKEN` - any long random value
   you pick (a password generator, or `-join ((48..57)+(97..122)|Get-Random
   -Count 40|%{[char]$_})` in PowerShell). It is **not** a login: it's the
   operator credential that creates accounts and resets passwords, nothing
   else.
4. Your Worker's URL is shown on that same dashboard page (something like
   `https://job-search-tracker.<your-subdomain>.workers.dev`). You'll need it
   for the client (see [`../client/README.md`](../client/README.md)) and in
   each person's `tracker.json` on whatever machine runs their searches.
5. **Create your account** - see [Accounts](#accounts) below. A fresh database
   has none, and there is no sign-up page.
6. Now deploy the client - see [`../client/README.md`](../client/README.md).
   It's a separate one-click deploy; this worker alone has no webpage.

### Manual setup (alternative, or for updating an existing deployment)

1. **Create a free Cloudflare account** at https://dash.cloudflare.com/sign-up
   (if you don't have one already).

2. **Install Wrangler** (Cloudflare's CLI) and log in:
   ```bat
   npm install -g wrangler
   wrangler login
   ```

3. **Create the D1 database:**
   ```bat
   cd server
   wrangler d1 create job-search-tracker-db
   ```
   It prints a `database_id`. Paste it into `wrangler.toml`, replacing
   `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

4. **Create the documents bucket:**
   ```bat
   wrangler r2 bucket create job-search-tracker-docs
   ```
   There is no id to paste - `wrangler.toml` binds it by name, so the name
   must match. `[code: 10042]` means R2 is not enabled on the account yet; see
   [First: turn on R2](#first-turn-on-r2).

5. **Apply the schema:**
   ```bat
   wrangler d1 migrations apply job-search-tracker-db --remote
   ```
   Every table, no seed data, and no accounts. Tracks, page title and priority
   locations are set later via `/api/config` (the `job-search-setup` skill
   does it); the page is empty until then.

6. **Set the admin token.** This creates accounts and resets passwords; it is
   not a login and nothing else accepts it. Pick a long random value:
   ```powershell
   -join ((48..57)+(97..122)|Get-Random -Count 40|%{[char]$_})
   ```
   Then:
   ```bat
   wrangler secret put ADMIN_TOKEN
   ```

7. **Deploy:**
   ```bat
   wrangler deploy
   ```
   Prints your live URL, something like
   `https://job-search-tracker.<your-subdomain>.workers.dev`.

8. **Create your account** and mint the token your scheduled searches will
   use - see [Accounts](#accounts) below.

9. **Deploy the client** - see [`../client/README.md`](../client/README.md).

## Accounts

There is no sign-up page. Whoever operates the deployment creates accounts
with the `ADMIN_TOKEN` secret.

Anyone signed in changes their own password from the tracker page - see
[Changing your own password](#changing-your-own-password). The admin path is
for new accounts and forgotten passwords.

**Create someone (or reset their password)** - the same call either way:

```bash
curl -s -X POST "$TRACKER_URL/api/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Their Name","password":"a-long-password-they-pick"}'
```

Returns `{"id": "<guid>", "name": "...", "created": true|false}`. The id is
what every row of theirs is keyed by and never changes, so a password reset
or a rename leaves their data alone. Passwords must be at least 12
characters - `/api/login` has no rate limiting, so length is the whole
defence (see [Security](#security-notes)).

**Sign in** - the webpage does this for them. Do it by hand once per machine
that runs their searches, to mint the long-lived token for the scheduled
runs:

```bash
curl -s -X POST "$TRACKER_URL/api/login" -H "Content-Type: application/json" \
  -d '{"name":"Their Name","password":"...","label":"scheduled-search"}'
```

Returns `{"token": "...", "user": {...}}`. Put that token, with the worker
URL, in `<data dir>/<their id>/tracker.json` (see
[`../private.example/README.md`](../private.example/README.md)). Never put the
password itself on disk.

### Changing your own password

Signed in, from the page: click "Signed in as ..." in the header. It posts
`POST /api/password` with `currentPassword` and `newPassword`, and needs the
current password as well as the session.

Other sessions survive the change, including the scheduled search's token in
`tracker.json` - revoking it would stop that person's nightly search without
any error. `signOutOthers: true` revokes only this person's other browser
sessions (label `browser`), never the one making the request.

### Revoking and listing sessions

**Revoke one credential.** Sessions are labelled, so a leaked scheduled-search
token can be dropped without signing out anyone's browser:

```bash
wrangler d1 execute job-search-tracker-db --remote \
  --command "DELETE FROM sessions WHERE user_id = '<guid>' AND label = 'scheduled-search'"
```

**See who exists, and what they hold.** `sessions.id` is a SHA-256 of the
token, not the token, so this (and a `d1 export`) hands out nothing usable:

```bash
wrangler d1 execute job-search-tracker-db --remote \
  --command "SELECT u.name, s.label, s.created_at FROM users u LEFT JOIN sessions s ON s.user_id = u.id ORDER BY u.name"
```

Sessions have no expiry and nothing prunes them, so a person who signs in
from many browsers accumulates rows. `DELETE FROM sessions WHERE user_id =
'<guid>'` signs that person out everywhere.

## Updating after code changes

**Always deploy from `main`, never from a feature branch or worktree** -
merge `main` and push first, then deploy from a checkout on `main`.
`wrangler deploy` and `wrangler d1 migrations apply --remote` push whatever is
on disk, so a branch deploy leaves the live Worker running code that isn't in
`main`'s history. Run the [checks](#verifying-a-change) first.

```bat
cd server
wrangler deploy
```

### Schema changes

Schema changes are numbered migrations in `migrations/`. Wrangler records
which have run, so `apply` executes only new ones. Write one by following
[`../.claude/skills/add-d1-migration/SKILL.md`](../.claude/skills/add-d1-migration/SKILL.md).
What the migrations build is [`../docs/schema.md`](../docs/schema.md) - update
it in the same change.

**Never edit a migration that has been applied.** Wrangler skips it, so the
change silently never lands.

A schema or API change only requires redeploying `server/`; `client/` needs a
redeploy only if it uses the new field or route. Keep the API additive (new
optional fields, new routes) where you can, so old clients don't break
against a newer server, and note any breaking change in the commit and in the
API section below.

## API

Used by the search scripts (see
[`../private.example/README.md`](../private.example/README.md)) and by the
client ([`../client/`](../client/)).

Every route except the three marked otherwise needs `Authorization: Bearer
<session token>`, and every one of them is **scoped to whoever that token
belongs to**. There is no user id in any request: another person's lead id,
application id or track key doesn't resolve, and comes back as a 404.

### Auth

- `POST /api/login` - **no auth** - body `{ name, password, label? }` -> `{ token, user: { id, name } }`, or `401` for both a wrong password and an unknown name (keep them indistinguishable, or the reply enumerates accounts). `label` records what the token is for (`"browser"`, `"scheduled-search"`) so it can be revoked by purpose; defaults to `"browser"`. Tokens don't expire.
- `POST /api/logout` - revokes **only the token that made the request**.
- `POST /api/users` - **`ADMIN_TOKEN` as the Bearer, not a session** - body `{ name, password, demo? }` -> `{ id, name, created, demo }`: creates an account with a fresh GUID (`201`), or sets an existing name's password (`200`), which makes it the password reset too. Minimum 12 characters. `demo: true` marks an account whose data is invented, which `POST /api/coverage` then refuses; omitted, a new account is a person and an existing one keeps what it was. See [Accounts](#accounts).
- `POST /api/password` - body `{ currentPassword, newPassword, signOutOthers? }` -> `{ ok, signedOut }`. Changes the caller's own password; needs the current password as well as the session. `403` for a wrong current password, `400` for a new one under 12 characters or identical to the old. Other sessions survive unless `signOutOthers: true`, which revokes only this person's other `browser`-labelled sessions and reports how many in `signedOut`. See [Changing your own password](#changing-your-own-password).
- `GET /api/me` -> `{ id, name }` - who this token belongs to.

### Data

- `GET /api/data` -> `{ user, updated, leads[], applications[], screened[], tracks[], settings }` - everything the page renders, for this person only. `user` is `{id, name}`.
- `POST /api/leads` - body `{ "on": "YYYY-MM-DD", "leads": [ {search, company, title, location, url, fit, team, setup, comp} ] }` -> `{ added, duplicates, excluded }`. Appends only postings this person doesn't already have under that search. Dedup matches the canonical URL (`src/url.js`) as well as `UNIQUE(user_id, search, url)`, so a `?gh_jid=` suffix, a slug or a tracking param is still a duplicate. Dedup is per search, not per tab: a branched run can't file one posting into two of its tabs, while two independent tracks each keep their own row. Companies on `excluded_companies` are dropped. `on` is the caller's local date and stamps `found`/`verified`. Never touches an existing row's status or notes. `team`/`setup`/`comp` are optional - omit them unless the posting states them. Other Details fields (referral, resume, lastContact, nextAction*, link) are accepted but are for the person to enter; search scripts don't send them. Every distinct `search` must be one of this person's configured tracks (a fed tab counts); an unknown key is a 404 naming it, and nothing in the payload is inserted.
- `POST /api/screened` - body `{ "search": "SWE", "on": "YYYY-MM-DD", "screened": [ {search, url, company, title, location, reason} ] }` -> `{ added, duplicates, excluded }`. Records postings a search looked at and rejected (dead on arrival, out of scope, wrong level, duplicate), so the next run's dedup skips them. Same canonical dedup, exclusion handling and configured-track check as `/api/leads` (unknown key: 404, nothing inserted); the check applies to the `search` sent, and rows for a fed tab are then filed under the track that feeds it. **Send `on`**: `/api/runs` counts a day's screened rows by it, and without it an evening run's rows take the worker's UTC date and the run records screening nothing. `reason` is free text except `"posting taken down"`, which is reserved for delistings and rewritten if a caller sends it.
- `POST /api/runs` - body `{ "search": "SWE", "status": "ok"|"error", "on": "YYYY-MM-DD", "note": "..." }` -> `{ ok, run, also }`. **Call it at the end of every run, including runs that found nothing** - without it a search that stopped firing looks like a quiet day. `leadsAdded`, `screenedAdded` and `delisted` are counted server-side from that track's rows dated `on`; values sent for them are ignored. It also records a run for every tab this search feeds (`fed_by`), returned in `also`. `on` is the caller's local date. `status: "error"` marks a run that couldn't do its job, which the page shows as a warning. 404 on a `search` that isn't one of this person's tracks.
- `POST /api/update` - body `{ "type": "lead", "id": ..., "status": "...", "notes": "...", "search": "...", "delistedOn": "..." }` or `{ "type": "application", "id": ..., ... }`. Every field is optional and is a plain field write, except two on a lead:
  - `delistedOn` reports that the posting is gone. It must be `YYYY-MM-DD`, else `400`. A lead no application points at is deleted and its URL added to `screened`: `{"removed": true, "screened": "<url>"}`. A lead an application points at is kept: `{"removed": false, "lead": {...}}`, and a repeat report of a deleted lead also returns `false`. Irreversible - the way back is `/api/unscreen`. The rule lives in `routes/delisting.js`.
  - `search` moves the lead to another of this person's tabs: `404` for a track key they don't have, `409` if that tab already holds the URL.
- `POST /api/leads/:id/status` - body `{ status }` - validates against `LEAD_STATUS`; if the new status is "Applied", atomically also creates the matching application row unless one already exists.
- `POST /api/applications/:id/status` - body `{ status }` - validates against `APP_STATUS`; stamps the matching Stage history date if that column is still empty.
- `POST /api/delete-application` - body `{ "id": ... }` - removes one application row.
- `POST /api/verified` - body `{ search, on?, urls: [...] }` -> `{ stamped, unmatched, unmatchedUrls, on }` - stamps `verified` on the tracked postings a run re-checked and found still live. URLs are matched by canonical URL (`src/url.js`), not raw string. An `on` that isn't `YYYY-MM-DD` falls back to the worker's UTC date.
- `POST /api/delist` - body `{ search, on, urls: [...] }` -> `{ removed, kept, unmatched, unmatchedUrls, on }` - every posting a run confirmed taken down, in one call. Matched like `/api/verified`. Each matching lead is deleted and its URL written to `screened` as `"posting taken down"`, unless an application points at it (`kept`) - the same rule as `delistedOn`. `on` must be `YYYY-MM-DD` or the whole call is a 400.
- `POST /api/unscreen` - body `{ search, urls: [...] }` -> `{ removed, urls, unmatched }` - deletes `screened` rows so those postings can be found again; the way back from a wrong delisting or screening, and the only route that makes a posting rediscoverable. `search` resolves through `fed_by`, so it covers every tab that search fills. Keep it out of every prompt: a run that can clear its own screened rows can re-add correct rejections.

#### Applications added as nothing but a URL

The tracker page can log an application from its URL alone, and a nightly
task fills in the rest: **one task per machine**, not per person
(`JobSearch-Applications`, running `scripts/run-fill.ps1` against the
`_applications` prompt below). It covers every account in one CLI turn,
pulling each account's outstanding rows and giving each posting to its own
subagent.

Nothing about this is shown on the page except `autofill_note`, on a row that
was partly read or not read at all. `applications.autofill` is `''` (not read
yet), `filled` or `failed`. A run gets the rows with a link, `autofill = ''`,
and a blank company, role or location. Each posting is read once; nothing
retries.

- `GET /api/applications/pending` -> `{ applications: [{id, link}] }` - the rows tonight's run should read, chosen by the server by the rule above. An empty list is the ordinary answer and means stop.
- `POST /api/applications/autofill` - body `{ filled: [{id, company, title, location, team, setup, comp, note?}], failed: [{id, reason}] }` -> `{ filled, failed, unmatched: [id] }`. A partial read is a `filled` entry with a `note` saying what's missing; `failed` is for a posting that yielded nothing. **Writes only into columns that are still empty**, so anything the person typed wins. Only rows still at `''` change, so an id in `unmatched` was deleted or already reported - nothing to retry. A `filled` entry with no usable field still marks the row read. `filled` and `failed` are final; the note or failure reason is stored in `autofill_note`, which the page shows on that row.
- `POST /api/applications/requeue` - body `{ ids: [...] }` -> `{ requeued }` - clears the read flag on the named rows so the next run reads them again. Not a retry: nothing on the page or on a schedule calls it, and it takes explicit ids only. Use it after improving the reader, for rows that failed under the old instructions.
- `GET /api/prompt/_applications` -> **`text/plain`** - the nightly fill's prompt (`src/prompt.js`'s `buildAutofillPrompt`). A reserved key, not a track: the leading underscore keeps it out of the names installers choose for tracks, and its route must stay above the track pattern in `src/routes/index.js` or that pattern swallows it. The only route whose body doesn't depend on who asked: the prompt addresses "each account you were given", and `scripts/run-fill.ps1` supplies the accounts as `TRACKER_TOKEN_1..N`, so every request is still one person's token against their own rows. Each subagent gets a posting URL and nothing else - no token or id - and the run makes the writes itself. **It records no run.**
- `POST /api/delete-leads` - body `{ "ids": [...], "reason": "..." }` ->
  `{ removed, kept, unmatched, reason }`. Postings the person has decided
  against. Each lead is deleted and its URL written to `screened` with the
  reason given, so tomorrow's run doesn't add it straight back. `reason` is
  required - the screened row is the only lasting record of why the posting
  went. A lead an application points at is kept and named in `kept`, the same
  rule delisting applies. Batched, for clearing many leads at once.

### The three ways a lead can be deleted

| route | auth | scope | applications |
|---|---|---|---|
| `POST /api/delist` (and `delistedOn`) | session | one posting a run reports dead | kept, untouched |
| `POST /api/delete-leads` | session | ids the person names | kept, reported in `kept` |
| `POST /api/purge` | **ADMIN_TOKEN** | every row under one retired track | kept, `leadId` cleared |

Only `purge` takes the admin secret.

- `POST /api/purge` - **`ADMIN_TOKEN` as the Bearer, not a session** - body `{ user, search, dryRun? }` -> `{ purged }`, or `{ dryRun: true, wouldPurge }` - removes every row a retired search left behind: its leads, screened rows, company-rotation rows and run record, in one transaction, with counts per table. `user` is the account name. Refuses a `search` that is still a configured track, so retire the track through `/api/config` first. Application rows survive with `leadId` cleared.

`DELISTED_REASON` ("posting taken down") is the server's marker for a
delisting: `countRunActivity` splits a day's `screened` rows on that exact
string. **Every route that lets a caller supply a reason must reserve it** -
`handleAddScreened` rewrites it to "dead on arrival", `handleDeleteLeads` to
"removed by hand". `deleteLeadAndScreen` can't refuse the string itself,
because `delistLead` passes it, so a new caller-reason path needs its own
guard.

### Documents

Each person's resumes and per-track baseline docs, stored in R2 under their
user id (`src/r2.js`). A path is one known folder and a plain filename -
`docs/tracked_swe_postings.md` - and `src/validate.js`'s `isDocumentPath`
refuses anything else. Bodies are raw bytes rather than JSON; errors are still
JSON. All four routes answer 503 on a deployment with no `DOCS` bucket.

- `GET /api/documents` -> `{ documents: [...] }` - the index: path, kind, content type, size, etag and upload time for each, with no bodies. The nightly runner fetches this first, then each path it needs.
- `GET /api/documents/<path>` -> the object's bytes, with the content type it was stored with and its etag.
- `PUT /api/documents/<path>` - raw body, optional `If-Match` -> `{ path, etag, bytes }`. With `If-Match`, a stale etag is a 412 and nothing is written - send it whenever the write follows an earlier read, so an edit made in between isn't erased. Without it the write is unconditional (the import script and the setup skill). 8 MB maximum; anything larger is a 413.
- `DELETE /api/documents/<path>` -> `{ path, deleted }`, or 404 for a path this person doesn't have.

### Config and prompts

- `GET /api/config` -> `{ tracks: [{key, label, full_description, sort_order, last_run, ...search config}], settings }` - this person's config: the track tabs, labels, display title, priority-location rules and staleness threshold the client renders from, plus the per-track search config and prose settings the prompt is composed from. Each track's `last_run` is its `search_runs` row (`{at, on, status, leads_added, screened_added, delisted, note}`; all-empty means never recorded).
- `POST /api/config` - body `{ tracks?, display_title?, overview_label?, applications_label?, all_leads_label?, stale_run_hours?, priority_locations?, excluded_companies?, geo_scope_line?, scope_clause?, scope_disqualifier?, location_guidance?, footer_note?, pronouns? }`. `tracks`, if present, **replaces this person's whole track list** and keeps `search_runs` 1:1 with it; leads under a removed track keep their `search` value and lose their tab, never deleted. It never touches anyone else's tracks. Each track entry may carry its search config: `role_search_line`, `target_companies` (array, or a string when the list has prose structure), `search_note`, `resume_line`, `fit_clause`, `fit_disqualifier`, `fit_filter_step`, `leads_note`, `doc_file`, `doc_summary`, `doc_update_line`, `intro_note`, `report_line`, `screened_examples`, `schedule_time`, `fed_by`.
- `fed_by` (in the POST above) is how **one search fills more than one tab**. A track with `fed_by` set to a sibling's key has no search of its own: `setup-scheduler.ps1` registers no task for it, `GET /api/prompt` refuses to compose one (409, naming the track to run instead), and the feeding track's prompt turns multi-tab - its dedup covers every tab it fills, it files each finding under one of them (by each tab's `full_description`), and records a run against each. Use it when the split is by *level or kind of role* over an identical search - same companies, same resume, same scope; a different search should be its own track. Refused if `fed_by` names anything but another track in the same posted list.
- `excluded_companies` (in the POST above) is a list of companies this person will not work for at all - plain names, or a catch-all phrase ("any other company X owns or leads"). The composed prompt renders it into a single never-search sentence; add an exclusion here, not in a track's prose.
- `GET /api/dedup/:key` -> `{ leads: [{id, url, status}], screened: [url, ...] }` - what one track's run has already found or ruled out. Runs use this, not `/api/data`, which returns every field of every row and would grow without bound in the run's context. 404s on an unknown key rather than returning empty arrays: a run that believes it has seen nothing re-adds everything.
- `GET /api/coverage/:key` -> `{ companies: [{company, position, last_swept, board, note, known?}], total, batch, cursor }` - **the companies this run should cover**: the next `COVERAGE_BATCH` (24) along the one company list shared by every search on the deployment, starting at this search's cursor and wrapping at the end. `last_swept` and `note` are this search's own record of each company; `board` and `known` are shared. `known` is present only when something is known about the company; its `wall` is present only once recorded on two separate dates and within seven days of the last, so a run meeting an expired wall simply fetches. `?all=1` returns the whole list. 404s on an unknown key, for the same reason as `/api/dedup/:key`.
- `POST /api/coverage` - body `{ "search": "SWE", "on": "YYYY-MM-DD", "swept": [{company, board?, endpoint?, url_shape?, wall?, note?}] }` -> `{ recorded, added, excluded, on, cursor, shared, withheld }` - stamps the companies a run attempted, and `403`s for a demo account. Report every company attempted, including one whose board was blocked; an unstamped company is retried every run and the rest of the list starves. A company not on the list joins it (`added`) in a shuffled position past everything already there. `note` and the date only overwrite when non-empty and stay with this search; `board`, `endpoint`, `url_shape` and `wall` go to the shared list, where a reported `board` or `endpoint` clears a `wall`. A row reporting a `wall` beside a `board` or `endpoint` contradicts itself, so none of its shared fields are written and it is counted in `withheld`; its sweep and `note` are still recorded. `wall` beside `url_shape` is not a contradiction: a posting can load while the listing is walled. `on` is the caller's local date, same as `/api/runs`; an explicit `""` registers companies without sweeping them (seeding) - it stamps no `last_swept` and moves no cursor, but still writes what the row says about the website (`board`, `endpoint`, `url_shape`, `dead_signal`) to the shared list, since `on` governs the sweep record rather than what is known about reaching a company. `wall` is the exception: it is served only after two separate dates, so sending one without `on` is a `400`. Otherwise the cursor moves past the last company reported from the slice this search was served; a company outside that slice is recorded without moving it.
- Every track's composed prompt includes steps 1c (fetch this run's companies and cover exactly those), 9d (record what you covered) and 9e (replace the companies you couldn't read). There is no gate: 9d is the only step that adds a company to the list, so the steps are there even when the shared list is empty, and 1c then returns no companies.
- `GET /api/prompt/:key` -> **`text/plain`** - the daily search prompt for that track, composed from the config above (see `src/prompt.js`). This is what `run-search.ps1` pipes into the CLI, and the fastest way to check what a search will do. 404s on a key this person doesn't have, and 409s on one with `fed_by` set (the error names the track that fills it).
- `OPTIONS *` - CORS preflight for any route above - no auth, returns `204` + `CORS_HEADERS`. Every real response, errors included, carries `CORS_HEADERS` too (`Access-Control-Allow-Origin: *` - the session token, never a cookie, is the access boundary).

### Config fields are prose

Per-track config is stored as the finished prose the prompt uses. Only `key`,
`label`, `sort_order`, `schedule_time`, `target_companies` and `fed_by` are
structured.

## Verifying a change

Before a server deploy, run the cross-user isolation checks against a local
`wrangler dev` (a local database only - it creates users and writes freely):

```bash
cd server
node verify-local.mjs <url> <admin token>
```

Run it whenever `db.js` changes: a missing `AND user_id = ?` breaks no page
and serves someone else's job search.

If you touched `migrations/`, also run these (no dev worker needed; CI runs
`verify-schema-doc.mjs`):

```bash
cd server
node verify-migration.mjs
node verify-schema-doc.mjs
```

The full procedure - choosing a port, starting the dev worker, deploying - is
[`../.claude/skills/verify-and-deploy/SKILL.md`](../.claude/skills/verify-and-deploy/SKILL.md).

## Security notes

- **`/api/login` has no rate limiting.** A guessable password is brute-forcible
  over the internet. PBKDF2 at 100k iterations makes each attempt cost real
  worker CPU - itself a small denial-of-service surface - and the 12-character
  minimum is the rest of the defence.
- **Isolation is app-level, not privacy from the operator.** Whoever holds
  the Cloudflare account can read every user's rows directly in D1. It is not
  a multi-tenant SaaS boundary.
- **Tokens never expire.** Revoke one by deleting its `sessions` row (see
  [Revoking and listing sessions](#revoking-and-listing-sessions)).
- **Every session token reaches every session route.** A scheduled search's
  token, stored in plaintext in `tracker.json`, can rewrite config or delete
  leads just as a browser session can. A separate route list for machine
  credentials is planned, not built.
