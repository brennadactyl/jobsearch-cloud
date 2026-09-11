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
.claude/skills/
  job-search-setup/           AI-assisted onboarding - see Setup below
docs/
  README.md                   which docs describe the system today and which are plans
  schema.md                   every D1 table as the migrations leave it
  architecture.svg           the diagram above
  architecture.html           full architecture write-up (open in a browser)
  *-plan.md                   plans - changes intended or made, not a description of today
scripts/
  run-search.ps1              runs one track for one person (fetches its prompt AND documents from the API)
  tracker.ps1                  every API call a run makes, as a command - copied into the run directory
  run-fill.ps1                 reads the postings behind URL-only applications - every account, one run
  import-documents.ps1         uploads a folder's resumes and baseline docs into the tracker
  setup-scheduler.ps1          registers every person's tracks as daily Windows Scheduled Tasks
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
  src/r2.js                     all R2 access for their documents - resumes, baseline docs
  src/prompt.js                 composes each track's daily search prompt from its config
  migrations/                   the D1 schema, applied via `wrangler d1 migrations apply`
  wrangler.toml                  deploy config
  package.json                   lets the Deploy to Cloudflare button chain migrations + deploy
  README.md                      one-time deploy instructions + API reference
client/                        the tracker webpage - static, no build step
  public/index.html             standalone HTML+CSS+JS, calls server/'s API cross-origin (only public/ is served)
  wrangler.toml                  deploy config (Worker serving public/ as static assets)
  package.json                   lets the Deploy to Cloudflare button deploy it
  README.md                      one-time deploy instructions
client-react/                  a second, unfinished client for the same API - see its README.md
private.example/
  README.md                    expected layout for your own private data folder
```

Deploy `server/` and `client/` separately. A change to one needs the other
redeployed only when it depends on something new - `server/README.md`'s API
section says what the server supports.

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

   Same flow - it forks the client into your own GitHub and deploys it as a
   Worker serving a static page.

   **Required before it will work:** in your fork, create
   `client/public/local-config.js` (copy `local-config.example.js`) with your
   API Worker's URL, and redeploy. Without it the page says "This deployment
   has no API URL configured". See [client/README.md](client/README.md).

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
   `setx JOB_SEARCH_DATA_DIR "C:\path\to\private"`, or just place it at
   `private\` next to this repo (already gitignored).
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
leads, page title and location rules, and its own sign-in. To add someone:

1. Create their account with the `ADMIN_TOKEN` - see
   [server/README.md](server/README.md#accounts). It returns their user id.
2. Run the [job-search-setup](.claude/skills/job-search-setup/) skill for
   them - it makes `private\<their id>\`, mints the token their scheduled
   runs use, reads their resume, asks about their tracks and locations,
   posts their config, and registers their scheduled tasks without touching
   anyone else's.

They sign in on the same tracker URL with their own name and password.
Their searches run on whichever machine holds their folder, under that
machine's Claude account - so stagger everyone's `schedule_time`, since each
run takes several minutes and they share one CLI.

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
Dates are stored as day offsets; re-run with `-Force` to move them forward to
today.

**It never writes to the shared company list.** The seed marks the account
`demo`, and the server refuses a demo account's `POST /api/coverage` - an
invented company on that list is one every real nightly run would go looking
for. Its rotation tab still shows the real list.

It has no `private\` folder, so `setup-scheduler.ps1` never schedules it.
`-Force` re-seeds an account that already holds data, and refuses if any lead
on it isn't an `example.com` URL.

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
dramatically smaller than yesterday's - and never deletes old backups.

`archive-backups.ps1` copies new exports into the archive. That folder is owned
by Administrators and read-only to everyone else, so an unelevated process - a
scheduled task, a script, an AI agent - can read the backups but not write,
rename, truncate or delete them. A task running as SYSTEM fills it.

Set it up once, from an **Administrator** PowerShell in the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\protect-backups.ps1
```

That creates the archive, sets its ownership and permissions, installs its own
copy of the archiver inside it (a task running as SYSTEM must never execute a
script you can edit), and registers both daily tasks: `JobSearchTracker-Backup`
at 03:15 as you, and `JobSearchTracker-ArchiveBackups` at 03:45 as SYSTEM.
Re-run it after changing `archive-backups.ps1`.

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
