# Move the private folders into storage - implementation plan

> Status: **approved, not yet implemented** (2026-09-09). Work is happening on
> branch `claude/private-folders-db-migration-26df85`. Phases 0-5 below are the
> agreed scope; nothing in them has landed yet, so this document *is* a
> description of intended behaviour rather than current behaviour - the inverse
> of `multi-user-plan.md`, which is kept as a record of why. Update this header
> as phases land, and retire the document to a "why" record once they all have.
>
> Written against the codebase at commit `ae30e32`. The design decisions in
> "The design in one idea" and the four choices it records (R2 for binaries and
> D1 for text; the runner materializes now and the prompt goes API-native
> later; no client UI this round; the production data move stays a separate
> deliberate step) are the part worth re-reading before changing course.
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

Three things make this worth doing now beyond the hosted-service goal:

1. **The silo is unbacked-up and machine-bound.** `backup-tracker.ps1` runs `wrangler d1
   export` nightly and archives it under SYSTEM-owned ACLs. Nothing does that for the
   resumes. Lose the machine, lose the resumes and five accumulated knowledge docs.
2. **Two of three accounts have a silently broken resume.** `job-search-setup/SKILL.md:123-132`
   warns that a resume stored only as `.pdf`/`.docx` is one the headless run reads *nothing*
   from, every night, forever — it screens every posting against an empty profile and reports
   success. Account `49732752-…` has a PDF with no `.txt` anywhere; `ab266b6c-…` keeps its
   `.txt` in `reference/`, not `resumes/`. Nothing can detect this today.
3. **The silo is 236 MB, of which ~1 MB is real.** `run-search.ps1:189` sets cwd to the
   durable user folder and the allowlist includes `Write`, so every run's scratch lands
   there permanently — 830 files, ~190 MB of `_ashby_openai.json` and `.tmp_run/`.

### What actually moves

| | Files | Size | Destination |
|---|---|---|---|
| `<user>/docs/tracked_*.md` | 5 | ~380 KB | **D1** (`documents.body`) — read *and written* by every run |
| `<user>/resumes/*` | 10 | ~640 KB | **R2** binary + **D1** extracted text |
| `<user>/reference/*` | 3 | ~30 KB | **R2** binary + **D1** extracted text |

Stays on disk: `tracker.json` (the bootstrap credential — you need it to reach the API),
`deployment.json` (the `ADMIN_TOKEN`, which no session can hold), `logs/`, `backups/`.

Not migrated, discarded: `.tmp/`, `tmp/`, `raw/`, loose run scratch, `scheduled-tasks/*.md`
(legacy prompt files `private.example/README.md:83-91` already declares gone),
`worktree-leftovers/`, `.wrangler/cache/`, `applications/`, `cover-letters/`, `notes/`.

### The design in one idea

**`path` is the join key.** Each document row carries the relative path it used to occupy
inside the person's folder — `docs/tracked_cpm_postings.md`, `resumes/Brenna_Duffitt_Resume.txt`.
The runner materializes each row back to that path in a scratch working directory before
launching `claude`, and posts the track doc back afterwards.

That means **`prompt.js` needs no change at all in this round.** `tracks.doc_file` and the
verbatim `tracks.resume_line` prose keep naming exactly the paths they name today, including
the legacy filenames (`tracked_job_postings.md`) that `docs/multi-user-plan.md:314-316` calls
load-bearing drift. The DB becomes the source of truth without a single track's config being
rewritten.

It also fixes the scratch problem for free: cwd becomes a disposable per-run directory
rather than the durable silo.

---

## Phase 0 — prerequisites (blocking)

- **R2 must be enabled on the Cloudflare account.** Even the free tier (10 GB, 1M Class A ops)
  requires activating R2 in the dashboard with a payment method on file. Nothing else here
  works until that is done — verify before writing code.
- `wrangler r2 bucket create job-search-tracker-docs`
- Take a `wrangler d1 export` backup (`scripts/backup-tracker.ps1`) before any deploy.
  `server/wrangler.toml:18-24` is explicit: `npm run deploy` from this repo applies
  migrations against real users' data.

---

## Phase 1 — schema and the storage layer

### `server/migrations/0010_documents.sql` (new)

One table, following the house conventions (`TEXT NOT NULL DEFAULT ''` throughout,
`user_id` first, per-user uniqueness, no foreign keys). Additive only — creates an empty
table, backfills nothing, since the files it will hold aren't reachable from D1.

```sql
CREATE TABLE IF NOT EXISTS documents (
  user_id      TEXT NOT NULL,
  path         TEXT NOT NULL,              -- relative path inside the person's folder,
                                           -- e.g. docs/tracked_cpm_postings.md
  kind         TEXT NOT NULL DEFAULT '',   -- 'doc' | 'resume' | 'reference'
  body         TEXT NOT NULL DEFAULT '',   -- the text the run reads: the whole file for
                                           -- markdown/txt, the extraction for a binary
  content_type TEXT NOT NULL DEFAULT '',
  r2_key       TEXT NOT NULL DEFAULT '',   -- '' when there is no binary original
  bytes        INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, path)
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
```

Keyed on `(user_id, path)` rather than `(user_id, track_key)` deliberately: two tracks can
point `doc_file` at the same doc, and resumes belong to no track at all.

Write the top-of-file prose comment in the style of `0005_company_sweeps.sql` and
`0009_application_autofill.sql` — per `.claude/skills/add-d1-migration/SKILL.md`, the comment
is the substantive part. `0005:8-13` is the direct precedent to argue *against*: it drew the
line at "the doc holds knowledge that has no DB equivalent". The counter-argument is that the
doc's problem was never its content but its *only copy living on one laptop*.

### `server/src/db.js`

Add a `Document` `@typedef` beside the others (`db.js:40-169`) and a `// ---- documents --`
section of methods, all filtering on `this.userId` like every other statement:

- `listDocuments()` — metadata only, **no `body`**. `db.js:363-377` records a live incident
  where a 398 KB response was fetched to use 22 KB of it; bodies total ~380 KB and this is
  fetched at the top of every nightly run.
- `getDocument(path)` — the full row including `body`, or `null`.
- `putDocument({path, kind, body, contentType, r2Key, bytes})` — upsert via
  `ON CONFLICT(user_id, path) DO UPDATE`, same shape as `setSetting` (`db.js:793`).
- `deleteDocument(path)` — returns the row's `r2_key` so the caller can drop the object too.
- Extend `purgeSearch` (`db.js:659`) to report the track's doc rather than orphan it.

### `server/src/r2.js` (new)

The R2 analogue of `Db`'s "scoped at construction, no method left that *can* forget"
property (`db.js:9-19`). A new store gets a new way to leak across users, and
`.claude/skills/add-api-route/SKILL.md`'s **"never check ownership"** rule needs an
equivalent here rather than an exception:

```js
export class Docs {
  constructor(bucket, userId) { this.bucket = bucket; this.userId = userId; }
  #key(path) { return `${this.userId}/${path}`; }   // every key, no exceptions
  async put(path, bytes, contentType) { ... }
  async get(path) { ... }
  async delete(path) { ... }
}
```

Route handlers never touch `env.DOCS` directly, exactly as they never touch `env.DB`.

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

---

## Phase 2 — API routes

New module `server/src/routes/documents.js`, four entries added to `SESSION_ROUTES` in
`server/src/routes/index.js` (`PUBLIC_ROUTES` stays at three). Handlers return `json()` /
`text()` from `http.js` and never build a `Response`.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/documents` | `{documents: [{path, kind, content_type, bytes, updated_at, has_body, has_binary}]}` — metadata only |
| GET | `/^\/api\/documents\/(.+)$/` | the document's `body` as `text/plain`; `?binary=1` streams the R2 object with its own content-type |
| POST | `/api/documents` | upsert `{path, kind?, body?, content_type?, data_b64?}` |
| POST | `/api/documents/delete` | `{path}` — removes the row and its R2 object |

Notes that matter:

- **The path pattern is `(.+)`, not `[^/]+`.** Document paths contain a slash. Every other
  path capture in the table is a single segment; call this out in the route comment so it
  isn't "corrected" later. It sits below the existing routes, and `matchRoute` takes the
  first match (`routes/index.js:138-148`), so it can't shadow anything.
- **Reject `..`, absolute paths, and backslashes in `path`** — a validator in
  `server/src/validate.js` beside `unknownTrack`. The path is materialized to disk by the
  runner, so traversal here is a write-anywhere primitive on the runner's machine.
- **Binary in and out are asymmetric on purpose.** Upload is base64 inside the ordinary JSON
  body so `readJson` and the one-content-type convention hold (largest real file is 250 KB →
  ~340 KB base64, far inside a Worker's limit, and it never reaches D1 so the 100 KB SQL
  statement cap is irrelevant). Download streams raw bytes, because the only consumer that
  wants the binary is a human saving a file.
- `POST /api/documents` with a `body` and no `data_b64` leaves any existing `r2_key`
  untouched — that's the nightly write-back path, and it must not orphan a resume's binary.
- The `application/json; charset=utf-8` note at `http.js:38-44` (PowerShell 5.1 falls back to
  Latin-1) applies squarely here: track docs are full of em-dashes.

---

## Phase 3 — the runner materializes and syncs back

`scripts/run-search.ps1` is where the behaviour actually changes.

Today: cwd is `<DataDir>\<User>\`, the durable folder. The run reads `docs/<file>` and
`resumes/<file>` straight off disk, edits the doc in place, and leaves its scratch behind.

After:

1. Build a **disposable** run directory, `$runDir = <DataDir>\<User>\.run\<Task>`, wiped at
   the start of every run.
2. `GET /api/documents` → for each row with a body, `GET /api/documents/<path>` and write it
   to `$runDir\<path>` (creating `docs\`, `resumes\`, `reference\` as needed). Log the count
   and the total bytes.
3. `Set-Location $runDir` instead of `$workDir` (`run-search.ps1:189`).
4. After the run: read back `$runDir\<doc_file>` and `POST /api/documents` if it changed.
5. **Guard the write-back.** Refuse to post a doc that is empty or has lost more than half
   its bytes, unless `-ForceDocWrite`. A silent truncation here destroys the one artifact
   holding every accumulated fetch-reliability finding — the same class of failure as the
   `run-fill.ps1:246-270` check for a CLI that exits 0 while unauthenticated.
6. **Fail loudly on a failed write-back**, matching how a failed prompt fetch is fatal
   (`run-search.ps1:136-153`). A run whose findings didn't persist must not look like a
   success.

`$workDir` is still resolved (it holds `tracker.json` and `logs\`) — only cwd moves.

`run-fill.ps1` needs no change: it reads no silo files, only `<DataDir>\*\tracker.json`.
`setup-scheduler.ps1` needs no change for the same reason.

---

## Phase 4 — the import script

`scripts/import-documents.ps1` (new). One-shot, re-runnable, idempotent (every write is an
upsert on `path`). Takes `-DataDir` and optionally `-User`, defaulting the same way every
other script does (`$env:JOB_SEARCH_DATA_DIR`, else `..\private`).

Per user folder holding a `tracker.json`:

- `docs\*.md` → `kind='doc'`, `body` = file contents, no binary.
- `resumes\*`, `reference\*` → `kind='resume'` / `'reference'`. Binary files
  (`.docx`/`.pdf`/`.xlsx`) upload as `data_b64` with a content-type; a `.txt`/`.md` sibling
  sharing the basename supplies `body`. Plain-text files upload as `body` with no binary.
- **Report every binary that got no text, by name, as a warning** — this is the check that
  surfaces the two accounts currently screening against an empty profile. Extracting the
  text is a human job (the `docx` / `pdf` skills), not something to guess at here.
- `-WhatIf` prints the plan without posting.

---

## Phase 5 — docs and skills

- `private.example/README.md` — rewrite the layout block. `docs/`, `resumes/` and
  `reference/` become "materialized from the tracker, not authored here"; `tracker.json` and
  `logs/` stay; add `.run/` as disposable. Also **document `deployment.json`** (`{url,
  admin_token}`), which `scripts/set-password.ps1:53-58` requires and which no document in
  the repo currently mentions.
- `README.md` — the local-vs-cloud split at `:14-18` and `:159-170`, the architecture
  alt-text at `:40`, and the cross-track-doc-drift procedure at `:457-469` (reconciling five
  docs by hand becomes five API calls).
- `HANDOFF.md:137-139` — mark done, and record that phase 2 (prompt-native) is what's left.
- `docs/multi-user-plan.md:104-106` — its "the doc **stays a file**" claim is now superseded.
  Per its own status header, the code wins; note the supersession rather than rewriting it.
- `.claude/skills/change-search-prompt/SKILL.md:12-19` — the third surface changes from
  `private/<user-id>/docs/…` on one machine to `GET/POST /api/documents`, and the
  reconciliation procedure at `:91-108` becomes listable rather than requiring the machine.
- `.claude/skills/job-search-setup/SKILL.md` — step 1 stops creating `docs/`/`resumes/`,
  step 2's `.txt` rule becomes "upload both the original and its text", step 4 posts the
  filled template to `/api/documents` instead of writing a file.
- `.claude/skills/add-api-route/SKILL.md` — one paragraph on the `Docs` scoping analogue.
- `.claude/skills/verify-and-deploy/SKILL.md` — the R2 bucket prerequisite.
- `.claude/hooks/block-remote-d1-writes.mjs` — extend `PROTECTED` to refuse
  `wrangler r2 bucket delete` and `wrangler r2 object delete`, with cases added to
  `block-remote-d1-writes.cases.json`.
- `scripts/backup-tracker.ps1` — **R2 is not covered by `d1 export`.** Add a step that walks
  `GET /api/documents` and saves each binary under `private\backups\documents\<date>\`.
  Without this the resumes go from unbacked-up-on-disk to unbacked-up-in-the-cloud.

---

## Verification

Follow `.claude/skills/verify-and-deploy/SKILL.md` — pick a free port, don't assume 8787,
never deploy from this worktree.

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
  empty, and that no pre-existing row's count or ids changed. Short, since it's additive.
- **`verify-local.mjs`** — a new `== documents ==` section. The mandatory checks, in the
  spirit of the file's stated purpose ("two people's data cannot reach each other"):
  Ada uploads `docs/x.md`, Bo cannot read it and gets 404; Bo uploading the same `path`
  creates a separate row; a binary round-trips byte-identical through base64 up and raw
  down; re-posting `body` alone preserves `r2_key`; `../` and absolute paths are 400;
  `GET /api/documents` returns no `body`; delete removes both row and object.
  `wrangler dev --local` provides a local R2 simulator, so this needs no cloud bucket.
- **End-to-end**, against a **test account** (never a live one — `change-search-prompt/SKILL.md:123-133`):
  import a fixture folder with `import-documents.ps1 -WhatIf`, then for real; run
  `run-search.ps1 -Task <key> -User <test-id>`; confirm `$runDir` was populated, the run read
  the doc, and the edited doc came back — `GET /api/documents/docs/<file>` should show the
  run's own edit. Then confirm the truncation guard by hand-truncating the file before the
  write-back and checking the run refuses and says so.

---

## Explicitly out of scope

- **The production data move.** This ships the schema, the API, the runner and the import
  tool, verified locally. Moving the three real accounts' documents is a separate, deliberate
  step: `d1 export` backup → deploy → `import-documents.ps1` → re-register the scheduled
  tasks from the main checkout (`HANDOFF.md:70-72` — the tasks still point at
  `C:/VibeCoding/job-search-tracker/`, not this repo).
- **Client UI.** No document viewing, editing or upload on the tracker page this round.
- **Prompt-native access.** `prompt.js` is untouched; the run still reads and edits files.
  Teaching the prompt to call `/api/documents` directly is the phase-2 change that lands when
  the runner moves server-side, and the endpoints built here are the ones it will use.
- **Text extraction.** The import script reports resumes with no readable text; producing
  that text stays a human step with the `docx`/`pdf` skills.
- **Cleaning the 190 MB of existing scratch.** Phase 3 stops it accumulating; deleting what's
  already there is a separate call, and `block-remote-d1-writes.mjs:78-86` deliberately
  guards that path.
