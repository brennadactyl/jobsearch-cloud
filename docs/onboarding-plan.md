# Invite signup and first-run setup

A new person joins from an invite link. They create their own account, describe
the search they want and attach their resume on the tracker page. That night an
unattended run builds their search, and in the morning they have a tracker.

Adding someone takes one operator step: sending the link.

Screens: [Tracker Onboarding Screens](https://claude.ai/artifact/Jsm3mxExvm7jLiXMhrZCz4)
(mockup, version 7). Artboard numbers below refer to it.

This touches `server/` (two migrations, new routes), `client/` (two screens),
`scripts/` (the nightly onboarding run and the invite script) and the
`job-search-setup` skill.

## Context

Today the operator does all of this for the person. They create the account
with `ADMIN_TOKEN` and choose its password. They collect the resume, run the
setup skill in their own session and register the scheduled tasks.

A first version was built on `claude/improved-user-onboarding-b07a78` against
the ES5 page. That page is gone, and main has since moved documents to R2 and
dropped seed company lists. This plan rebuilds the feature on main. It reuses
that branch's route and runner design where it still fits.

## What the person sees

**Sign up (1–1f).** An invite link opens the sign-in card in signup mode: name,
password and confirm password, each password with Show. A line under the
password says whoever invited them can reset it. Each error sits under its
field:
- too short
- passwords don't match
- name already taken

A used or expired invite falls back to normal sign-in with the reason. The
invite code leaves the address bar once it has been spent.

**Setup (2–2g).** An account with no tracks, and no finished setup, sees the
setup form instead of an empty tracker:

| Field | Shape |
|---|---|
| Page title | text, prefilled "<name>'s Job Search" |
| Pronouns (optional) | she/her · he/him · they/them; unset means they/them |
| Resume | attach files, paste text, or both |
| Anywhere you can't take a job? | free text |
| Which locations should come first? | comma-separated, in order of preference, read back as the ranked location key |
| Per role: Call it | text |
| Per role: What roles? | titles and seniority only |
| Per role: Kinds of companies you'd like (optional) | free text; named companies are welcome |
| Per role: Anything that rules a job out (optional) | free text |
| Per role: Lowest acceptable pay (optional) | text |
| Companies you'd never work for | free text |
| Preferences the search should weigh | free text |

Roles are blocks. The first has no Remove, and each role is its own nightly
search.

- **Attachments.** Stored under a filesystem-safe version of their name: any
  character the documents route refuses becomes `-`. Size (8 MB) is the only
  refusal (2d).
- **Unreadable resumes.** Only `.txt` and `.md` are readable by a headless run.
  When every attachment is another format (`.pdf`, `.doc`, `.docx`, `.rtf`,
  `.pages`, images) and nothing is pasted, the form refuses to send. Beside
  Attach it says "We can't read PDF or Word files overnight. Paste the text
  too." (2b)
- **Sending.** The first send is "Start my search", later ones "Send changes".
  Sending and a failed send show in the header save indicator (2e, 2f).

**Waiting (3–3c).** After sending, the form stays editable, and the last
version sent is the one used. A banner says:
- **Before the run:** it's building tonight (3).
- **Past the account's `stale_run_hours` since sending, with no result:** it
  may be waiting for the machine that runs searches (3b).
- **When the run fails:** the run's own note (3c).

There is no link to the tracker until the run has built it.

Every screen works at phone width and in both themes.

## Server

Two tables, and routes grouped by who calls them. Resume files use the existing
`/api/documents/<path>` route under `resumes/`. Setup stores only answers.

**Migrations**, numbered after the latest on main when written (0014 today).
- `0015_invites.sql`: `invites` with `code_hash`, `note`, `created_at`,
  `expires_at` (14 days, at most 30), `used_at` and `user_id`. Only the hash
  of a code is stored.
- `0016_intake.sql`: `intake`, one row per user, with `answers` (JSON),
  `status` (`pending` | `done` | `failed`), `status_note`, `sent_at` and
  `updated_at`.

**Public**

| Route | Does |
|---|---|
| `GET /api/invite/<code>` | `{ valid }`, or `{ valid: false, reason }` for not valid, already used, or expired |
| `POST /api/signup` | `{ code, name, password }` → `201 { token, user }`. Creates only, never updates an existing user. Claims the invite conditionally, so one link makes one account. A taken name puts the invite back and answers with the server's wording |

**Session token**

| Route | Does |
|---|---|
| `GET /api/intake` | the person's intake or `null`, including `sent_at` |
| `POST /api/intake` | stores answers. Requires at least one role with a name and titles, and resume text or a file under `resumes/`. Replaces while `pending` or `failed`; refused once `done` |

**`ADMIN_TOKEN`**

| Route | Does |
|---|---|
| `POST /api/invites` | mints a code, shown once |
| `GET /api/invites` | the ledger: note, created, expires, used by |
| `GET /api/intake/pending` | every `pending` or `failed` intake with its user |
| `POST /api/tokens` | mints a long-lived search token for a user |
| `POST /api/intake/complete` | `{ user, status, note }` sets `done` or `failed` |

`verify-local.mjs` gains checks for:
- signup can't take or reset an existing account
- a spent invite fails
- two signups racing one invite make one account
- one person's intake is invisible to another
- the admin routes refuse a session token

## Client

The React page adds invite handling to the gate and a Setup screen. Everything
is drawn from the mockup's states, with the tracker's existing tokens and
components.

- **API layer.**
  - `client.ts` gains `checkInvite`, `signup`, `getIntake`, `submitIntake`
    and `putDocument`.
  - `request()` learns to send a raw `Blob` body, so documents still go
    through the one path to the server.
  - `schema.ts` gains the intake schema.
- **Gate.**
  - `?invite=` is checked before any stored session and switches the gate to
    signup mode.
  - A spent or bad code is removed from the URL.
- **Routing.**
  - After `/api/data`, zero tracks plus an intake that isn't `done` shows
    Setup.
  - If `/api/intake` fails, the tracker shows instead.
- **Setup screen.**
  - Validation messages sit beside their fields, and the format check runs
    before send.
  - Filenames are made safe before upload.
  - The send order is files, then answers, then a re-read of the intake,
    since the answers check needs a resume already under `resumes/`.
  - Send status goes through `saved`.
  - The stale banner compares `sent_at` with `stale_run_hours`.
- **Constants.** New labels go in `LABELS`. The readable-format list is one
  constant, shared by the check and its message.
- **Tests.**
  - signup modes and their errors
  - invite removed from the URL
  - the unreadable-resume refusal
  - filename sanitising
  - role add and remove
  - each banner
  - the zero-tracks routing

## The onboarding run

`scripts/run-onboarding.ps1` runs nightly on the search machine with
`ADMIN_TOKEN` from `<DataDir>\deployment.json`. PowerShell does the mechanical
work. A Claude run following the `job-search-setup` skill does the part that
needs judgement.

**Mechanical, per pending intake**
1. Mint the person's search token and create their folder and `tracker.json`.
2. Download their `resumes/` documents. Save pasted resume text as
   `resumes/<Name>_Resume.txt`, the skill's name for the readable copy, locally and
   through the documents route.
3. Pick a `schedule_time` that doesn't overlap another run on the machine.
4. After the model step: register their scheduled tasks and mark the intake
   `done`. A run that ends with the intake still pending marks it `failed`,
   with a note written for the person.

**Model, per the skill.** The answers become `/api/config` and track docs:

| Answer | Becomes |
|---|---|
| Page title | `display_title` |
| Pronouns | `settings.pronouns` |
| Resume | the readable file in `resumes/`, named in each track's `resume_line` |
| Anywhere you can't take a job? | `geo_scope_line` (a full numbered step with examples), `scope_clause`, `scope_disqualifier` |
| Locations first | `priority_locations`: one rule per entry, in order, each with the spellings postings use (e.g. Remote → `remote` plus US variants) |
| Call it | track `label`, and a slug `key` unique in the account |
| What roles? | `role_search_line` (a noun phrase of titles) and `full_description` |
| Kinds of companies | `target_companies`, as strategy prose |
| Named companies | added to the shared company list once the tracks exist, with `/api/coverage` under one of the new track keys and `on: ""` |
| Rules a job out | `fit_clause`, `fit_disqualifier`, `fit_filter_step` |
| Lowest acceptable pay | added to the fit filter step: a stated lower pay screens a posting out; no stated pay keeps it |
| Companies never to work for | `excluded_companies` |
| Preferences | the track doc's candidate profile, weighed and never turned into rule-outs |

Defaults cover everything else: `doc_file`, `doc_summary`,
`doc_update_line`, `report_line`, `screened_examples`, notes,
`location_guidance`, `stale_run_hours` and tab labels.

**Skill.** `job-search-setup` gains an intake mode that works from stored
answers. Its `priority_locations` wording drops the two-tier `p-high`/`p-med`
form, since the index is the rank.

## Operator

- `scripts/new-invite.ps1` mints and prints a link, with a note for the ledger.
  `-List` shows what became of each invite.
- `deployment.json` in the data folder holds the API URL and `ADMIN_TOKEN`.
- `setup-scheduler.ps1` registers the onboarding task alongside the others.

## Order of work

1. **Server:** migrations, routes, `verify-local.mjs`. Deploy first.
2. **In parallel once the routes exist:**
   - the client screens (start against a mock before then)
   - the onboarding run and skill intake mode
   - the invite script and scheduler change
3. **End to end:** a test invite on the search machine, through signup, setup,
   the night's run, and a morning tracker, plus one failed run.
4. **Docs:**
   - `server/README.md` routes
   - `docs/schema.md`
   - `client/README.md`
   - the root README's "Adding another person"

## Not in this change

Self-service password reset, signup without an invite, editing a finished setup
through the form, and a role block that feeds two tabs (`fed_by`).
