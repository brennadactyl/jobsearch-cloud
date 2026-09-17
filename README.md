# Job Search Tracker

Tooling for running a daily, verified job search entirely headless: any
number of tracked searches you define (e.g. software engineering, product
management, data science - whatever roles you're after), each updating a
durable baseline doc and syncing new postings to a live tracker webpage.

**Set up your own copy with an AI's help, not by hand-authoring config
files.** See [Setup](#setup-on-any-machine) below - the
[job-search-setup](.claude/skills/job-search-setup/) Claude Code skill reads
your resume(s), asks what roles/companies/locations you're after, and
generates everything else.

**This repo is public and contains no personal data.** Search config and
results live in D1 and documents in R2, reached with a per-person token. The
machine that runs the searches keeps only that token and its logs, in a
gitignored `private/` folder; see
[private.example/README.md](private.example/README.md).

**The tracker is a static client and an API, deployed independently** - a
Cloudflare Worker serving the page ([client/README.md](client/README.md)) and
a Cloudflare Worker + D1 API ([server/README.md](server/README.md), which
covers how the two fit together). Searches run through the standalone
`claude` CLI and reach the tracker through `scripts/tracker.ps1`. Tabs, labels,
the page title and priority locations are per-account config the API stores
(`/api/config`), so one deployed pair serves anyone's tracks.

## Architecture

![Architecture diagram: Windows Task Scheduler runs one headless Claude run per track, plus a nightly application fill. Each run fetches its prompt and documents from server/'s API Worker into a throwaway folder, searches and verifies career sites, reports through ./tracker, and writes back the doc it edited. The API keeps rows in D1 and documents in R2 and answers the browser's cross-origin calls; client/, a separate static-assets Worker, serves the tracker page.](docs/architecture.svg)

Full write-up, with the scheduled tasks and where the API routes are defined:
[docs/architecture.html](docs/architecture.html) (open it locally in a browser;
GitHub shows `.html` files as source).

## Contents

```
CLAUDE.md                     the rules every Claude session here follows, and who owns what
.claude/skills/
  team-setup/                 starts one Claude session per role - "set up the team"
  role-*/                     one skill per teammate role, loaded by "you are <role name>"
  job-search-setup/           AI-assisted onboarding - see Setup below
  add-target-company/         puts an employer on the shared company list
  change-search-prompt/       changes what a nightly search does, everywhere it is written
  edit-tracker-page/          changes the tracker page in client/
  add-api-route/              adds or changes an API endpoint
  add-d1-migration/           changes the D1 schema
  verify-and-deploy/          verifies a change locally and ships it
.claude/hooks/
  block-remote-d1-writes.mjs  refuses an agent's command that writes to or deletes the live D1
  block-remote-d1-writes.test.mjs   its test - see below
docs/
  README.md                   which docs describe the system today and which are plans
  glossary.md                 what the codebase's own words mean
  onboarding.md               from an invite link to a working nightly search
  schema.md                   every D1 table as the migrations leave it
  architecture.svg           the diagram above
  architecture.html           full architecture write-up (open in a browser)
  *-plan.md                   plans - changes intended or made, not a description of today
scripts/
  run-search.ps1              runs one track for one person (fetches its prompt AND documents from the API)
  tracker.ps1                  every API call a run makes, as a command - copied into the run directory
  run-fill.ps1                 reads the postings behind URL-only applications - every account, one run
  run-onboarding.ps1           writes up the searches of everyone who sent the setup form - every account, one run
  run-lock.ps1                 one search or fill at a time on this machine - dot-sourced, not run on its own
  claude-cli.ps1               finds the claude CLI and classifies its failures - dot-sourced by the runners
  verify-claude-cli.ps1        checks claude-cli.ps1's failure classification
  import-documents.ps1         uploads a folder's resumes and baseline docs into the tracker
  setup-scheduler.ps1          registers every person's tracks as daily Windows Scheduled Tasks
  new-invite.ps1               makes an invite link to add a person, lists what became of each, or revokes one
  set-password.ps1             resets an account's password with the ADMIN_TOKEN, typed at a prompt
  seed-demo-user.ps1           creates the demo account and fills it with invented postings
  demo-user.json               that invented data - the only fabricated content in this repo
  backup-tracker.ps1           exports the whole database to a dated .sql file + an off-machine mirror
  archive-backups.ps1          copies those exports into an archive this account can't modify (runs as SYSTEM)
  protect-backups.ps1          one-time elevated setup that creates that archive and its task
  verify-backups.ps1           proves the archive really refuses writes, from an unelevated shell
server/                        API only - Cloudflare Worker + D1, no HTML served
  src/index.js                  entry point: session resolution, CORS preflight, dispatch
  src/routes/                   one module per resource; index.js is the route table
  src/http.js                   every response the worker builds + CORS headers
  src/validate.js               the checks more than one route makes
  src/auth.js                   passwords, session tokens, who a token belongs to
  src/db.js                     all D1 access for a person's own data
  src/companies.js              the company list every account shares - not scoped to a user
  src/r2.js                     all R2 access for their documents - resumes, baseline docs
  src/prompt.js                 composes each track's daily search prompt from its config
  migrations/                   the D1 schema, applied via `wrangler d1 migrations apply`
  wrangler.toml                  deploy config
  package.json                   lets the Deploy to Cloudflare button chain migrations + deploy
  README.md                      one-time deploy instructions + API reference
client/                        the tracker webpage - React + TypeScript, built with Vite
  src/                          components, domain rules, the API layer, tests
  wrangler.toml                  deploy config (Worker serving the built dist/ as static assets)
  package.json                   build, test and deploy scripts
  README.md                      one-time deploy instructions
private.example/
  README.md                    expected layout for your own private data folder
```

Deploy `server/` and `client/` separately. A change to one needs the other
redeployed only when it depends on something new - `server/README.md`'s API
section says what the server supports.

The hook in `.claude/hooks/` is registered in `.claude/settings.json` and runs
before every shell command an agent issues in this repo. CI doesn't run its
test, so run it after changing the hook or its cases
(`block-remote-d1-writes.cases.json`):

```bash
node .claude/hooks/block-remote-d1-writes.test.mjs
```

It exits 1 if any case is allowed or refused wrongly.

## Setup on any machine

No Node.js or `wrangler` CLI is required for any of this;
[server/README.md](server/README.md) and [client/README.md](client/README.md)
cover the CLI path.

> PowerShell says "running scripts is disabled"? Use `npm.cmd`/`npx.cmd`, or
> run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once - see
> [server/README.md](server/README.md#one-time-setup).

1. **Install Claude Code**:
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```
   Then authenticate for headless use: `claude setup-token`, then
   `setx CLAUDE_CODE_OAUTH_TOKEN "<token it gives you>"` (open a new
   terminal afterward so the variable takes effect).
2. **Get this tooling onto your machine** - clone it:
   ```bash
   git clone https://github.com/brennadactyl/jobsearch-cloud.git
   ```
   Open the clone in Claude Code and the skills under `.claude/skills/` load
   as project skills. There is no plugin to install; a clone is the way in.
3. **Turn on R2** once per Cloudflare account, before the deploys below:
   **[dash.cloudflare.com](https://dash.cloudflare.com/) → R2 Object Storage →
   Overview** (free tier; it asks for billing details). Without it the server
   deploy fails with `[code: 10042]`. See
   [server/README.md](server/README.md#first-turn-on-r2).

4. **Deploy the tracker** (once - not per machine). Two separate one-click
   deploys, server first:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/server)

   Click it, sign in to Cloudflare (creates a free account if you don't have
   one), and accept the defaults - it forks the API code into your own
   GitHub, provisions the D1 database, and deploys. You'll land on your new
   Worker's dashboard; from **Settings → Variables and Secrets**, add a secret
   named `ADMIN_TOKEN` with any long random value you pick. It is the operator
   credential that creates accounts, not a login. Then create your own account
   with it - see [server/README.md](server/README.md#accounts). Keep the `id`
   it returns; step 5 puts your search data under it.

   Then the client:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/client)

   Same flow - it forks the client into your own GitHub, builds it and deploys
   it as a Worker serving a static page.

   **Required before it will build:** on the setup page, set the deploy command
   to `npm run deploy` and add a build variable `VITE_API_BASE` with your API
   Worker's URL. Without it the build refuses with "VITE_API_BASE is not set".
   See [client/README.md](client/README.md#quick-deploy).

   Now open the client's URL and sign in with the name and password of the
   account you created. It remembers you in that browser until you log out.

   **The page is empty at this point, and that's correct** - no track tabs,
   just Overview and Applications. A fresh database has no tracks, title or
   location rules; step 5 fills them in.
5. **Set up your private data folder** - either:
   - **With Claude's help (recommended):** put your resume(s) somewhere
     Claude can read them, then ask it to run the
     [job-search-setup](.claude/skills/job-search-setup/) skill. It asks what
     tracks/companies/locations you want, sets them up, and does step 6 for
     you.
   - **By hand:** create `private\<user-id>\tracker.json` with your API URL
     and a session token (see [server/README.md](server/README.md#accounts)).
     Resumes and baseline docs go into the tracker, not that folder;
     `scripts\import-documents.ps1` uploads a folder you already have. See
     [private.example/README.md](private.example/README.md).

   Either way, point at the resulting folder with
   `setx JOB_SEARCH_DATA_DIR "C:\path\to\private"`, or use the default,
   `private\` at the repo root (already gitignored). Keep the path short: a
   run writes files about 100 characters deeper than it, and Windows' 260-character
   limit fails as "Could not find a part of the path".
6. **Register the scheduled tasks** (the setup skill does this for you; run
   it yourself if you set up by hand or are adding a track):
   ```powershell
   .\scripts\setup-scheduler.ps1
   ```
   It discovers each person by their `private\<user-id>\tracker.json` and
   asks their account what tracks it has.
7. **Test one run before trusting the schedule** - the previous step prints
   the exact command for whichever tracks it just registered, e.g.:
   ```bat
   schtasks /Run /TN JobSearch-ab266b6c-Engineering
   ```
   Check `private\<user-id>\logs\<track>.log` for what happened, then reload the
   tracker page: that track's tab should now show when it last ran and what
   it found. Until a track's first run reports in it reads "No run recorded
   yet".

8. **Set up backups** - see [Backups](#backups) below. Nothing above leaves a
   copy of your data anywhere but Cloudflare.

### The nightly schedule

One machine runs everyone's tasks, in this order (local time):

| Time | Task | Script | Registered by |
|---|---|---|---|
| 00:00 | `JobSearch-Onboarding` | `run-onboarding.ps1` - writes up new signups' searches | `setup-scheduler.ps1`, only while `deployment.json` holds an `admin_token` |
| each track's `schedule_time` | `JobSearch-<id8>-<track>` | `run-search.ps1` - one track's search | `setup-scheduler.ps1` |
| 03:15 | `JobSearchTracker-Backup` | `backup-tracker.ps1` | `protect-backups.ps1` |
| 03:45 | `JobSearchTracker-ArchiveBackups` | `archive-backups.ps1`, as SYSTEM | `protect-backups.ps1` |
| 06:30 | `JobSearch-Applications` | `run-fill.ps1` - the application fill, every account | `setup-scheduler.ps1` |

The onboarding run picks a new search's `schedule_time` inside 01:00-05:45, 45
minutes clear of every other search and of the backup (see
[docs/onboarding.md](docs/onboarding.md#slots)). A track with no
`schedule_time` is given one from 08:00, 30 minutes apart, shared across every
account on the machine. Searches and the fill also take `run-lock.ps1`, so one
that starts while another is still going waits for it instead of running on
top of it.

**A task runs the scripts in the checkout that registered it.**
`setup-scheduler.ps1` registers each task with its own folder's path, and
`run-search.ps1` copies `tracker.ps1` into the run directory fresh every run.
So an edit to `scripts\` reaches the nightly runs once it is in that checkout -
and a worktree that re-registers the tasks points them at the worktree.

Tasks run daily while you're logged in, with no stored Windows password. They
wake a sleeping machine and catch up a missed slot once it's available, but
nothing wakes a machine that is shut down or hibernated - the run waits until
you next boot. For overnight searches, leave the machine asleep, not off.

The webpage is hosted on Cloudflare and stays up whether or not any machine is
on.

## Running a search manually

```powershell
.\scripts\run-search.ps1 -Task <track key> -User <user id>
```

`<track key>` is whatever you named a track when setting it up - e.g.
`engineering`. `<user id>` is the GUID whose folder under `private\` holds
that person's `tracker.json`; omit it only on a single-user machine with no
per-user folders, whose credentials are in `TRACKER_URL`/`TRACKER_API_TOKEN`.

To see exactly what that run will do, without running it:

```bash
curl -s "$TRACKER_URL/api/prompt/<track key>" -H "Authorization: Bearer <their token>"
```

## Adding another person

One deployment holds any number of job searches, each with its own tracks,
leads, page title and location rules, and its own sign-in. Adding someone is
sending them an invite link.

**Once, on the machine that runs the searches:** put `deployment.json` in the
data folder with the API URL, the tracker page's URL and the `ADMIN_TOKEN` (see
[private.example/README.md](private.example/README.md#deploymentjson)), then
run `scripts\setup-scheduler.ps1`. That registers `JobSearch-Onboarding`, which
runs at midnight and sets up anyone who has signed up since.

**For each person:**

```powershell
.\scripts\new-invite.ps1 -Note "Sam, from the climbing gym"
```

It prints a link that works once, for 14 days. Send it to them. They:

1. open it and choose their own name and password;
2. fill in the setup form on the tracker page: the roles they want, where they
   can work, and their resume.

Sending the form creates their tracker at once, with a tab per role. That
night the onboarding run creates their folder under `private\<their id>\`,
writes up each search and its track doc, and schedules their searches in a
free slot later the same night. In the morning their tracker has leads. When
the machine has no free overnight slot left, their setup is marked failed and
the page tells them why, rather than stacking a search on top of another.

`.\scripts\new-invite.ps1 -List` shows each invite's id and state (open, used,
expired or revoked) and, once used, the account's name and user id, which names
their folder. A lost link can't be shown again: stop it with
`.\scripts\new-invite.ps1 -Revoke <id>` and mint another.

Everyone's searches run on this machine, under its Claude account, one after
another in their own slots.

**Setting someone up by hand** - in person, or on a machine without the
onboarding task:

1. Create their account with the `ADMIN_TOKEN` - see
   [server/README.md](server/README.md#accounts). It returns their user id.
2. Run the [job-search-setup](.claude/skills/job-search-setup/) skill for
   them. It makes `private\<their id>\`, mints the token their scheduled runs
   use, reads their resume, asks about their tracks and locations, posts their
   config, and registers their scheduled tasks without touching anyone else's.

The same skill adds a track to an existing search later.

The API keeps each person's data separate, but whoever administers the
Cloudflare account can read all of it directly in D1.

## The demo account

An account whose every row is invented, for showing the tracker without
showing anyone's real search:

```powershell
.\scripts\seed-demo-user.ps1 -AdminToken <the ADMIN_TOKEN>
```

That creates an account called `Demo`, fills it from
[`scripts/demo-user.json`](scripts/demo-user.json), and prints the password to
sign in with (pass `-Password` to choose one). It writes through the ordinary
HTTP API, so seeding it also checks those routes end to end.

**The data is invented, not anonymised.** Northwind Systems and Kestrel
Analytics are not companies, and every posting URL is under `example.com`,
which can never resolve to a real job posting.

It has three tracks including a `fed_by` pair (one search filling two tabs),
leads across every status and every location tier, twenty screened postings,
and nine applications walked through the pipeline from "To Apply" to an offer.
Dates are stored as day offsets spread over the last twelve weeks, so the
Overview's weekly charts have something to show; re-run with `-Force` to move
them forward to today.

**It never writes to the shared company list.** The seed marks the account
`demo`, and the server refuses a demo account's `POST /api/coverage` - an
invented company on that list is one every real nightly run would go looking
for. Its rotation tab still shows the real list.

It has no `private\` folder, so `setup-scheduler.ps1` never schedules it.
`-Force` re-seeds an account that already holds data, purging its searches and
applications first, and refuses if any lead on it isn't an `example.com` URL.

## Backups

D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
doesn't survive `wrangler d1 delete` or losing the Cloudflare account, so these
scripts keep copies outside Cloudflare:

| | where | who can destroy it |
|---|---|---|
| working copy | `private\backups\` | anything running as you |
| archive | `%ProgramData%\JobSearchTracker\backups\` | only an elevated process |
| off-machine | OneDrive (or `JOB_SEARCH_BACKUP_MIRROR`) | deletable locally, but recoverable from the service's own trash |

`backup-tracker.ps1` writes the working copy and the mirror every night. It
checks each export before keeping it - right size, has tables, has rows, not
dramatically smaller than yesterday's.

`archive-backups.ps1` copies new exports into the archive. That folder is owned
by Administrators and read-only to everyone else, so an unelevated process - a
scheduled task, a script, an AI agent - can read the backups but not write,
rename, truncate or delete them. A task running as SYSTEM fills it.

**Every copy keeps 30 days.** A deleted account's data then leaves the backups
too: nothing of it is exported after the delete, and the last export that holds
it ages out a month later. Each copy prunes on its own rule, by the date in the
backup's name:

- The working copy and the mirror are pruned by `backup-tracker.ps1`, and only
  after a clean run - an export that landed and passed every check - so a
  broken or suspect export never deletes the good backups before it.
- The archive is pruned by its own SYSTEM task, and only while it holds an
  export from inside the window, so an export that has stopped running cannot
  empty it. Deleting from the working copy never deletes from the archive.

`-RetentionDays` on either script changes the window; 0 keeps everything.

Set it up once, from an **Administrator** PowerShell in the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\protect-backups.ps1
```

That creates the archive, sets its ownership and permissions, installs its own
copy of the archiver inside it (a task running as SYSTEM must never execute a
script you can edit), and registers both daily tasks: `JobSearchTracker-Backup`
at 03:15 as you, and `JobSearchTracker-ArchiveBackups` at 03:45 as SYSTEM.
Re-run it after changing `archive-backups.ps1`, and after moving the
repository: the archive task is registered with the folder it copies from, and
fails every night once that folder is gone.

Each archive run ends by checking the date on the newest archived export, and
writes `WARNING: ... backups have stopped reaching the archive` to
`archive.log` when it is two or more days old. The check runs however the run
went, including when the copy itself failed, since a failing archive task is
the usual way backups stop arriving. Task Scheduler shows the run as `1` for an
error and `2` for a warning.

Keep backup task names outside `JobSearch-*`: `setup-scheduler.ps1` unregisters
stale tasks under that prefix. The export runs only while you're logged in; the
archive runs regardless.

Then check it from an ordinary, **unelevated** window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-backups.ps1
```

It tries to overwrite, rename and delete an archived backup, to edit the script
SYSTEM runs, and to grant itself the permissions back - all of which must be
refused. It is safe to run: every archived file also exists in the working
folder and the mirror.

To restore, feed a `.sql` file back with `wrangler d1 execute <db> --remote
--file <backup.sql>`, into a freshly created D1 or one whose tables you have
dropped.

This makes a deletion recoverable, not impossible: wrangler's stored Cloudflare
credential can still delete the database.

## Things worth not relearning

**Verification is the whole game.** Every candidate URL must be fetched and
confirmed to render a real job description - title plus
responsibilities/qualifications. A search-engine snippet is a lead, not a
finding. Watch especially for URLs that resolve to a company's *listing
index* rather than the individual posting - the title text matches, so it
looks right, and it isn't.

**Per-company fetch notes in a track's baseline doc go stale.** Re-verify them
rather than trusting them.

**An amber dot on a track's tab means no run has reported in within
`stale_run_hours`** (default 36; raise it via `/api/config` if searches run less
often than daily). **A red dot means the last run reported an error.** Either
way, check the scheduled task and `private\<user-id>\logs\<track>.log` - a
search that stopped running looks like one that found nothing.

**Logging an application takes a URL.** Paste it on the Applications tab. One
nightly task per machine (`JobSearch-Applications`, 06:30) reads each posting
once and fills in company, role, location, work setup and posted comp - only
into empty fields, so what you type wins. A row it couldn't fully read says so
and isn't retried. Its log is `private\logs\applications.log`. See
[server/README.md](server/README.md#applications-added-as-nothing-but-a-url).

**A convention changed in one track's doc doesn't reach the others.** Each
`docs/tracked_<key>_postings.md` is self-contained; follow the
[change-search-prompt](.claude/skills/change-search-prompt/) skill to update
every track's doc.
