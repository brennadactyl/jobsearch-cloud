# Private data folder - expected layout

This repo (the "tooling") never contains personal data. What is left in this
folder is each person's **credential** and their **logs** - everything else has
moved into the deployment. Leads, applications, page config and the search
config live in D1; resumes, the per-track baseline docs and reference files live
in R2 and are fetched per run (see `../docs/private-storage-plan.md`). The
folder is still not part of this git repo (see `.gitignore` -> `/private/`).

**Recommended: let Claude fill this folder in.** Point it at
`../.claude/skills/job-search-setup/` with a resume in hand - it provisions the
account, creates the folder, and generates everything below. The rest of this
doc describes the result, for reference or for authoring it by hand instead.

Point the scripts at this folder via `-DataDir`, or set it once as an
environment variable:

```bat
setx JOB_SEARCH_DATA_DIR "C:\path\to\your\private\data"
```

If you don't set one, `scripts\run-search.ps1` and `scripts\setup-scheduler.ps1`
default to a `private\` folder next to this repo (gitignored, safe to keep
there if you'd rather not manage a separate location).

## Required structure

**One folder per person, named by their user id** - the GUID that
`POST /api/users` returned when their account was created. One machine can run
several people's searches this way, and nothing in one person's folder says
anything about anyone else's:

```
private/
  <user-id>/
    tracker.json                  {"url": "...", "token": "..."} - their own API URL and session token
    logs/                         created automatically by run-search.ps1
    .run/<key>/                   created and WIPED by every run - the documents
                                  fetched from the tracker for that search, plus
                                  whatever scratch it writes. Never edit anything
                                  here; the next run deletes it.
  <another-user-id>/
    ...
  backups/                        created by backup-tracker.ps1 - dated .sql
                                  exports plus documents/<date>/ pulled out of R2
  logs/                           created automatically by run-fill.ps1 -
                                  applications.log, the nightly application
                                  fill. One file for the machine, not one per
                                  person, because that run isn't any one
                                  person's: it covers every account above in a
                                  single pass. Sits beside the user folders,
                                  not inside one.
```

**Documents are not kept here any more.** Resumes, the per-track baseline docs
and reference files live in the tracker (R2, via `/api/documents`) and are
fetched into `.run/<key>/` at the start of each search. That is what makes them
backed up, shared between machines, and editable by a run that is not on this
computer. Their paths are unchanged - `docs/tracked_<key>_postings.md`,
`resumes/<name>.docx` - because those are what each track's config already
names; only where they are stored moved.

To put an existing folder's documents in, or to seed a new machine:

```bat
scripts\import-documents.ps1 -WhatIf
scripts\import-documents.ps1
```

A folder that still has `docs/`, `resumes/` or `reference/` in it after that has
been imported already; the copies on disk are stale the moment a run edits the
tracker's version. Delete them once you are satisfied, rather than keeping two
that disagree.

`<key>` is a lowercase-hyphenated slug per track (e.g. `engineering`,
`data-science`) - the same value used as the tracker's `search` field and the
`-Task` argument to `run-search.ps1`. Keys only have to be unique per person:
two people can both have a `SWE`.

### tracker.json

Each person's own credential, which is why it lives beside their data rather
than in a machine-wide environment variable - an environment variable can only
hold one person's token.

```json
{ "url": "https://your-api-worker.your-subdomain.workers.dev", "token": "<their session token>" }
```

Mint the token once with `POST /api/login` and a `"label"` of
`"scheduled-search"` (see `../server/README.md`), so it can be revoked on its
own without disturbing whatever browsers they're signed in on. **Their
password never goes in this file, or anywhere else on disk** - it's only ever
typed into the webpage's sign-in.

A machine set up before multi-user support - no per-user folders, `docs/` and
`resumes/` directly in the data dir, `TRACKER_URL`/`TRACKER_API_TOKEN` in the
environment - still works: both scripts fall back to that layout when they
find no `<user-id>/tracker.json`.

### deployment.json

Optional, and machine-wide rather than per-person: `{"url": "...",
"admin_token": "..."}` at the top of the data dir. `scripts\set-password.ps1`
reads it, and nothing else does.

`admin_token` is the `ADMIN_TOKEN` worker secret, which creates accounts and
resets **anyone's** password. It is not a login and it is a much stronger
credential than the session tokens beside it, so a machine that does not need to
provision people should not have this file at all.

## No prompt files

Earlier versions kept the daily search prompt as `scheduled-tasks/<key>.md`
here, one hand-maintained file per track. Those are gone. The prompt is now
composed by the worker from that track's config in D1 and fetched at run time
(`GET /api/prompt/<key>` - see `../server/src/prompt.js`), which is what lets
one machine run several people's searches without holding several people's
search config, and what keeps the API's own calling convention defined in one
place rather than copied into every prompt file.

To change what a search does - target companies, the role line, the fit
filter, which resume it reads, what time it runs - change that track's config
(`POST /api/config`, or re-run the setup skill). To see exactly what a search
will run:

```
curl -s "$TRACKER_URL/api/prompt/<key>" -H "Authorization: Bearer <their token>"
```

## Moving to a new machine

Much less travels than it used to. Documents are in the tracker, so a new
machine needs only each person's `tracker.json` - clone this repo, make
`private/<user-id>/` for each account, drop their `tracker.json` in, and set
`JOB_SEARCH_DATA_DIR` (or pass `-DataDir`). The first run fetches everything
else.

`tracker.json` is still not distributed via GitHub, and still has to be moved by
hand: a zip transfer, a private cloud-synced folder, an external drive. It holds
a session token, so treat it like a password. Mint a fresh one per machine
(`POST /api/login` with a `"label"` naming where it lives) rather than copying
one around, and a machine you stop using can then be revoked on its own.
