---
name: verify-and-deploy
description: Verify a change to this repo's tracker code and ship it - picking a free port for a local dev worker, running verify-local.mjs and verify-migration.mjs, and deploying server/ and client/ independently through their npm scripts. Use when asked to deploy, publish, release or ship the tracker, or to run the checks/tests/verification on a change to server/ or client/.
---

# Verifying and deploying a change

Two independent deployables, `server/` (Worker + D1 API) and `client/`
(Worker serving `public/` as static assets). They are versioned and deployed
separately: **deploy only the half you changed.** A client UI change never
needs a server deploy, and vice versa. Deploying the other half "to be safe"
is not free here - see the two rules below about what a deploy replaces.

CI (`.github/workflows/checks.yml`) covers `client-react/` and checks
`docs/schema.md` against the migrations; it deploys nothing. The server has no
test suite. What stands in for one is `server/verify-local.mjs`, and it only
runs if someone runs it.

## Before anything: where you are deploying from

**A deploy publishes the checkout, wholesale.** Both halves replace what is
live rather than merging into it, so anything the deploying checkout lacks
comes *down* off the live site.

1. **Never deploy from a git worktree.** Worktrees never carry gitignored
   files, and `client/public/local-config.js` - the file that tells the page
   which API to call - is gitignored. A worktree deploy of `client/` deletes
   it from the live site and everyone gets "This deployment has no API URL
   configured" at the sign-in screen. This has happened twice.
   `client/predeploy-check.mjs` now refuses that deploy, but only when the
   deploy goes through `npm run deploy` (see below) - it is not a substitute
   for being in the right place.
2. **Deploy only from `main`, in the main checkout, with a clean tree and up
   to date with origin.** Confirm all four before you start:

   ```bash
   git -C <main checkout> status -sb
   ```

   A branch deploy publishes that branch's code as the live tracker, including
   whatever it is missing relative to main.
3. **Look at what is already deployed before you overwrite it.** Up to date
   with `origin/main` is not the same claim as up to date with what is *live*,
   and the two came apart on 2026-09-10: one session deployed a feature from a
   branch not yet merged, a second session deployed a legitimate fast-forward
   of `main` an hour later, and the first feature came off the site. Nothing
   failed. The D1 migration it needed stayed applied, so the table sat there
   with code that no longer knew it existed.

   ```bash
   cd server && npx wrangler deployments status
   ```

   That gives the live version id and when it was created - enough to see that
   *someone* deployed since you last looked, not what they shipped. If the
   timestamp is newer than you expect, find out what went out before you
   replace it, and probe the live site for the feature you think is there
   rather than assuming. A behavioural probe is what actually caught this:

   ```bash
   curl -s "$TRACKER_URL/api/coverage/<key>" -H "Authorization: Bearer $TOKEN"
   ```

If the session is in a worktree (which it usually is), the deploy is not
yours to run: verify here, get the change merged to main, and tell the person
the exact command to run from the main checkout.

**If the main checkout has diverged** - another session commits there too, and
it may be ahead with unpushed work, behind, or both - do not pull or merge it
to tidy it up. That is someone else's tree. What actually has to be true is
narrower than "the checkout is clean": *the half you are deploying* must equal
the tree you verified. Check that directly and deploy on the answer:

```bash
git -C <main checkout> diff --stat HEAD origin/main -- server/   # empty = same
```

Empty means a `server/` deploy from there ships exactly what you tested, and
their in-flight `client/` work is irrelevant to it. Non-empty means stop.

## Verifying a `server/` change

The property worth checking before every server deploy is that **two people's
data cannot reach each other**. `verify-local.mjs` is 170+ checks, most of
them one user trying to read or write another's rows by id and getting a 404.
A missing `AND user_id = ?` in `db.js` fails nothing, breaks no page, and
silently serves someone else's job search - this is the only thing that
catches it.

Run it against a **local** database. It creates users and writes freely.

### 1. Pick a port, and know it is free

Do not assume 8787. That port collects stale `wrangler dev` workers from
earlier sessions, and a stale one is worse than a dead one: the checks pass,
against code you did not write. Pick a port and confirm nothing holds it:

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
Then confirm the thing answering is the worker you just started - an
unauthenticated request to a route that exists should come back `401`, not a
connection error and not a 404:

> **A 401 proves *a* worker is there, not that it is *yours*.** Two
> `wrangler dev` processes can both hold the same port on Windows without the
> second one failing loudly, and the pre-existing one answers. That happened on
> 2026-09-10: the checks ran against another session's worker, serving the main
> checkout against a local database two migrations old, and reported a crash
> that had nothing to do with the code under test. Prove ownership two ways
> before trusting a single result:
>
> ```bash
> netstat -ano | grep -E ":8788\s"        # exactly one LISTENING line
> ```
>
> and probe for something only your tree emits - a field a route gained in the
> change you are testing, or a stack trace naming your directory. A port that
> was free ten seconds ago is not the same claim as a port that is yours now.
> This matters more than it used to: several sessions work this repo at once.

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8788/api/data
```

`wrangler dev --local` simulates the `DOCS` R2 bucket, so the document checks
need no cloud bucket and no account with R2 enabled. Its startup banner should
list both bindings - `env.DB` and `env.DOCS` - and a missing `env.DOCS` there
means the config is wrong rather than the account: the document checks would
then fail as `503 documents are not configured` while everything else passed.

### 3. Run the checks

```bash
cd server && node verify-local.mjs http://127.0.0.1:8788 local-admin-token-for-testing
```

It prints `N passed, M failed` and exits non-zero on any failure. Re-running
against the same local database is fine - it resets its own fixtures.

**Read the failures, do not just count them.** A run that fails to connect
fails everything at once and means the port is wrong, not that the change
broke 170 things.

### 4. If you touched `migrations/`

`verify-local.mjs` only ever sees a database the migrations built from empty,
so it cannot notice a migration losing a column or dropping rows on a
database that already had data. That is a separate check, in-process, no
wrangler, nothing to clean up:

```bash
cd server && node verify-migration.mjs
```

Then check `docs/schema.md` still matches what the migrations build. CI runs
this too, but only once the push has landed:

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
`block-remote-d1-writes` hook deliberately permits `migrations apply`; it is
data writes it refuses.

**If this deploy carries a migration, take a backup first** -
`scripts/backup-tracker.ps1`. A migration is the one thing here that runs once
against real data and cannot be undone.

**The target account must have R2 enabled**, because `wrangler.toml` binds a
`DOCS` bucket. If it does not, `wrangler deploy` fails with

```
Please enable R2 through the Cloudflare Dashboard. [code: 10042]
```

That is a refused deploy, not a broken one - the running worker is untouched -
but it is a wall, and `wrangler deploy --dry-run` will not warn you because it
validates offline. Check with `npx wrangler r2 bucket list` before deploying to
an account for the first time; an empty list is a pass, the 10042 is not. The
fix is a dashboard step, not a code one: see `server/README.md`'s
"First: turn on R2".

**In PowerShell, use `npx.cmd` and `npm.cmd`.** Windows' default execution
policy blocks the `.ps1` shims Node installs, so `npx wrangler ...` and
`npm run deploy` both die with "running scripts is disabled on this system"
before running anything. The Bash tool is unaffected (no `.ps1` involved), and
so is this session's own PowerShell, which runs with `-ExecutionPolicy Bypass` -
which is exactly why it is easy to write instructions here that fail for the
person who follows them.

## Verifying a `client/` change

No build step, no test harness - it is one HTML file. Verification is
opening it. See the `edit-tracker-page` skill for how to drive it against the
live API.

Deploy through the npm script, never a bare `wrangler deploy`:

```bash
cd client && npm run deploy
```

The `predeploy` hook runs `predeploy-check.mjs`, which refuses the deploy if
`public/local-config.js` is missing. `wrangler deploy` on its own skips that
hook entirely, which is exactly the mistake it exists to catch.

## What a deploy does not cover

- **The nightly runs.** Their prompts come from `/api/prompt/:key`, composed
  server-side from D1 config, so a `prompt.js` change reaches every run on the
  next server deploy with nothing to re-register. The per-track docs on disk
  are a separate surface - see `change-search-prompt`.
- **Scheduled tasks.** Adding or renaming a track needs
  `scripts/setup-scheduler.ps1` re-run on the machine that runs those
  searches. No deploy registers a task.
- **Config.** Tracks, tab labels, page title and location tiers live in D1 via
  `/api/config`, not in either checkout. A deploy never changes them - and
  never restores them either.
