---
name: verify-and-deploy
description: Verify a change to this repo's tracker code and ship it - picking a free port for a local dev worker, running verify-local.mjs and verify-migration.mjs, and deploying server/ and client/ independently through their npm scripts. Use when asked to deploy, publish, release or ship the tracker, or to run the checks/tests/verification on a change to server/ or client/.
---

# Verifying and deploying a change

Two independent deployables, `server/` (Worker + D1 API) and `client/`
(Worker serving `public/` as static assets). They are versioned and deployed
separately: **deploy only the half you changed.** A client UI change never
needs a server deploy, and vice versa.

CI (`.github/workflows/checks.yml`) covers `client-react/` and checks
`docs/schema.md` against the migrations; it deploys nothing and does not run
`server/verify-local.mjs`. The server has no test suite - run
`verify-local.mjs` yourself.

## Before anything: where you are deploying from

**A deploy publishes the checkout, wholesale.** Both halves replace what is
live rather than merging into it, so anything the deploying checkout lacks
comes *down* off the live site.

1. **Never deploy from a git worktree.** Worktrees never carry gitignored
   files, and `client/public/local-config.js` - which tells the page which API
   to call - is gitignored. A worktree deploy of `client/` deletes it from the
   live site, and sign-in shows "This deployment has no API URL configured".
   `client/predeploy-check.mjs` refuses that deploy only when it goes through
   `npm run deploy`.
2. **Deploy only from `main`, in the main checkout, with a clean tree and up
   to date with origin.** Confirm all four before you start:

   ```bash
   git -C <main checkout> status -sb
   ```

   A branch deploy publishes that branch's code as the live tracker, minus
   whatever it lacks relative to main.
3. **Check what is live before replacing it:** `npx wrangler deployments
   status` (from `server/`). If it's newer than you expect, find out what
   shipped and probe the live site for it first.

If the session is in a worktree, the deploy is not yours to run: verify here,
get the change merged to main, and tell the person the exact command to run
from the main checkout.

**If the main checkout has diverged** - another session commits there too, and
it may be ahead with unpushed work, behind, or both - do not pull or merge it
to tidy it up. That is someone else's tree. What has to be true is narrower
than "the checkout is clean": *the half you are deploying* must equal the tree
you verified. Check that directly and deploy on the answer:

```bash
git -C <main checkout> diff --stat HEAD origin/main -- server/   # empty = same
```

Empty means a `server/` deploy from there ships exactly what you tested, and
their in-flight `client/` work is irrelevant to it. Non-empty means stop.

## Verifying a `server/` change

The property to check before every server deploy is that **two people's data
cannot reach each other**. Most of `verify-local.mjs`'s checks are one user
trying to read or write another's rows by id and getting a 404. It is the only
thing that catches a missing `AND user_id = ?` in `db.js`.

Run it against a **local** database. It creates users and writes freely.

### 1. Pick a port, and know it is free

Do not assume 8787 - stale `wrangler dev` workers collect there, and checks
against a stale one pass against code you did not write. Pick a port and
confirm nothing holds it:

```bash
netstat -ano | grep -E ":(8788)\s" ; echo "exit $? (1 = free)"
```

### 2. Start the worker and prove it is yours

```bash
cd server
echo ADMIN_TOKEN=local-admin-token-for-testing > .dev.vars
npx wrangler d1 migrations apply job-search-tracker-db --local
npx wrangler dev --local --port 8788
```

Run `wrangler dev` in the background and wait for it to report listening.
Then an unauthenticated request to a route that exists should come back
`401`, not a connection error and not a 404:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8788/api/data
```

**A 401 proves a worker is listening, not that it is yours** - two
`wrangler dev` processes can share a port on Windows. Confirm exactly one
LISTENING line, and probe for something only your change emits (a field a
route gained, or a stack trace naming your directory):

```bash
netstat -ano | grep -E ":8788\s"        # exactly one LISTENING line
```

`wrangler dev --local` simulates the `DOCS` R2 bucket. Its startup banner must
list both `env.DB` and `env.DOCS`; a missing `env.DOCS` is a config error, and
the document checks will fail as `503 documents are not configured`.

**When you are done, stop it by killing the tree from the `wrangler` node
parent** - stopping the backgrounded command leaves `workerd` holding the
port. Kill only a worker you can attribute to your port and start time; a
`workerd` running out of `C:\VibeCoding\jobsearch-cloud\server\node_modules`
belongs to the main checkout.

```powershell
$w = Get-NetTCPConnection -LocalPort 8788 -State Listen | Select-Object -First 1
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$($w.OwningProcess)").ParentProcessId
taskkill /PID $parent /T /F
```

Then confirm the port is free.

### 3. Run the checks

```bash
cd server && node verify-local.mjs http://127.0.0.1:8788 local-admin-token-for-testing
```

It prints `N passed, M failed` and exits non-zero on any failure. Re-running
against the same local database is fine - it resets its own fixtures.

**Read the failures, do not just count them.** A run where everything fails at
once means the port is wrong, not the change.

### 4. If you touched `migrations/`

`verify-local.mjs` only sees a database the migrations built from empty. A
migration losing a column or dropping rows on existing data needs the
separate in-process check (no wrangler, nothing to clean up):

```bash
cd server && node verify-migration.mjs
```

Then check `docs/schema.md` still matches what the migrations build (CI runs
this too, after the push):

```bash
cd server && node verify-schema-doc.mjs
```

See the `add-d1-migration` skill for the rest of what a schema change needs.

### 5. Deploy

```bash
cd server && npm run deploy
```

That is `wrangler d1 migrations apply DB --remote && wrangler deploy` - the
migration runs first, and a failed migration stops the deploy. The
`block-remote-d1-writes` hook permits `migrations apply` and refuses data
writes.

**If this deploy carries a migration, take a backup first** -
`scripts/backup-tracker.ps1`.

**The target account must have R2 enabled** (`wrangler.toml` binds a `DOCS`
bucket); otherwise `wrangler deploy` refuses with
`Please enable R2 through the Cloudflare Dashboard. [code: 10042]`, and
`--dry-run` does not catch it. Before a first deploy to an account, run
`npx wrangler r2 bucket list`: an empty list passes, the 10042 does not. The
fix is a dashboard step - `server/README.md`, "First: turn on R2".

**In PowerShell, use `npx.cmd` and `npm.cmd`** - Windows' default execution
policy blocks the `.ps1` shims. Write instructions for a person that way even
though this session's shells run with the policy bypassed. Detail:
`server/README.md`, "One-time setup".

## Verifying a `client/` change

No build step, no test harness - it is one HTML file. Verification is opening
it; see the `edit-tracker-page` skill for driving it against the live API.

Deploy through the npm script, never a bare `wrangler deploy`:

```bash
cd client && npm run deploy
```

The `predeploy` hook runs `predeploy-check.mjs`, which refuses the deploy if
`public/local-config.js` is missing. A bare `wrangler deploy` skips that hook.

## What a deploy does not cover

- **The nightly runs.** Their prompts come from `/api/prompt/:key`, composed
  server-side from D1 config, so a `prompt.js` change reaches every run on the
  next server deploy with nothing to re-register. Track baseline docs live in
  the tracker and take effect on the next run - see `change-search-prompt`.
- **Scheduled tasks.** Adding or renaming a track needs
  `scripts/setup-scheduler.ps1` re-run on the machine that runs those
  searches. No deploy registers a task.
- **Config.** Tracks, tab labels, page title and location tiers live in D1 via
  `/api/config`, not in either checkout. A deploy never changes them - and
  never restores them either.
