# Move the private folders into storage - implementation plan

> Status: **approved, not yet implemented** (2026-09-09, revised same day). Work
> is happening on branch `claude/private-folders-db-migration-26df85`. Phases
> 0-5 below are the agreed scope; nothing in them has landed yet, so this
> document *is* a description of intended behaviour rather than current
> behaviour - the inverse of `multi-user-plan.md`, which is kept as a record of
> why. Update this header as phases land, and retire the document to a "why"
> record once they all have.
>
> Written against the codebase at commit `ae30e32`. The decisions worth
> re-reading before changing course are in "The design in one idea": every
> document's content lives in R2 and D1 holds only an index of it; the runner
> materializes documents now and the prompt goes API-native later; no client UI
> this round; and the production data move stays a separate deliberate step.
>
> This document follows the repo's rule that no personal data lives here: it
> counts and sizes the files in the private silo and names accounts by the
> user-id prefix already present in `HANDOFF.md`, but quotes none of their
> contents.

## Context

Every person's durable job-search data is split across two homes. Leads, applications,
page config and the search config itself live in D1. But their **resumes** and their
**per-track baseline doc** live on one Windows machine, in a gitignored `private/`
folder that is copied between machines by hand.

`HANDOFF.md:137-139` already names this as blocking the hosted-service target:

> **`private/` must move into storage.** Resumes (`.docx`) and the per-track baseline doc
> `private/<user-id>/docs/tracked_<key>_postings.md` live on disk. The track doc is
> *edited by the run as it goes*, so it needs a real read-write home (R2 or D1), not a copy.

Two things make this worth doing now beyond the hosted-service goal:

1. **The silo is unbacked-up and machine-bound.** `backup-tracker.ps1` runs `wrangler d1
   export` nightly and archives it under SYSTEM-owned ACLs. Nothing does that for the
   resumes or the track docs. Lose the machine, lose them.
2. **The silo is 236 MB, of which ~1 MB is real.** `run-search.ps1:189` sets cwd to the
   durable user folder and the allowlist includes `Write`, so every run's scratch lands
   there permanently — 830 files, ~190 MB of `_ashby_openai.json` and `.tmp_run/`.

### What actually moves

| | Files | Size |
|---|---|---|
| `<user>/docs/*.md` — per-track baseline docs, read *and written* every run | 5 | ~380 KB |
| `<user>/resumes/*` — `.docx`/`.pdf` originals and their `.txt` extracts | 10 | ~640 KB |
| `<user>/reference/*` — resume text, historical tracker `.xlsx` | 3 | ~30 KB |

All of it to **R2**, with a **D1 index** row per file. See below for the split.

Stays on disk: `tracker.json` (the bootstrap credential — you need it to reach the API),
`deployment.json` (the `ADMIN_TOKEN`, which no session can hold), `logs/`, `backups/`.

Not migrated, discarded: `.tmp/`, `tmp/`, `raw/`, loose run scratch, `scheduled-tasks/*.md`
(legacy prompt files `private.example/README.md:83-91` already declares gone),
`worktree-leftovers/`, `.wrangler/cache/`, `applications/`, `cover-letters/`, `notes/`.

### The design in one idea

**One file = one R2 object + one D1 index row**, and **`path` is the join key.**

Each row carries the relative path the file used to occupy inside the person's folder —
`docs/tracked_cpm_postings.md`, `resumes/<name>_Resume.txt`. The R2 key is
`<user-id>/<path>`, derived rather than stored, so it cannot drift from the row. The runner
materializes each document back to its path in a scratch working directory before launching
`claude`, and posts the track doc back afterwards.

Two consequences worth stating plainly:

- **`prompt.js` needs no change at all in this round.** `tracks.doc_file` and the verbatim
  `tracks.resume_line` prose keep naming exactly the paths they name today, including the
  legacy filenames (`tracked_job_postings.md`) that `docs/multi-user-plan.md:314-316` calls
  load-bearing drift. The DB becomes the source of truth without one track's config being
  rewritten.
- **A resume and any text extract beside it are two documents, not one row with two
  representations.** `resumes/X.pdf` and `resumes/X.txt` each get a row. That is what they
  already are on disk, so whatever a track's `resume_line` names goes on resolving unchanged
  — including the tracks that name a `.docx`, and the one whose text fallback lives in
  `reference/` rather than `resumes/`.

It also fixes the scratch problem for free: cwd becomes a disposable per-run directory
rather than the durable silo.

**Why D1 holds an index rather than the content.** An earlier draft put the markdown in a
D1 `body` column, on the reasoning that `wrangler d1 export` would then back it up for free.
That argument dissolves once Phase 1 backs up R2 anyway — and the `body` column brought a
base64 upload path, a dual-storage branch in every handler, and D1's 2 MB row cap on a file
that grows every night. (The cap is roughly three years out at the observed ~1.5-2 KB/day,
so it is a ceiling rather than an emergency; the simplification is the real reason.)

**Why not skip D1 entirely and list the bucket.** `kind`, and which track's `doc_file` or
`resume_line` points at which document, are relational facts rather than object properties.
Keeping them in SQL beside `tracks` means questions about the two can be joined rather than
answered by listing a bucket and parsing filenames. `bytes` and `etag` are a cache of R2's
truth, rewritten on every put.

---

## Phase 0 — prerequisites (blocking)

- **R2 must be enabled on the Cloudflare account.** Even the free tier (10 GB, 1M Class A
  ops) requires activating R2 in the dashboard with a payment method on file. Nothing else
  here works until that is done — verify before writing code.
- `wrangler r2 bucket create job-search-tracker-docs`
- Take a `wrangler d1 export` backup (`scripts/backup-tracker.ps1`) before any deploy.
  `server/wrangler.toml:18-24` is explicit: `npm run deploy` from this repo applies
  migrations against real users' data.

---

## Phase 1 — schema, the storage layer, and the backup that makes it safe

### `server/migrations/0010_documents.sql` (new)

An index, not a store. Follows the house conventions (`TEXT NOT NULL DEFAULT ''` throughout,
`user_id` first, per-user uniqueness, no foreign keys). Additive only — creates an empty
table and backfills nothing, since the files it will index aren't reachable from D1.

```sql
CREATE TABLE IF NOT EXISTS documents (
  user_id      TEXT NOT NULL,
  path         TEXT NOT NULL,              -- relative path inside the person's folder,
                                           -- e.g. docs/tracked_cpm_postings.md.
                                           -- The R2 key is <user_id>/<path>, derived.
  kind         TEXT NOT NULL DEFAULT '',   -- 'doc' | 'resume' | 'reference'
  content_type TEXT NOT NULL DEFAULT '',
  bytes        INTEGER NOT NULL DEFAULT 0, -- cache of R2's truth, rewritten on every put
  etag         TEXT NOT NULL DEFAULT '',   -- ditto; what a conditional write matches on
  updated_at   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, path)
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
```

Keyed on `(user_id, path)` rather than `(user_id, track_key)` deliberately: two tracks can
point `doc_file` at the same doc, and resumes belong to no track at all.

Write the top-of-file prose comment in the style of `0005_company_sweeps.sql` and
`0009_application_autofill.sql` — per `.claude/skills/add-d1-migration/SKILL.md`, the comment
is the substantive part. `0005:8-13` is the precedent to engage with: it drew the line at
"the doc holds knowledge that has no DB equivalent". That still holds — the doc's content
isn't going into D1. What changes is that its *only copy* stops living on one laptop.

### `server/src/r2.js` (new)

The R2 analogue of `Db`'s "scoped at construction, no method left that *can* forget"
property (`db.js:9-19`). A new store is a new way to leak across users, and
`.claude/skills/add-api-route/SKILL.md`'s **"never check ownership"** rule needs an
equivalent here rather than an exception:

```js
export class Docs {
  constructor(bucket, userId) { this.bucket = bucket; this.userId = userId; }
  #key(path) { return `${this.userId}/${path}`; }   // every key, no exceptions
  async put(path, body, contentType, ifMatch)       // -> {etag, bytes}; onlyIf when ifMatch
  async get(path)                                    // -> R2ObjectBody | null
  async delete(path)
}
```

`put` passes `{ onlyIf: { etagMatches: ifMatch } }` when given one, and reports the miss
distinctly so the route can answer 412. Route handlers never touch `env.DOCS` directly,
exactly as they never touch `env.DB`.

### `server/src/db.js`

Add a `Document` `@typedef` beside the others (`db.js:40-169`) and a `// ---- documents --`
section, all filtering on `this.userId` like every other statement:

- `listDocuments()` — the index, ordered by path.
- `getDocument(path)` — one row, or `null`.
- `putDocument({path, kind, contentType, bytes, etag})` — upsert via
  `ON CONFLICT(user_id, path) DO UPDATE`, same shape as `setSetting` (`db.js:793`).
- `deleteDocument(path)`.
- Extend `purgeSearch` (`db.js:659`) to report the track's doc rather than orphan it.

### `server/src/index.js`

Construct it beside `Db` and add it to the `Ctx` typedef (`index.js:56-64`):

```js
db: new Db(env.DB, user.id),
docs: new Docs(env.DOCS, user.id),
```

### `server/wrangler.toml`

```toml
[[r2_buckets]]
binding = "DOCS"
bucket_name = "job-search-tracker-docs"
```

### `scripts/backup-tracker.ps1` — in this phase, not later

`wrangler d1 export` no longer covers the documents at all, so this stops being a
nice-to-have and becomes the thing that keeps the migration from *losing* the backup
property the silo accidentally had (a copy on a laptop). Walk `GET /api/documents` and save
each object under `private\backups\documents\<date>\<user>\<path>`, beside the existing
`.sql` export and inside the same `archive-backups.ps1` protection. **Do not deploy the
migration until this runs.**

---

## Phase 2 — API routes

New module `server/src/routes/documents.js`, four entries added to `SESSION_ROUTES` in
`server/src/routes/index.js` (`PUBLIC_ROUTES` stays at three). Handlers return `json()` /
`text()` from `http.js` and never build a `Response` — with one documented exception below.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/documents` | `{documents: [{path, kind, content_type, bytes, etag, updated_at}]}` |
| POST | `/api/documents/delete` | `{path}` — removes the row and its object |
| GET | `/^\/api\/documents\/(.+)$/` | streams the object with its stored content-type |
| POST | `/^\/api\/documents\/(.+)$/` | raw request body becomes the object; `?kind=`; optional `If-Match` |

Notes that matter:

- **`/api/documents/delete` must sit above the `(.+)` pattern.** `matchRoute` takes the first
  match (`routes/index.js:138-148`) and `(.+)` is greedy, so the order is load-bearing —
  the same care `/api/prompt/_applications` already needs (`routes/index.js:115-122`).
  Requiring every document path to contain a `/` keeps the two spaces disjoint.
- **The path pattern is `(.+)`, not `[^/]+`.** Document paths contain a slash; every other
  capture in the table is a single segment. Say so in the route comment so it isn't
  "corrected" later.
- **Reject `..`, absolute paths, backslashes, and paths with no `/`** — a validator in
  `server/src/validate.js` beside `unknownTrack`. The runner materializes these to disk, so
  traversal here is a write-anywhere primitive on the runner's machine.
- **Upload is the raw request body, not JSON.** No base64, no `readJson`. `Content-Type`
  carries the type, `?kind=` the classification. This is the first non-JSON payload in the
  API and the first handler that streams a `Response` body from R2 rather than calling
  `json()`/`text()` — both deserve a comment saying why the convention bends here.
- **`If-Match` gives the write-back a real guard.** Present and stale → 412, and the caller
  keeps its copy. Absent → unconditional, which is what the import script wants.

---

## Phase 3 — the runner materializes and syncs back

`scripts/run-search.ps1` is where the behaviour actually changes.

Today: cwd is `<DataDir>\<User>\`, the durable folder. The run reads `docs/<file>` and
`resumes/<file>` straight off disk, edits the doc in place, and leaves its scratch behind.

After:

1. Build a **disposable** run directory, `$runDir = <DataDir>\<User>\.run\<Task>`, wiped at
   the start of every run.
2. `GET /api/documents` → for each row, `GET /api/documents/<path>` written to
   `$runDir\<path>` (creating `docs\`, `resumes\`, `reference\` as needed). **Keep the etag
   of the track doc.** Log the count and total bytes.
3. `Set-Location $runDir` instead of `$workDir` (`run-search.ps1:189`).
4. After the run: if `$runDir\<doc_file>` changed, `POST /api/documents/<doc_file>` with
   `If-Match: <the etag from step 2>`.
5. **On 412, do not retry and do not discard.** Save the run's version to
   `$workDir\logs\<Task>-doc-conflict-<timestamp>.md` and fail loudly. Something else wrote
   the doc mid-run; a blind overwrite would erase it.
6. **Fail loudly on any failed write-back**, matching how a failed prompt fetch is fatal
   (`run-search.ps1:136-153`). A run whose findings didn't persist must not look like a
   success — the same class of bug as the `run-fill.ps1:246-270` check for a CLI that exits 0
   while unauthenticated.

`$workDir` is still resolved (it holds `tracker.json` and `logs\`) — only cwd moves.

`run-fill.ps1` and `setup-scheduler.ps1` need no change: they read no silo files, only
`<DataDir>\*\tracker.json`.

---

## Phase 4 — the import script

`scripts/import-documents.ps1` (new). One-shot, re-runnable, idempotent (every write is an
upsert on `path`). Takes `-DataDir` and optionally `-User`, defaulting the same way every
other script does (`$env:JOB_SEARCH_DATA_DIR`, else `..\private`).

Per user folder holding a `tracker.json`, walk `docs\`, `resumes\` and `reference\` and POST
each file's bytes to `/api/documents/<relative path>` with a `kind` from its folder and a
content-type from its extension. No pairing logic, no base64 — a `.pdf` and its `.txt`
sibling are simply two files.

- Read `docs\*.md` rather than globbing `tracked_*` — the real rule is "whatever each track's
  `doc_file` points at", and `ab266b6c-…`'s `tracked_job_postings.md` already fits no pattern.
- **After importing, print each track's `resume_line` next to whether the paths it names are
  now in the index.** Informational, not a gate: it is a cheap thing to show once everything
  is listed in one place, and it makes a `resume_line` pointing at a path that no longer
  exists visible rather than silent. It is deliberately *not* a readability judgement — see
  the note below.
- `-WhatIf` prints the plan without posting.

---

## Phase 5 — docs and skills

- `private.example/README.md` — rewrite the layout block. `docs/`, `resumes/` and
  `reference/` become "materialized from the tracker, not authored here"; `tracker.json` and
  `logs/` stay; add `.run/` as disposable. Also **document `deployment.json`** (`{url,
  admin_token}`), which `scripts/set-password.ps1:53-58` requires and which no document in
  the repo currently mentions.
- `README.md` — the local-vs-cloud split at `:14-18` and `:159-170`, the architecture
  alt-text at `:40`, the backup inventory at `:298-380` (R2 is new there), and the
  cross-track-doc-drift procedure at `:457-469` (reconciling five docs by hand becomes five
  API calls).
- `HANDOFF.md:137-139` — mark done, and record that prompt-native access is what's left.
- `docs/multi-user-plan.md:104-106` — its "the doc **stays a file**" claim is now superseded.
  Per its own status header the code wins; note the supersession rather than rewriting it.
- `.claude/skills/change-search-prompt/SKILL.md:12-19` — the third surface changes from
  `private/<user-id>/docs/…` on one machine to `GET/POST /api/documents`, and the
  reconciliation procedure at `:91-108` becomes listable rather than requiring the machine.
- `.claude/skills/job-search-setup/SKILL.md` — step 1 stops creating `docs/`/`resumes/`,
  step 2 uploads both the original and its text extract, step 4 posts the filled template to
  `/api/documents` instead of writing a file.
- `.claude/skills/add-api-route/SKILL.md` — a paragraph on the `Docs` scoping analogue, and
  on the two convention exceptions this module earns (raw body in, streamed body out).
- `.claude/skills/verify-and-deploy/SKILL.md` — the R2 bucket prerequisite.
- `.claude/hooks/block-remote-d1-writes.mjs` — extend `PROTECTED` to refuse
  `wrangler r2 bucket delete` and `wrangler r2 object delete`, with cases added to
  `block-remote-d1-writes.cases.json`.

---

## Verification

Follow `.claude/skills/verify-and-deploy/SKILL.md` — pick a free port, don't assume 8787,
never deploy from this worktree. `wrangler dev --local` provides a local R2 simulator, so
none of this needs a cloud bucket.

```bash
cd server && npx wrangler d1 migrations apply job-search-tracker-db --local
```

```bash
cd server && node verify-migration.mjs
```

```bash
cd server && npx wrangler dev --local --port 8799
```

```bash
cd server && node verify-local.mjs http://127.0.0.1:8799
```

- **`verify-migration.mjs`** — add a block: apply through `0010`, confirm `documents` exists
  empty and no pre-existing row's count or ids changed. Short, since it's additive.
- **`verify-local.mjs`** — a new `== documents ==` section, in the spirit of the file's
  stated purpose ("two people's data cannot reach each other"). The mandatory checks:
  Ada uploads `docs/x.md`, Bo gets 404 for the same path and his own upload of it creates a
  separate object; a `.pdf` round-trips **byte-identical** in and out; `If-Match` with a
  stale etag is 412 and leaves the object untouched; `..`, absolute paths, backslashes and
  a path with no `/` are all 400; `/api/documents/delete` removes both row and object; and
  the index reports the same `bytes`/`etag` a fresh GET does.
- **End-to-end**, against a **test account** (never a live one —
  `change-search-prompt/SKILL.md:123-133`): `import-documents.ps1 -WhatIf`, then for real;
  confirm the no-text-sibling warning fires for a fixture `.pdf`; run `run-search.ps1 -Task
  <key> -User <test-id>`; confirm `$runDir` was populated, the run read the doc, and the
  edited doc came back — `GET /api/documents/docs/<file>` should show the run's own edit.
  Then force the conflict path: overwrite the doc through the API while the run holds it,
  and check the run refuses with 412, writes its copy to `logs\`, and says so.

---

## Explicitly out of scope

- **The production data move.** This ships the schema, the API, the runner, the backup and
  the import tool, verified locally. Moving the three real accounts' documents is a separate,
  deliberate step: `d1 export` backup → deploy → `import-documents.ps1` → verify the R2
  backup runs → re-register the scheduled tasks from the main checkout (`HANDOFF.md:70-72` —
  the tasks still point at `C:/VibeCoding/job-search-tracker/`, not this repo).
- **Client UI.** No document viewing, editing or upload on the tracker page this round.
- **Prompt-native access.** `prompt.js` is untouched; the run still reads and edits files.
  Teaching the prompt to call `/api/documents` directly is the change that lands when the
  runner moves server-side, and the endpoints built here are the ones it will use.
- **Resume readability.** Whether a track's `resume_line` points at something the nightly run
  can actually open is identically true or false before and after this migration, so it is
  not this plan's problem. An earlier draft made it justification #2 and then built an audit
  around it; both were scope creep from having the folder inventoried. For the record, so it
  is not rediscovered as a crisis: `job-search-setup/SKILL.md:123-132`'s "always write a
  `.txt`" is a defensive convention against a specific tooling gap, not a property of the
  system — `Read` handles PDFs directly, `.docx` is the format that actually needs help, and
  every affected doc carries an inline `## Candidate Profile` section that step 1 reads
  first. Separately, `CPM`'s `resume_line` falls back "if that file isn't present" when the
  file is present and merely unreadable, so that branch cannot fire. A config fix, whenever
  someone wants it.
- **Pruning the track docs.** ~35% of `tracked_job_postings.md` is frozen history
  (`Removed / went dead`, frozen 2026-08-27). Worth doing, unrelated to storage.
- **Cleaning the 190 MB of existing scratch.** Phase 3 stops it accumulating; deleting
  what's there is a separate call, and `block-remote-d1-writes.mjs:78-86` deliberately
  guards that path.
