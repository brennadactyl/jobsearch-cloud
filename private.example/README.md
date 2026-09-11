# Private data folder - expected layout

This folder holds each person's **credential** (`tracker.json`) and their
**logs**, and is not part of this git repo (see `.gitignore` -> `/private/`).
Leads, applications, page config and search config live in D1. Resumes,
baseline docs and reference files live in R2 behind `/api/documents` (see
[`../server/README.md`](../server/README.md#documents)) and are fetched into
each run.

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
default to a `private\` folder next to this repo (gitignored).

## Required structure

**One folder per person, named by their user id** - the GUID that
`POST /api/users` returned when their account was created:

```
private/
  <user-id>/
    tracker.json                  {"url": "...", "token": "..."} - their own API URL and session token
    logs/                         created by run-search.ps1 - one <key>.log per track
    .run/<key>/                   created and WIPED by every run - the documents
                                  fetched from the tracker for that search, plus
                                  whatever scratch it writes. Never edit anything
                                  here; the next run deletes it.
  <another-user-id>/
    ...
  backups/                        created by backup-tracker.ps1 - dated .sql
                                  exports plus documents/<date>/ pulled out of R2
  logs/                           machine-wide: applications.log from run-fill.ps1
                                  (the nightly application fill, every account in
                                  one run - see ../server/README.md) and
                                  backup.log from backup-tracker.ps1
```

**Documents live in the tracker, not here.** Resumes, baseline docs and
reference files are fetched into `.run/<key>/` at the start of each search, at
the paths each track's config names - `docs/tracked_<key>_postings.md`,
`resumes/<name>.docx`.

To upload a folder of existing documents:

```bat
scripts\import-documents.ps1 -WhatIf
scripts\import-documents.ps1
```

Once imported, delete the local `docs/`, `resumes/` and `reference/` copies:
runs edit the tracker's version, so the ones on disk go stale.

`<key>` is a lowercase-hyphenated slug per track (e.g. `engineering`,
`data-science`) - the same value used as the tracker's `search` field and the
`-Task` argument to `run-search.ps1`. Keys only have to be unique per person:
two people can both have a `SWE`.

### tracker.json

Each person's own credential, kept in their folder because one machine can run
several people's searches.

```json
{ "url": "https://your-api-worker.your-subdomain.workers.dev", "token": "<their session token>" }
```

Mint the token as described in
[`../server/README.md`](../server/README.md#accounts). **Their password never
goes in this file, or anywhere else on disk.**

A data dir with no `<user-id>/tracker.json` runs as a single user: the scripts
read `TRACKER_URL`/`TRACKER_API_TOKEN` from the environment and use the data dir
itself as that user's folder.

### deployment.json

Optional, and machine-wide rather than per-person: `{"url": "...",
"admin_token": "..."}` at the top of the data dir. Only `scripts\set-password.ps1`
reads it.

`admin_token` is the `ADMIN_TOKEN` worker secret, which creates accounts and
resets **anyone's** password. Leave this file off any machine that does not
provision people.

## Prompts are not stored here

The worker composes each track's daily search prompt from that track's config
in D1, fetched at run time (`GET /api/prompt/<key>` - see
`../server/src/prompt.js`).

To change what a search does - target companies, the role line, the fit
filter, which resume it reads, what time it runs - change that track's config
(`POST /api/config`, or re-run the setup skill). To see exactly what a search
will run:

```
curl -s "$TRACKER_URL/api/prompt/<key>" -H "Authorization: Bearer <their token>"
```

## Moving to a new machine

A new machine needs only each person's `tracker.json`: clone this repo, make
`private/<user-id>/` for each account, drop their `tracker.json` in, set
`JOB_SEARCH_DATA_DIR` (or pass `-DataDir`), and run
`scripts\setup-scheduler.ps1`. The first run fetches everything else.

Move `tracker.json` by hand, never through GitHub: it holds a session token, so
treat it like a password. Better, mint a fresh token per machine
(`POST /api/login` with a `"label"` naming where it lives), so a machine you
stop using can be revoked on its own.
