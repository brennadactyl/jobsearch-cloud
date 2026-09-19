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
  the caller's session, building the `Db` scoped to that person and the shared
  `CompanyList`, and dispatching to the route table. It knows about no
  individual endpoint.
- `src/routes/index.js` - the route table: which method and path map to which
  handler, in three lists by credential. `PUBLIC_ROUTES` need none,
  `ADMIN_ROUTES` require `ADMIN_TOKEN` and `SESSION_ROUTES` require a session
  token; `src/index.js` tries them in that order. Adding an endpoint is one
  line here plus one exported function in the module beside it.
- `src/routes/*.js` - one module per resource (`leads.js`, `applications.js`,
  `screened.js`, `config.js`, `coverage.js`, `runs.js`, `prompt.js`,
  `data.js`, `documents.js`, `accounts.js`, `admin.js`, `update.js`,
  `delisting.js`, `onboarding.js`). Each holds its endpoints' parsing,
  validation and response shaping, with each endpoint's contract documented on
  its handler. Session routes are handed a `Db` (and `coverage.js` the
  `CompanyList`) and never query D1 themselves.
  The routes that act before there is a session or across accounts -
  `accounts.js` and `onboarding.js` - pass `env.DB` to `src/auth.js` and
  `src/onboarding.js`, and `admin.js` builds its own `Db` for the user it
  names.
- `src/http.js` - every `Response` this worker builds: `json()`, `text()`, the
  two canned refusals, and `CORS_HEADERS` on all of them. Route modules never
  construct a `Response` themselves, or their error replies lose the CORS
  header.
- `src/validate.js` - the checks more than one route makes: `isoDate`, the
  unknown-track refusals, loading a person's exclusion matcher,
  `isDocumentPath`.
- `src/exclude.js` - whether a company is on a person's excluded list, and
  `normalize`, the company-name key the shared company list and the rotation
  join on. No D1, so it can be tested offline.
- `src/url.js` - `canonicalUrl`, which decides when two URLs are the same
  posting.
- `src/auth.js` - passwords (PBKDF2 via Web Crypto), session tokens, and
  looking a bearer token up to a user.
- `src/onboarding.js` - invites, signup and the queue of setups waiting for
  the onboarding run. It takes the D1 binding rather than a `Db`, because an
  invite and a waiting setup belong to no single signed-in person. It also
  mints the `scheduled-search` session a new account's runs use, so it and
  `src/auth.js` are the two files that write sessions.
- `src/db.js` - all D1 access for a person's own data. Every instance is
  bound to one user id at construction, so no query can forget to filter.
- `src/companies.js` - `CompanyList`, the company list every account shares
  (`company_fetch`) and what is known about reaching each company. It belongs
  to no user, so it is kept out of `Db`; session routes receive it as
  `ctx.companyList`. Each search's own record of the list - last swept, notes,
  its cursor - stays on `Db`.
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
- `inspect-backup.mjs` - runs one SELECT against the newest local backup
  (`node server/inspect-backup.mjs "SELECT ..."`, or `--file <backup.sql>`),
  for questions about live data, which is never read from D1 directly. Loads
  the backup into an in-memory SQLite database that refuses writes, and prints
  which backup answered: the data is as of that backup.
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

There are two ways in, and the operator starts both with the `ADMIN_TOKEN`
secret: an invite link, where the person chooses their own name and password
and describes the search they want, or an account created directly.

Anyone signed in changes their own password from the tracker page - see
[Changing your own password](#changing-your-own-password). The admin path is
for new accounts and forgotten passwords.

**Invite someone** - mint an invite and send them the link:

```bash
curl -s -X POST "$TRACKER_URL/api/invites" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"note":"who it is for","days":14}'
```

Returns `{"id", "code", "note", "created_at", "expires_at"}`. The code appears
only in this response; the database keeps its hash. The link is the tracker
page's URL with `?invite=<code>`: it signs the person up and takes them to
first-run setup, and the overnight onboarding run builds their search from what
they send. `GET /api/invites` shows what became of each invite, and
`POST /api/invites/revoke` withdraws one that hasn't been used.

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

**Delete someone** - everything they own, and nothing anyone else's:

```bash
curl -s -X DELETE "$TRACKER_URL/api/users/<their-id>" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Their Name","dryRun":true}'
```

The dry run counts what would go; the same call without `dryRun` does it and
counts what went. The id and the name have to name the same account, so a
mistyped id deletes nobody, and only that one account is ever named.

This is the only way to remove an account. `/api/purge` works a track at a
time, and `POST /api/config` refuses an empty track list, so retiring someone's
last track leaves a placeholder behind rather than an empty account.

Their contribution to the shared company list stays - a company's board and
whether it walls a fetch is every account's, and the rotation would lose it for
everyone. Their own record of which companies they swept goes with them. Their
resume, baseline docs and anything else under their prefix in R2 go too, and
they are gone before the rows are, so a call that dies half way is finished by
making it again.

**A backup is the only way back, and it may not hold their documents.**
`backup-tracker.ps1` fetches each account's documents with that account's own
`tracker.json`, so it can only back up documents for accounts whose folder is on
the machine taking the backup - its log says how many of how many it managed.
Deleting an account whose folder lives on another machine can destroy the only
copy of its resumes. The `dryRun` counts that account's documents; if it is not
zero, take the backup where that account's folder is.

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

Every route not marked **no auth** or **`ADMIN_TOKEN`** needs `Authorization: Bearer
<session token>`, and every one of those is **scoped to whoever that token
belongs to**. There is no user id in any request: another person's lead id,
application id or track key doesn't resolve, and comes back as a 404.

### Auth

- `POST /api/login` - **no auth** - body `{ name, password, label? }` -> `{ token, user: { id, name } }`, or `401` for both a wrong password and an unknown name (keep them indistinguishable, or the reply enumerates accounts). `label` records what the token is for (`"browser"`, `"scheduled-search"`) so it can be revoked by purpose; defaults to `"browser"`. Tokens don't expire.
- `GET /api/invite/:code` - **no auth** -> `{ valid: true, expires_at }` or `{ valid: false, reason: "invalid"|"used"|"expired"|"revoked" }`. An unknown code and a malformed one both read `invalid`.
- `POST /api/signup` - **no auth** - body `{ code, name, password }` -> `201 { token, user: { id, name } }`, a browser session. `410 { error, reason }` for an invite that can't be used; `400 { error, field }` for a name (1-60 characters, trimmed) or a password under 12 characters; `409 { error, field: "name" }` for a name already taken, which leaves the invite open. The invite is checked first, so a caller without a working link learns nothing about which names exist. Claiming the invite and creating the account are one transaction: one link makes one account, and signup never touches an existing one.
- `POST /api/logout` - revokes **only the token that made the request**.
- `POST /api/users` - **`ADMIN_TOKEN` as the Bearer, not a session** - body `{ name, password, demo? }` -> `{ id, name, created, demo }`: creates an account with a fresh GUID (`201`), or sets an existing name's password (`200`), which makes it the password reset too. Minimum 12 characters. `demo: true` marks an account whose data is invented, which `POST /api/coverage` and `POST /api/tokens` then refuse; omitted, a new account is a person and an existing one keeps what it was. See [Accounts](#accounts).
- `DELETE /api/users/<id>` - **`ADMIN_TOKEN` as the Bearer, not a session** - body `{ name, dryRun? }` -> `{ deleted: {<table>: n, documents, invites} }`, or `{ dryRun: true, wouldDelete }`: removes the account and everything it owns - its rows in every table with a `user_id`, its sessions, and its documents in R2. `400` without a name, `404` for an id nobody has, `409` when the name is not that account's. The account is named twice, in the path and the body, so a mistyped id deletes nobody; there is no form of this that names a set of accounts. Documents go before the rows, so a call that fails between the two leaves an account whose documents are gone and is finished by calling again - and deleting an account that is already gone is a `404`, since there is nothing left to delete. What the account contributed to the shared company list stays, because those facts are every account's. An invite that created it keeps its ledger row with `used_by` cleared. See [Accounts](#accounts).
- `POST /api/password` - body `{ currentPassword, newPassword, signOutOthers? }` -> `{ ok, signedOut }`. Changes the caller's own password; needs the current password as well as the session. `403` for a wrong current password, `400` for a new one under 12 characters or identical to the old. Other sessions survive unless `signOutOthers: true`, which revokes only this person's other `browser`-labelled sessions and reports how many in `signedOut`. See [Changing your own password](#changing-your-own-password).
- `GET /api/me` -> `{ id, name }` - who this token belongs to.

### Invites and first-run setup

A person's own setup, with their session:

- `GET /api/intake` -> `{ intake: null }` or `{ intake: { answers, status, status_note, sent_at, updated_at, retries_end_at } }`. `retries_end_at` is the first instant a failed setup is no longer retried overnight, `sent_at` plus three days, as an ISO instant, or `""` without a `sent_at`; it is sent whatever the status.
- `POST /api/intake` - body `{ answers }` -> `{ ok: true, tracks: [key, ...] }`. **Sending the form builds the tracker**: in the same D1 batch as the answers it writes the settings the form owns (`display_title`, `pronouns`, `excluded_companies`, and the location settings from the location answers: `work_scope` to `search_locations`, `location_limits` to `excluded_locations`, `locations_first` to `priority_locations`, `location_note` to `location_note`, each as typed and trimmed at the ends) and one track per role block, keyed by a slug of the role's name and labelled as typed. The account has tabs and a title before the overnight run touches it, and the run then writes the prose through `POST /api/writeup`. Nothing the run owns is written here, and one batch means the page never meets an account whose answers exist but whose tracks don't. **Write-once**: a second send is `409` whatever the status, since there is no re-send - a search changes from the tracker afterwards. The answers are kept whole, as sent. Checked: 1-10 `roles`, each with a `name` and `titles`; a resume, as non-empty `resume_text` or a `resume_files` path under `resumes/` that exists; the location answers as text, each list at most 4,000 characters and the note 1,000 (a `400` names the answer); and `work_scope`, which must name somewhere - otherwise `400 { error, field: "work_scope" }` while the person is still on the form. It isn't checked against the places ranked first: where location answers disagree, the place is included rather than the send refused (`docs/location-settings-plan.md`). `400 { error, field }` for the rest, `403` for a demo account.
- `POST /api/writeup` - body `{ search, ... }` -> `{ written: [field, ...] }`. The overnight run's only way into a track's config. Accepts `role_search_line`, `full_description`, `resume_line`, `search_note`, `fit_clause`, `fit_disqualifier`, `fit_filter_step`, `leads_note`, `doc_file`, `doc_summary`, `doc_update_line`, `intro_note`, `report_line`, `screened_examples`, `schedule_time`, `documents` (a list of document paths, checked like `POST /api/config`'s), and the per-account scope wording `geo_scope_line`, `scope_clause`, `scope_disqualifier`. It also takes `profile_refreshed`, which is not a field: once the runner has accepted a search's rewritten candidate profile it echoes the `profile_stale.since` it read from `GET /api/documents?search=`, and the mark is cleared only if no resume change has landed since - `written` names `profile_refreshed` only when it was. Any other key is `400 { error, field }` naming it, rather than being dropped: a run that tries to rename a tab should hear that it can't. The UPDATE is built from that fixed list, so a field the setup form owns - `label`, `sort_order`, the title, the location rules - cannot be written through this route whatever the body says. Writing a track that is already written up is ordinary, since a retry night works on one that exists. `404` for an unknown track.

The operator's scripts and the onboarding run, each with **`ADMIN_TOKEN` as the Bearer**. The router checks it once for the whole list, so a session token is refused whoever holds it:

- `POST /api/invites` - body `{ note?, days? }` -> `201 { id, code, note, created_at, expires_at }`. `note` is at most 200 characters; `days` is 1-30, default 14. The code appears only here.
- `GET /api/invites` -> `{ invites: [{ id, note, created_at, expires_at, used_at, revoked_at, user, state }] }`, newest first. `user` is the account an invite created, or `null`; `state` is `open`, `used`, `expired` or `revoked`. No code is ever returned.
- `POST /api/invites/revoke` - body `{ id }` -> `{ id, state: "revoked" }`, and repeating it is harmless. `404` for no such invite, `409` for one already used.
- `GET /api/intake/pending` -> `{ intakes: [{ user: { id, name }, status, status_note, sent_at, updated_at, answers }] }`: every `pending` or `failed` setup, oldest attempt first.
- `POST /api/intake/complete` - body `{ user, status: "done"|"failed", note? }`, where `user` is the account id rather than its name, -> `{ user, status, status_note, updated_at }`. `note`, at most 500 characters, is shown to the person as written. `done` is final, so a later call is `409`; `404` for an account that never sent a setup.
- `POST /api/tokens` - body `{ user }` -> `201 { token, user, label: "scheduled-search", replaced }`: a long-lived search token for that account. It replaces the account's previous search token in the same transaction, so an account has exactly one; browser sessions are untouched. `404` for no such account, `403` for a demo account. **This token reaches everything the account owns** - see [Security notes](#security-notes).

### Data

- `GET /api/data` -> `{ user, updated, leads[], applications[], screened[], tracks[], settings }` - everything the page renders, for this person only. `user` is `{id, name}`.
- `POST /api/leads` - body `{ "on": "YYYY-MM-DD", "leads": [ {search, company, title, location, url, fit, team, setup, comp} ] }` -> `{ added, duplicates, excluded }`. Appends only postings this person doesn't already have under that search. Dedup matches the canonical URL (`src/url.js`) as well as `UNIQUE(user_id, search, url)`, so a `?gh_jid=` suffix, a slug or a tracking param is still a duplicate. Dedup is per search, not per tab: a branched run can't file one posting into two of its tabs, while two independent tracks each keep their own row. Companies on `excluded_companies` are dropped. `on` is the caller's local date and stamps `found`/`verified`. Never touches an existing row's status or notes. `team`/`setup`/`comp` are optional - omit them unless the posting states them. Other Details fields (referral, resume, lastContact, nextAction*, link) are accepted but are for the person to enter; search scripts don't send them. Every distinct `search` must be one of this person's configured tracks (a fed tab counts); an unknown key is a 404 naming it, and nothing in the payload is inserted.
- `POST /api/screened` - body `{ "search": "SWE", "on": "YYYY-MM-DD", "screened": [ {search, url, company, title, location, reason} ] }` -> `{ added, duplicates, excluded }`. Records postings a search looked at and rejected (dead on arrival, out of scope, wrong level, duplicate), so the next run's dedup skips them. Same canonical dedup, exclusion handling and configured-track check as `/api/leads` (unknown key: 404, nothing inserted); the check applies to the `search` sent, and rows for a fed tab are then filed under the track that feeds it. **Send `on`**: `/api/runs` counts a day's screened rows by it, and without it an evening run's rows take the worker's UTC date and the run records screening nothing. `reason` is free text except `"posting taken down"`, which is reserved for delistings and rewritten if a caller sends it.
- `POST /api/runs` - body `{ "search": "SWE", "status": "ok"|"error", "on": "YYYY-MM-DD", "note": "..." }` -> `{ ok, run, also }`. **Call it at the end of every run, including runs that found nothing** - without it a search that stopped firing looks like a quiet day. `leadsAdded`, `screenedAdded`, `delisted` and `swept` - the companies this search stamped with that date through `/api/coverage` - are counted server-side from that track's rows dated `on`; values sent for them are ignored. A tab another search fills stamps no companies of its own, so its record reads `swept: 0`. It also records a run for every tab this search feeds (`fed_by`), returned in `also`. `on` is the caller's local date. `status: "error"` marks a run that couldn't do its job, which the page shows as a warning. 404 on a `search` that isn't one of this person's tracks.
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
- `POST /api/companies/cleanup` - **`ADMIN_TOKEN` as the Bearer, not a session** - body `{ merges?: [{ keep, absorb: [name, ...], rename? }], renames?: [{ from, to, clear_facts? }], dryRun? }` -> `{ dryRun, changes: [{ company, position, from: [{ company, position }], facts, sweeps }] }` - tidies the shared company list (`src/company-cleanup.js`). A **merge** folds each absorbed company into the kept one and deletes it: the kept company's `board`, `endpoint`, `url_shape`, `dead_signal` and `note` win, and an absorbed one only fills a field left empty; `verified_on` is the latest; a board or endpoint on the result clears any wall. Each search's record of the company becomes one, the most recently swept (the kept company's on a tie), keeping a note if either had one. `rename` gives the kept company a new name. A **rename** re-keys a company, with every search's record, under its new name; `clear_facts` drops what was known about the old careers site, for an acquired company whose site moved. Names are matched through `normalize()`. Positions don't move: a kept or renamed company keeps its place and an absorbed one leaves a gap, which no cursor steps wrongly over. Everything is checked before anything is written, and the writes are one transaction: `400` for a malformed request or a company named twice, `404` for a name not on the list, `409` for a retracted company or a new name already on the list. `dryRun` reports the same changes and writes nothing. **Every name a merge absorbs or a rename replaces becomes an alias** of the company it became (`company_fetch.aliases`), carried with that company through later merges and renames, so a run that reports the old name in any spelling is recorded against the right company instead of adding it back. `aliases: [{ name, company }]` adds one without a merge: the caller names the alias and the company, and the server adds it to that company's list, once per name however spelled. An alias is refused (`409`) if it is a company on the list - merge it instead - or already means another company. The reply's `changes[].aliases` and top-level `aliases` show each affected company's whole list.

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

- `GET /api/documents` -> `{ documents: [...] }` - the index: path, kind, content type, size, etag, upload time and `words` (the word count stored at upload for a `.txt`, `.md` or Word resume, otherwise `null`) for each, with no bodies. Everything this person has, which is what the backup, the import script and the page's resume section want. Each file under `resumes/` also carries `readable` (whether a search can be pointed at it: a `.txt`, `.md` or `.pdf`, or a Word file whose text is stored - that text itself is `false`, as it is offered as the Word file), `text_path` on a Word file (`null` when no text is stored beside it, and such a file is not `readable`) and `paired_with` on its text, and `used_by: [{ search, tabs, state }]` - each search that reads it, the tabs that search fills (itself first), and `state`: `reads`, `from_next_run` (listed, and its profile is waiting to be rewritten from it) or `until_next_run` (the file the search was switched away from, which its profile still reflects). A Word file reports what its text is used by.
- `GET /api/documents?search=<key>` -> `{ search, documents: [...], missing: [path, ...], profile_stale }` - only what one search reads: its `doc_file` and the paths in its `documents` list. The nightly runner asks this way, so a person with two searches doesn't hand each one the other's tracking doc and resumes. A tab another search fills (`fed_by`) is served that search's list. A listed path with no document behind it is named in `missing` rather than dropped, and the runner refuses to search while anything is missing. `404` for a track this person doesn't have; `409 { error, field: "documents" }` for a track whose list is empty, since a search with no resume runs anyway and searches for nothing in particular. `profile_stale` is `{ since, was }` while the search's resume has changed since its candidate profile was written (`migrations/0018_profile_stale.sql`), otherwise `null`: the runner rewrites the profile first, then clears the mark through `POST /api/writeup`.
- `GET /api/documents/<path>` -> the object's bytes, with the content type it was stored with and its etag.
- `PUT /api/documents/<path>` - raw body, optional `If-Match` -> `{ path, etag, bytes }`. With `If-Match`, a stale etag is a 412 and nothing is written - send it whenever the write follows an earlier read, so an edit made in between isn't erased. Without it the write is unconditional (the import script and the setup skill). 8 MB maximum; anything larger is a 413. A `.txt` or `.md` under `resumes/` is stored with its word count. New contents under the name of a resume a search reads mark that search's profile stale, if it has been written up; the same bytes sent again don't.
- `DELETE /api/documents/<path>` -> `{ path, deleted }`, or 404 for a path this person doesn't have. A file a search reads - named in its `documents` list (for a Word file, its text) or its `doc_file` - is a `409 { error, searches: [key, ...] }`, with `field: "resume"` under `resumes/`, and the page's sentence in `error`: "Eng - Gaming and Eng - AI read this resume, so it can't be removed. Choose another resume for them below first." Point the search elsewhere first. A file a search was only switched away from (`until_next_run`) can be removed.
- `POST /api/settings` - body `{ resumes?: { <search>: <path> }, search_locations?, excluded_locations?, priority_locations?, location_note? }` -> `{ resumes: { <search>: { documents, profile_pending } }, locations: { <key>: <stored value> } }`. The account panel's write, and the mirror of `POST /api/writeup`: any other key is `400 { error, field }` naming it. **Where the search looks**: each location list and the note is stored as typed, trimmed at the ends, and nothing splits or checks the places in it - the prompt reads each list as written (`docs/location-settings-plan.md`). A list over 4,000 characters, a note over 1,000, or a value that isn't text is `400` naming the key, and nothing in the request is written. A key left out keeps its value; `""` clears it. A `priority_locations` different from the stored one also drops the account's stand-in `priority_rules`, so the page ranks by the list the person typed; the same list sent again keeps them. Points each named search at a stored resume under `resumes/`; a Word file (or its text's path) is stored as its text, which is what a run reads. The resume replaces every `resumes/` entry in that search's `documents` list, keeping anything else - a reference file - in place. A change marks the search's profile stale (`profile_stale_since`, `resume_was` in `docs/schema.md`) once the search has been written up - before that it has no profile, and its write-up reads whichever resume is current, so `profile_pending` is false; naming the resume it already reads changes nothing. Every search is checked before any is written, and the writes are one transaction. Refusals are `{ error, search, field: "resume" }`: `404` for a search this person doesn't have or a file that isn't stored, `400` for a tab another search fills (the error names that search) or a path outside `resumes/`, `422` for a file a search can't read.

**Word resumes.** A `.docx` put under `resumes/` is read on upload (`src/docx.js`, `docs/word-resumes-plan.md`): its text is written beside it as `resumes/<name>.txt`, which is what a search reads, and the PUT reply adds `text_path` and `words` - `{ path, etag, bytes, text_path, words }`. The reading is a fixed procedure with no dependency: the zip's central directory, the Worker's own `DecompressionStream` for the deflated `word/document.xml`, then the text runs in order, a line per paragraph, and a table's cells joined by tabs with a line per row. Only the main document is read, not headers or footers; a paragraph's tab stops are layout, and a text box Word writes twice is read once.

- A `.docx` that can't be read (not really a zip, password-protected, damaged) or that yields fewer than 50 words (a scanned image, a template) is a `422 { error, words?, field: "resume" }` naming why, and nothing is stored - neither file. Every refusal of a file under `resumes/` carries `field: "resume"`, including a `413`, so a form can show it beside the file.
- An older Word file, `resumes/<name>.doc`, is a `415` asking for `.docx` or PDF.
- **The text belongs to the Word file.** A PUT or DELETE of a resume `.txt` whose `.docx` is stored is a `409 { error, paired_with }`: "This text is read from Resume.docx - replace that file instead." Replacing the `.docx` rewrites its text; deleting it deletes its text too, listed in the reply's `removed`.
- The pair is matched on the name **ignoring case**, because a run downloads documents onto a Windows disk where `resume.txt` and `Resume.txt` are one file. Uploading `Resume.docx` when `resume.txt` is stored replaces that file with `Resume.txt`.
- With `If-Match`, the `.docx` is the conditional write and goes first, so a stale etag writes neither file. The text follows unconditionally; if that second write is lost, sending the same file again rewrites both.

### Run logs

What each nightly search did, kept with the tracker rather than only on the
machine that ran it. `scripts/run-search.ps1` uploads the part of its log that
one run wrote, as its last act, whether the run succeeded or failed; a failed
upload is a warning in the local log and never changes the run's result.

Stored in the same R2 bucket as documents but outside their prefix, at
`logs/<user-id>/<track>/<started>.log` (`src/r2.js`, `RunLogs`). Everything under
a person's own prefix is a document - listed, backed up and editable through the
document routes - and a log is none of those. And a bucket lifecycle
rule matches a key from its start, so one rule on `logs/` expires them for every
account - see "Keeping 30 days of run logs" below. Deleting an account deletes
its logs too.

`<started>` is when the run began, in UTC: `2026-09-16T08-00-01Z`. All three
routes answer 404 for a track this person doesn't have and 503 on a deployment
with no `DOCS` bucket.

- `PUT /api/logs/<track>/<started>` - the log as the raw body -> `{ track, started, bytes }`. Uploading the same run again replaces its log, so a retried upload leaves one. 2 MB maximum (413); a start time in any other shape is a 400.
- `GET /api/logs/<track>` -> `{ track, logs: [{started, bytes, uploaded}] }`, newest first.
- `GET /api/logs/<track>/<started>` -> the log, as `text/plain`, or 404 for a run with no log.

**Keeping 30 days of run logs.** Nothing in the Worker deletes old logs; a
lifecycle rule on the bucket does, once, for every account:

```bash
npx wrangler r2 bucket lifecycle add job-search-tracker-docs run-logs-30-days logs/ --expire-days 30
```

It matches only keys starting `logs/`, so documents - which start with a user
id - are never touched by it. `npx wrangler r2 bucket lifecycle list
job-search-tracker-docs` shows what is set.

### Config and prompts

- `GET /api/config` -> `{ tracks: [{key, label, full_description, sort_order, last_run, ...search config}], settings }` - this person's config: the track tabs, labels, display title, priority-location rules and staleness threshold the client renders from, plus the per-track search config and prose settings the prompt is composed from. Each track's `last_run` is its `search_runs` row (`{at, on, status, leads_added, screened_added, delisted, swept, note}`; all-empty means never recorded).
- `POST /api/config` - body `{ tracks?, display_title?, overview_label?, applications_label?, all_leads_label?, stale_run_hours?, search_locations?, excluded_locations?, priority_locations?, location_note?, priority_rules?, excluded_companies?, geo_scope_line?, scope_clause?, scope_disqualifier?, location_guidance?, footer_note?, pronouns? }`. `tracks`, if present, **replaces this person's whole track list** and keeps `search_runs` 1:1 with it; leads under a removed track keep their `search` value and lose their tab, never deleted. It never touches anyone else's tracks. Each track entry may carry its search config: `role_search_line`, `target_companies` (array, or a string when the list has prose structure), `search_note`, `resume_line`, `fit_clause`, `fit_disqualifier`, `fit_filter_step`, `leads_note`, `doc_file`, `doc_summary`, `doc_update_line`, `intro_note`, `report_line`, `screened_examples`, `schedule_time`, `fed_by`, and `documents` - a list of the document paths the search reads besides its `doc_file` (at most 20, each a valid document path, or a `400`). A list that changes must leave the search something to read - at least one `.txt`, `.md` or `.pdf`, and no Word file, which a run reads through its extracted `.txt` - or it is a `400 { error, field: "documents" }`; `POST /api/writeup` applies the same rule. A list identical to the stored one, and a tab another search fills, are exempt, so `GET /api/config` read and posted back is always accepted. `priority_rules` is the operator's way to keep a migrated account's ranking (`docs/location-settings-plan.md`, "The stand-in rules"): an array of `{label, allOf?, anyOf?}`, at most 20, or a `400`; a different `priority_locations` in the same post without it drops the stored rules.
- `fed_by` (in the POST above) is how **one search fills more than one tab**. A track with `fed_by` set to a sibling's key has no search of its own: `setup-scheduler.ps1` registers no task for it, `GET /api/prompt` refuses to compose one (409, naming the track to run instead), and the feeding track's prompt turns multi-tab - its dedup covers every tab it fills, it files each finding under one of them (by each tab's `full_description`), and records a run against each. Use it when the split is by *level or kind of role* over an identical search - same companies, same resume, same scope; a different search should be its own track. Refused if `fed_by` names anything but another track in the same posted list.
- `excluded_companies` (in the POST above) is a list of companies this person will not work for at all - plain names, or a catch-all phrase ("any other company X owns or leads"). The composed prompt renders it into a single never-search sentence; add an exclusion here, not in a track's prose.
- `GET /api/dedup/:key[?scope=batch]` -> `{ leads: [{id, url, status}], screened: [url, ...] }` - what one track's run has already found or ruled out. Runs use this, not `/api/data`, which returns every field of every row and would grow without bound in the run's context. 404s on an unknown key rather than returning empty arrays: a run that believes it has seen nothing re-adds everything. `?scope=batch` trims `screened` to what a run can meet tonight - URLs at a company in the next two batches along the rotation (the filling track's rotation, for a fed tab), plus any screened in the last `DEDUP_RECENT_DAYS` (3) - and adds `scope: {cursor, companies, since, kept, of}`. A URL the trim drops is at worst verified again, since `POST /api/screened` and `/api/leads` refuse duplicates. `leads` is never trimmed, and without the parameter the response is unchanged. A scoped read also marks tonight's re-checks: each lead due one carries `recheck: true`, and `scope.recheck` is `{eligible, budget, flagged, after_days}`. The choice is made for the whole feed group (a track and the tabs it fills): open leads - New or Reviewing - not confirmed live within `RECHECK_AFTER_DAYS` (7), longest-unconfirmed first, at most `min(RECHECK_MAX_PER_RUN (20), ceil(open / RECHECK_CYCLE_NIGHTS (14)))`, so every open lead comes round in about two weeks. Applied and Not a fit leads are never flagged.
- `GET /api/coverage/:key` -> `{ companies: [{company, position, last_swept, board, note, known?, aliases?}], total, batch, cursor }` - **the companies this run should cover**: the next `COVERAGE_BATCH` (24) along the one company list shared by every search on the deployment, starting at this search's cursor and wrapping at the end. `last_swept` and `note` are this search's own record of each company; `board` and `known` are shared. `known` is present only when something is known about the company; its `wall` is present only once recorded on two separate dates and within seven days of the last, so a run meeting an expired wall simply fetches. `?all=1` returns the whole list, with each company's `aliases` - the other names it goes by - so a run that checks a name against the list (`tracker known`) can match them as the server does. 404s on an unknown key, for the same reason as `/api/dedup/:key`.
- `POST /api/coverage` - body `{ "search": "SWE", "on": "YYYY-MM-DD", "start_here": false, "swept": [{company, board?, endpoint?, url_shape?, wall?, note?}] }` -> `{ recorded, added, excluded, aliased, on, cursor, shared, withheld }` - a reported name that is another company's alias is recorded as that company, and counted in `aliased`, so a name merged away can't join the list again - stamps the companies a run attempted, and `403`s for a demo account. Report every company attempted, including one whose board was blocked; an unstamped company is retried every run and the rest of the list starves. A company not on the list joins it (`added`) in a shuffled position past everything already there. `note` and the date only overwrite when non-empty and stay with this search; `board`, `endpoint`, `url_shape` and `wall` go to the shared list, where a reported `board` or `endpoint` clears a `wall`. A row reporting a `wall` beside a `board` or `endpoint` contradicts itself, so none of its shared fields are written and it is counted in `withheld`; its sweep and `note` are still recorded. `wall` beside `url_shape` is not a contradiction: a posting can load while the listing is walled. `on` is the caller's local date, same as `/api/runs`; an explicit `""` registers companies without sweeping them (seeding) - it stamps no `last_swept` and moves no cursor, but still writes what the row says about the website (`board`, `endpoint`, `url_shape`, `dead_signal`) to the shared list, since `on` governs the sweep record rather than what is known about reaching a company. `wall` is the exception: it is served only after two separate dates, so sending one without `on` is a `400`. Otherwise the cursor moves past the last company reported from the slice this search was served; a company outside that slice is recorded without moving it. `start_here: true` on a seeding call - only a seeding call, since sending it with a date is a `400` - sets this search's cursor to the first company that call added, so a brand new search covers the companies its person named on its first night instead of reaching them a cycle later. It is the one thing that moves the cursor backwards. If every company named was already on the list there is nothing to start at, and the cursor is left alone; `added: 0` is how the caller tells.
- Every track's composed prompt includes steps 1c (fetch this run's companies and cover exactly those), 9d (record what you covered) and 9e (replace the companies you couldn't read). There is no gate: 9d is the only step that adds a company to the list, so the steps are there even when the shared list is empty, and 1c then returns no companies.
- `GET /api/prompt/:key` -> **`text/plain`** - the daily search prompt for that track, composed from the config above (see `src/prompt.js`). This is what `run-search.ps1` pipes into the CLI, and the fastest way to check what a search will do. `?doc_budget=<bytes>` sets how much step 8b says a run may add to its doc: `run-search.ps1` passes the budget it enforces, and a value that isn't a whole number from 100 to 20000 falls back to the default (1000) rather than failing. 404s on a key this person doesn't have, and 409s on one with `fed_by` set (the error names the track that fills it).
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
- **The invite routes are public and unthrottled**, like `/api/login`. The code
  is what keeps them safe: 32 random bytes, of which only the SHA-256 is stored,
  so guessing one is not a practical attack and a leaked backup holds no usable
  invite. Signup changes nothing without an open code.
- **`ADMIN_TOKEN` reaches every account's data.** It creates accounts and resets
  passwords, `POST /api/tokens` mints a session that reads and writes everything
  an account owns, and `DELETE /api/users/<id>` removes an account and its data
  outright - the one action here that a backup is the only way back from. Treat
  it, and the `deployment.json` that holds it, as the keys to every account on
  the deployment.
