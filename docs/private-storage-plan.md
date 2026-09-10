# Move the private folders into storage

> Status: **shipped** (2026-09-09). Documents are in R2, the nightly runs fetch
> and write them back, and the backup covers them. This is now a record of why
> the design is shaped this way rather than a description of intended work.
>
> Added while building it, none of it in the original plan: an 8 MB upload cap
> and a filename rule refusing names Windows silently renames (a trailing space
> or dot) or resolves to a device (`CON`, `PRN.md`) — both because these paths
> are written to a real disk on every run. A guard answering 503 instead of
> crashing when the bucket is not bound. `run-search.ps1` refusing to search at
> all when the document list is empty, since the alternative is screening every
> posting against no profile and reporting success. And an authentication check
> in that runner, which had none — an unauthenticated CLI printed "Not logged
> in", did nothing, and exited 0.
>
> Still on a machine, deliberately: each person's `tracker.json` (you need it to
> reach the API) and their logs. Still to do: teaching `prompt.js` to call
> `/api/documents` directly rather than reading files, which removes the last
> machine-shaped step — see `prompt-size-plan.md`, which overlaps it.

## Context

Resumes and the per-track baseline docs lived on one Windows machine in a gitignored
`private/` folder, copied between machines by hand. Nothing backed them up — `backup-tracker.ps1`
exports D1 nightly and ignored them. The track doc is also the one artifact the nightly run
*writes*, which is what tied that run to a single PC.

This moved those files into R2 and made the run fetch and return them over HTTP.

### What moves

| | Files | Size |
|---|---|---|
| `<user>/docs/*.md` — baseline docs, read *and written* every run | 5 | ~380 KB |
| `<user>/resumes/*` — `.docx`/`.pdf` originals and any `.txt` extracts | 10 | ~640 KB |
| `<user>/reference/*` | 3 | ~30 KB |

Stays on disk: `tracker.json`, `deployment.json`, `logs/`, `backups/`.
Not migrated: `.tmp/`, `tmp/`, `raw/`, run scratch, `scheduled-tasks/`, `worktree-leftovers/`,
`.wrangler/`, `applications/`, `cover-letters/`, `notes/`.

### Design

**One object per file at `<user-id>/<path>`, where `<path>` is the relative path the file
already occupies** — `docs/tracked_<key>_postings.md`, `resumes/<name>_Resume.txt`. The
runner materializes objects into a scratch cwd before launching `claude` and puts changed
docs back after.

**No D1 table and no migration.** `kind` is the first path segment; `bytes`, `etag`,
`uploaded` and `contentType` come from `list({prefix, include:["httpMetadata"]})`; R2 is
strongly consistent for `list` as well as `get`. A table would be a second copy of facts R2
already holds.

Two consequences: **`prompt.js` is untouched** (`doc_file` and `resume_line` keep naming the
paths they name today), and **a resume and its `.txt` are two objects**, as they are two
files today.

**Storage decisions are script rules, never model judgement.** The run decides what to write
*into* a doc; it decides nothing about which files move, what type they carry, or what counts
as a conflict.

---

## Phase 0 — prerequisites

- Enable R2 on the Cloudflare account (dashboard, needs a payment method even for the free
  tier). Only the real bucket and the deploy need this — `wrangler dev --local` simulates R2.
- `wrangler r2 bucket create job-search-tracker-docs`
- Run `scripts/backup-tracker.ps1` before any deploy.

## Phase 1 — storage layer

Everything that touches R2, in one place, plus the backup that has to exist before anything
real is stored there. Nothing in this phase is reachable over HTTP yet — Phase 2 adds the
routes that call it.

**`server/src/r2.js`** (new) — the R2 analogue of `Db`'s scoped-at-construction property
(`db.js:9-19`), so `add-api-route`'s "never check ownership" rule holds here too:

```js
export class Docs {
  constructor(bucket, userId) { this.bucket = bucket; this.userId = userId; }
  #key(path) { return `${this.userId}/${path}`; }   // every key, no exceptions
  async list()                                 // -> [{path, kind, contentType, bytes, etag, uploaded}]
  async get(path)
  async put(path, body, contentType, ifMatch)  // onlyIf:{etagMatches} when ifMatch given
  async delete(path)
}
```

`list()` strips the user-id prefix and derives `kind` from the first remaining segment. `put`
reports an `onlyIf` miss distinctly so the route can answer 412. No paging (a user has ~5-15
objects; `list` caps at 1000) — say so in a comment.

**`server/src/index.js`** — add `docs: new Docs(env.DOCS, user.id)` beside `db`, and to the
`Ctx` typedef (`index.js:56-64`). `db.js` is untouched.

**`server/wrangler.toml`**:
```toml
[[r2_buckets]]
binding = "DOCS"
bucket_name = "job-search-tracker-docs"
```

**`scripts/backup-tracker.ps1`** — `d1 export` does not cover R2. Walk `GET /api/documents`
and save each object under `private\backups\documents\<date>\<user>\<path>`, inside the same
`archive-backups.ps1` protection. **Do not deploy until this runs.**

## Phase 2 — API routes

The four endpoints the runner and the import script both work through. Everything is scoped
to the caller's session, so a person can only ever name their own documents.

New `server/src/routes/documents.js`; four entries in `SESSION_ROUTES`
(`server/src/routes/index.js`). `PUBLIC_ROUTES` stays at three.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/documents` | `{documents: [{path, kind, content_type, bytes, etag, uploaded}]}` |
| GET | `/api/documents/<path>` | streams the object with its content-type |
| PUT | `/api/documents/<path>` | raw body becomes the object; optional `If-Match` |
| DELETE | `/api/documents/<path>` | removes the object |

- `<path>` is a RegExp entry in the route table capturing `(.+)` — not `[^/]+` like every
  other capture there, since document paths contain a slash.
- Add `PUT, DELETE` to `CORS_HEADERS` (`server/src/http.js:21-26`), which advertises only
  `GET, POST, OPTIONS` today. `matchRoute` needs no change.
- Path validator in `server/src/validate.js`: `^(docs|resumes|reference)/[\w][\w .-]*$` —
  one known folder, one plain filename, no nesting. Derives `kind`; rejects `..`, absolute
  paths and backslashes, which the runner would otherwise write to disk.
- Body is raw, not JSON — no base64, no `readJson`. First non-JSON payload in this API and
  first handler to stream a `Response` rather than call `json()`/`text()`; comment both.
- `If-Match` stale → 412, caller keeps its copy. Absent → unconditional.

## Phase 3 — runner

This is the phase that changes behaviour. Today the nightly run's working directory *is* the
durable user folder: it reads `docs/` and `resumes/` straight off disk, edits the baseline
doc in place, and leaves every scratch file it wrote sitting there permanently. After this,
the working directory is a throwaway populated from the API at the start of each run, and
changed docs travel back over HTTP — so the folder stops being the source of truth and stops
accumulating.

`scripts/run-search.ps1`:

1. `$runDir = <DataDir>\<User>\.run\<Task>`, **wiped at the start of every run**.
2. `GET /api/documents`, then each `GET /api/documents/<path>` → `$runDir\<path>`. Record
   each file's **etag and SHA-256** in a manifest.
3. `Set-Location $runDir` instead of `$workDir` (`run-search.ps1:189`).
4. After the run, re-hash everything under `$runDir\docs\` and `PUT` exactly those whose
   SHA-256 changed, each with `If-Match` from its manifest etag. Hash comparison only — do
   not derive which file to send from `doc_file`.
5. Changes under `resumes\` or `reference\` are **never uploaded** — warn and discard.
6. On 412: save the run's copy to `$workDir\logs\<Task>-doc-conflict-<timestamp>.md` and fail
   loudly. Never retry, never blind-overwrite.
7. Any failed write-back is fatal, like a failed prompt fetch (`run-search.ps1:136-153`).

`$workDir` still resolves (`tracker.json`, `logs\`); only cwd moves. `run-fill.ps1` and
`setup-scheduler.ps1` are unchanged.

## Phase 4 — import script

Phases 1-3 give the tracker somewhere to keep documents and teach the run to use it, but the
bucket starts empty — a run against it would materialize nothing. This is the one-time lift
of the existing files, run by hand against a deployment that already has the API. It is also
what a new machine or a restored backup would use, so it is a tool rather than a throwaway.

`scripts/import-documents.ps1` (new). `-DataDir`, optional `-User`, `-WhatIf`. Defaults like
every other script (`$env:JOB_SEARCH_DATA_DIR`, else `..\private`). Re-runnable, since every
write is a `PUT` at a fixed path.

Per user folder with a `tracker.json`, walk `docs\`, `resumes\`, `reference\` and `PUT` each
file's bytes to `/api/documents/<relative path>`.

- **Content-type from a literal extension table** in the script: `.md`→`text/markdown`,
  `.txt`→`text/plain`, `.pdf`→`application/pdf`, `.docx`→`…wordprocessingml.document`,
  `.xlsx`→`…spreadsheetml.sheet`. An extension not in the table is **refused and named** —
  never sniffed, never defaulted to `application/octet-stream`.
- Read `docs\*.md`, not `tracked_*` — one live doc filename fits no pattern.
- Name any file the Phase 2 validator rejects rather than skipping it silently.

## Phase 5 — docs and skills

The private folder's layout is described in four documents and *written* by two skills. Left
alone, the next setup run recreates the old arrangement on disk and the next person to change
a search convention goes looking for files that are no longer there — so this is part of the
change, not follow-up.

- `private.example/README.md` — `docs/`, `resumes/`, `reference/` become "materialized from
  the tracker"; `tracker.json` and `logs/` stay; add `.run/`. Also document `deployment.json`
  (`{url, admin_token}`), which `scripts/set-password.ps1:53-58` needs and nothing describes.
- `README.md` — local-vs-cloud split (`:14-18`, `:159-170`), architecture alt-text (`:40`),
  backup inventory (`:298-380`), cross-doc drift procedure (`:457-469`).
- `docs/multi-user-plan.md:104-106` — note that "the doc stays a file" is superseded.
- `.claude/skills/change-search-prompt/SKILL.md:12-19` and `:91-108` — third surface is now
  `GET`/`PUT` on `/api/documents`, and is listable without the machine.
- `.claude/skills/job-search-setup/SKILL.md` — step 1 stops creating `docs/`/`resumes/`;
  step 4 `PUT`s the filled template to `/api/documents/docs/<file>`.
- `.claude/skills/add-api-route/SKILL.md` — the `Docs` scoping analogue and the two
  convention exceptions (raw body in, streamed body out).
- `.claude/skills/verify-and-deploy/SKILL.md` — the R2 bucket prerequisite.
- `.claude/hooks/block-remote-d1-writes.mjs` — refuse `wrangler r2 bucket delete` and
  `r2 object delete`; add cases to `block-remote-d1-writes.cases.json`.

## Verification

Pick a free port, don't assume 8787, never deploy from this worktree
(`.claude/skills/verify-and-deploy/SKILL.md`). `wrangler dev --local` simulates R2.

```bash
cd server && npx wrangler dev --local --port 8799
```

```bash
cd server && node verify-local.mjs http://127.0.0.1:8799
```

No migration, so `verify-migration.mjs` is untouched — worth flagging in the commit, since a
storage change that leaves the schema alone is the surprising part.

**New `== documents ==` section in `verify-local.mjs`**, in the spirit of its stated purpose
(two people's data cannot reach each other):
- Ada uploads `docs/x.md`; Bo gets 404 on that path, and his own upload of it is a separate object
- a `.pdf` round-trips byte-identical
- stale `If-Match` → 412, object untouched
- `..`, absolute paths, backslashes, nested paths, unknown top folder → 400
- the index reports the same `bytes`/`etag` a fresh GET does, and the right `kind` per folder
- `DELETE` removes it; a second `DELETE` on the same path is 404, and `OPTIONS` advertises
  `PUT` and `DELETE`

**End-to-end against a test account** (never a live one): `import-documents.ps1 -WhatIf`,
then for real; `run-search.ps1 -Task <key> -User <test-id>`; confirm `$runDir` populated and
the edited doc came back. Then force the conflict: overwrite the doc through the API mid-run
and check the runner 412s, saves its copy to `logs\`, and says so.

## Not in this round

The production data move (backup → deploy → import → re-register the scheduled tasks, which
still point at the old sibling repo), any client UI, and teaching `prompt.js` to call
`/api/documents` directly instead of reading files.
