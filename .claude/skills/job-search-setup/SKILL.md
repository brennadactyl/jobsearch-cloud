---
name: job-search-setup
description: Onboards a person into this job-search tracker (or adds a track to an existing one) - provisions their account, reads their resume(s), asks about desired role tracks and locations, uploads their resume and per-track baseline doc, posts their search config and page config to /api/config, and registers their scheduled tasks. Use when someone wants to set up this repo for themselves, add a second person to an existing deployment, or add/change a tracked search.
---

# Job search setup

This repo's tooling (`scripts/`, `server/`, `client/`) is generic. Everything
personal lives in the deployment, keyed by user id: search and page config in
D1 (`../../../server/README.md`, `/api/config`), resumes and each track's
baseline doc in R2 (`/api/documents`). The machine that runs the searches keeps
only each person's credential and logs (`../../../private.example/README.md`).

One deployment holds any number of people. Run this the same way for the first
person, for a second person joining, and for adding a track to someone who
already has some: step 1 finds what exists, and the rest only asks about what's
missing.

**Not for the demo account.** A demo, sample or fake account is
`../../../scripts/seed-demo-user.ps1`: it needs invented data, no private
folder and no scheduled tasks. See the README's "The demo account".

## Before you start

- **The tracker's URL**, and for a new person the deployment's `ADMIN_TOKEN`
  (a worker secret - whoever runs the Cloudflare account has it). Without a
  deployment yet, steps 2-5 still work; the person deploys per
  `../../../README.md` "Setup on any machine" and you re-run step 6 after.
- **Their resume(s)**, any format.
- **Scripting a call yourself? Send a `User-Agent`.** Cloudflare rejects some
  default agents (Python's `urllib` among them) with HTTP 403 and a body of
  `error code: 1010`, before the request reaches the Worker. It looks exactly
  like a rejected token. curl and PowerShell's `Invoke-RestMethod` send one.

## One identifier per track

Pick **one lowercase-hyphenated slug per track** (`engineering`,
`data-science`, `technical-pm`) and use it everywhere: the D1 `tracks.key`, the
`docs/tracked_<key>_postings.md` filename, and `run-search.ps1 -Task`. Keys
only need to be unique per person. An existing track may use one value for the
tracker and another for its files; don't copy that split.

## Steps

### 1. Establish who this is, and what already exists

**The data dir** is `$JOB_SEARCH_DATA_DIR` if set, else `private\` at the repo
root (gitignored). Each person has a folder named by their user id holding
`tracker.json` and `logs\`. Their documents live in the tracker and are fetched
into `<data dir>\<id>\.run\<key>\` for each run.

Keep the data dir's path short. A run writes
`<data dir>\<id>\.run\<key>\docs\tracked_<key>_postings.md`, and past Windows'
260-character path limit that fails as "Could not find a part of the path".

**Existing person:** find their folder (the id is in `tracker.json`, or
`GET /api/me` with their token returns it), then `GET /api/config` with their
token. The tracks it returns are what they have; this run adds what's missing.

**New person:** create the account and their credential in one step, with a
random password that is never printed. Whatever goes on a command line lands in
shell history and in this transcript, and the scheduled searches authenticate
with the token, not the password.

```powershell
$TrackerUrl = "<tracker url>"; $AdminToken = "<ADMIN_TOKEN>"
$Name = "Their Name"; $DataDir = "<data dir>"

$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = [Convert]::ToBase64String($bytes)
$headers = @{ "User-Agent" = "job-search-setup" }
$json = "application/json"
$user = Invoke-RestMethod -Method Post -Uri "$TrackerUrl/api/users" -ContentType $json `
  -Headers ($headers + @{ Authorization = "Bearer $AdminToken" }) `
  -Body (@{ name = $Name; password = $password } | ConvertTo-Json)
if (-not $user.created) {
  throw "An account named '$Name' already existed, and this reset its password. Use that person's existing folder instead."
}
$session = Invoke-RestMethod -Method Post -Uri "$TrackerUrl/api/login" -ContentType $json -Headers $headers `
  -Body (@{ name = $Name; password = $password; label = "scheduled-search" } | ConvertTo-Json)
$folder = Join-Path $DataDir $user.id
New-Item -ItemType Directory -Force -Path $folder | Out-Null
[IO.File]::WriteAllText((Join-Path $folder "tracker.json"), (@{ url = $TrackerUrl; token = $session.token } | ConvertTo-Json -Compress))
$user.id
```

It prints only the new user id. `tracker.json` holds the URL and the
scheduled-search token, never a password.

Then the person sets a real password, typing it at a prompt:

```powershell
scripts\set-password.ps1 -Name "Their Name"
```

It needs `deployment.json` (`{"url": "...", "admin_token": "..."}`) in the data
dir, so run it on the machine that provisions people, with the person at the
keyboard. It warns if the reply says `created: true`: names match regardless
of case but not spelling, and a misspelled name makes a second, empty account.
A password reset leaves the scheduled-search token working.

### 2. Get the resume(s)

Read each resume. Plain text, Markdown and PDF all open with the Read tool, in
a headless run as well as an interactive one. A Word `.docx` is read through
its text: uploading it under `resumes/` makes the server extract
`<same name>.txt` beside it, and the upload's reply says how many words it
read. An older `.doc` is refused. A scan or a photo is pictures of text and
gives a run nothing. With nothing readable, have the installer paste their
experience in chat.

**Upload whatever they gave you**, and point `resume_line` (step 4) at a file a
run can actually read - the `.pdf` itself is fine, and for a `.docx` it is the
extracted `.txt`, never the `.docx`. The server owns that `.txt`: writing to it
directly is refused while its `.docx` is stored, so a new Word resume is a new
upload of the `.docx`. For an `.rtf`, `.pages` or a scan, upload a plain-text
copy too and name that instead: a run pointed at a file it can't read still
completes and reports success, having screened every posting against an empty
profile. Name a text copy
`<Name>_Resume.txt` and keep that name, so a new resume is a content swap
rather than a config edit.

Upload from anywhere:

```bash
curl -s -X PUT "$TRACKER_URL/api/documents/resumes/Their_Name_Resume.pdf" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/pdf" \
  --data-binary @"/path/to/resume.pdf"
```

Or put the files in `<data dir>\<id>\resumes\` (and `docs\`, `reference\`) and
run `scripts\import-documents.ps1 -User <id>`, with `-WhatIf` first to see what
it will send. It picks each content type from the extension and refuses what it
can't name. Delete the local copies afterwards: runs read the tracker's.

Filenames start and end with a letter or digit and are never a Windows device
name (`CON`, `PRN.md`); the API refuses the rest, because each run writes these
paths to a real disk.

From the resume, draft a **candidate profile paragraph** (level, recent roles,
core skills, location) and a **best-fit roles sentence**. Show both and revise
from the installer's feedback before step 4.

### 3. Ask about tracks and location scope

For each track, draft from the resume where you can, then confirm:

- **Label** ("Engineering") and **key** (suggest one; check it doesn't collide
  with a track from step 1).
- **Role search line** - the titles and seniority to search for ("Senior/Staff
  Software Engineer, Backend Engineer, or Distributed Systems roles").
- **Companies:** don't ask for a list. Every search reads the deployment's one
  shared company list from its first night. A company they particularly want
  searched: check it's on the list and add it with
  `../add-target-company/SKILL.md`. A company they never want to see:
  `excluded_companies` (step 6).
- **A fit caveat**, optional, and only for a verifiable mismatch - a skill,
  language, location or level they don't have. The template's "Fit philosophy"
  already weighs a stated requirement against the profile instead of screening
  on it. Keep the caveat at the level of the gap: "no documented
  experimentation ownership" is not "exclude experimentation roles". An
  over-literal caveat silently drops well-fitting roles, most of all on a
  track that pivots from the resume.
- **A second search, or a second tab on the same search?** Two tracks that
  search the same boards with the same resume, differing only in which tab a
  posting lands in (engineers vs. managers of engineers), are one search: set
  the second track's `fed_by` to the first's key and leave its search config
  empty. Each track's `full_description` is the rule for what belongs in its
  tab, so write both as real descriptions. Ask; don't assume.

Once per person:

- **Geographic scope** - the hard filter on what's in scope ("US only", "no
  restriction"). It becomes `geo_scope_line`, a full paragraph with worked
  examples of what's excluded. Leave it empty for no restriction.
- **Priority locations** - places in order of preference, the most wanted
  first, that sort ahead of everywhere else within that scope ("Seattle,
  Bellevue, remote in the US, Portland OR"). Any number works; the page gives
  the first five their own colour and ranks the rest without one. They become
  `priority_locations` (step 6) *and* every track doc's tier table (step 4);
  keep the two in the same order, or runs write location text the page can't
  rank.
- **Display title** for the page ("Jordan's Job Search").
- **Pronouns** - the `pronouns` setting the prompt uses when it writes about
  them. Ask; never infer from a name or resume. Empty keeps the prompt generic.
- **A compensation floor**, if any. It goes in `fit_clause` /
  `fit_disqualifier` and screens on a *stated* range only: "a range topping out
  below $X" disqualifies, "no published range" does not. Most postings outside
  pay-transparency states publish none, so a literal floor quietly discards
  them. Say the floor, and that an unstated range isn't a reason to screen, in
  the doc's Candidate Profile.

### 4. Write the per-track doc, and draft the track's config

The worker composes the daily prompt from the track's config
(`../../../server/src/prompt.js`), so this step produces config for step 6 plus
one document the search reads and edits: the baseline doc.

**The doc.** Fill `templates/tracked-postings.template.md` and `PUT` it:

```bash
curl -s -X PUT "$TRACKER_URL/api/documents/docs/tracked_<key>_postings.md" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/markdown" \
  --data-binary @filled-template.md
```

Check `GET /api/documents` first and ask before overwriting an existing doc. It
holds what runs have learned, and an unconditional `PUT` replaces it without
error.

Every placeholder (the template has no comments, because anything left in it
reaches the live doc):

| Placeholder | What it takes |
|---|---|
| `{{TRACK_TITLE}}` | The doc heading - "Software Engineering". |
| `{{SEARCH_GOAL_SENTENCE}}` | One sentence naming what this search looks for. |
| `{{SIBLING_DOCS_NOTE}}` | A sentence pointing at this person's other track docs and saying not to merge them, or empty for their first track. A `fed_by` tab has no doc of its own. |
| `{{TRACK_KEY}}` | The track key. It appears in the API paths the doc quotes. |
| `{{ROLE_SEARCH_LINE}}` | The same text as the track's `role_search_line`. |
| `{{GEO_SCOPE_PARAGRAPH}}` | The same text as `geo_scope_line`. |
| `{{SCOPE_ADJECTIVE}}` | Fills "any other{{SCOPE_ADJECTIVE}} location" - `" US"` for a US-only search (note the leading space), empty with no scope. |
| `{{CANDIDATE_PROFILE_PARAGRAPH}}` | The profile paragraph from step 2, as agreed. |
| `{{BEST_FIT_SENTENCE}}` | The best-fit sentence from step 2. |
| `{{RESUME_FILENAME}}` | The resume the profile came from. |
| `{{LOCATION_TIER_ROWS}}` | One table row per priority tier, in the same order as `priority_locations`: `\| Top \| Seattle, Bellevue - or remote in scope \| "Seattle area" tag, sorted first \|`. |

**If this search also fills a `fed_by` tab**, the fed tab shares this doc. Add
to it which tabs the search fills, that a posting tracked under either key isn't
new, and the question that separates the tabs ("ask what the company sells").
Never name one tab as where ambiguous postings go: the prompt already breaks a
tie among the tabs a posting fits, and a named fallback is the feeder, which
the posting may not fit at all. `./tracker dedup` merges the tabs' lists by
itself.

**The config.** Most fields are **prose the prompt uses verbatim** - write the
finished sentence the search should read:

- `role_search_line` - as it reads mid-sentence.
- `target_companies` - leave it empty. No search keeps a company list: each
  covers its batch of the shared list (step 1c) and finds new employers in
  step 3b, and the prompt doesn't read this field. The kinds of employer
  someone favours go in the track doc's candidate profile, as guidance for
  discovery. A company they name goes on the shared list
  (`../add-target-company/SKILL.md`), never on the search.
- `search_note` - anything qualifying how the step-1c companies are searched
  ("surface any matching role, not only ones in a particular product area").
- `resume_line` - the whole "read the resume" instruction: the file to read (the
  extracted `.txt` for a Word resume), and how this track frames the resume.
- `documents` - the list of document paths this search reads besides its
  `doc_file`: every file `resume_line` names, and any reference file the track
  uses, e.g. `["resumes/Jane_Resume.txt"]` - for a Word resume that is the
  extracted `.txt`, since a run cannot read the `.docx`. A
  nightly run downloads its `doc_file` and these and nothing else, and a track
  with an empty list is refused its documents, so it never runs. List only this
  track's files - a person's other searches keep their own.
- `fit_clause` / `fit_disqualifier` - a short requirement and its mirror in the
  disqualified list. Both empty with no fit filter beyond the role line.
- `fit_filter_step` - only for a genuine pivot, where one clause won't carry
  the fit: it becomes a screening step of its own. Verifiable mismatches only
  (step 3).
- `intro_note` - a short preamble the prompt opens with, usually a note about
  this person's other tracks. Empty for none.
- `doc_file` / `doc_summary` - the doc you just wrote, and what it holds.
- `doc_update_line`, `report_line`, `leads_note`, `screened_examples` - only
  when the generic versions won't do.
- `schedule_time` - `HH:mm` local; step 7 schedules from it. Put it 30 minutes
  after the latest existing track of anyone on that machine, since they share
  one CLI. Empty for a `fed_by` tab.
- `fed_by` - only for a second tab on a sibling's search (step 3).

Once per person, the settings: `geo_scope_line`, `scope_clause`,
`scope_disqualifier`, `location_guidance`, `footer_note`, `pronouns` - also
verbatim prose. Write `geo_scope_line` and `location_guidance` as paragraphs
with worked examples ("a role only in London or Bangalore is excluded";
`"Remote (U.S.)"` vs `"USA - Remote"`): the examples are what make them filter.

### 5. Confirm with the installer

Show the doc and the config (a summary if long) before step 6 - a wrong role
line or tier is cheaper to fix now than once runs use it.

After step 6, fetch the composed prompt and show that too:

```bash
curl -s "$TRACKER_URL/api/prompt/<key>" -H "Authorization: Bearer $TOKEN"
```

It is the exact text the search runs each morning. Read each step to its end -
qualifying clauses come last - for a `resume_line` naming a missing file, a fit
filter harsher than meant, or a geo scope that says nothing.

### 6. Push config to the tracker API

Use *this person's* token throughout; the token decides whose config it is.

**GET first, then POST the merged list.** `POST /api/config`'s `tracks`
replaces the person's whole track list, so posting only the new track deletes
the others:

```bash
curl -s "$TRACKER_URL/api/config" -H "Authorization: Bearer $TOKEN"
```

Take its `tracks`, add or update this run's tracks (`key`, `label`,
`full_description`, `sort_order` = the next index, plus the step 4 fields), and
POST the whole list back. Settings you leave out keep their stored values:

```bash
curl -s -X POST "$TRACKER_URL/api/config" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tracks":[...the merged list...],"display_title":"...","priority_locations":[...]}'
```

In the same call, as this run sets them:

- `priority_locations` - an ordered list of `{label, anyOf: [substrings],
  allOf?: [substrings]}`, one rule per place, most wanted first. The page tries
  rules in order against the lowercased location, and the first whose `anyOf`
  (any one substring) and `allOf` (every substring) match wins; its position
  is the rank. A `tier` field is accepted and ignored.

  Write the substrings the way postings spell locations, because a run copies
  the posting's own location text. Postings write remote-in-the-US as
  "Remote (U.S.)", "USA - Remote" or "Remote-Friendly, United States", so a rule
  for it is `allOf: ["remote"]` with `anyOf: ["u.s.", "usa", "united states"]`,
  while the literal "remote us" matches almost none of them. **Never use a
  bare substring of three letters or fewer** ("us", "ca", "or", "wa"): "us"
  matches inside "Austin" and "ca" inside "Chicago". A city is `anyOf: [its name]`.
  A city whose name is shared (Portland, Vancouver, Cambridge) puts the name in
  `allOf` and its state or province spellings in `anyOf`:
  `allOf: ["portland"]`, `anyOf: ["oregon", ", or"]`.
- `excluded_companies` - companies this person won't work for: names, or a
  phrase like "any other company X owns". The prompt turns it into one
  never-search sentence.
- The prose settings from step 4.
- `overview_label`, `applications_label`, `all_leads_label` - rename the three
  built-in tabs (Overview, Applications, All leads), only if asked.
- `stale_run_hours` (default 36) - how long a track can go without a run before
  its tab is flagged. Raise it for a search scheduled less than daily.

Each new track gets an empty run record, so its tab reads "No run recorded yet"
until its first run.

**There is no company list to seed.** Every search, for every account, reads the
deployment's one list, and a new track starts on it the first night. Check it's
there:

```bash
curl -s "$TRACKER_URL/api/coverage/<key>?all=1" -H "Authorization: Bearer $TOKEN"
```

`total` is the list's length. Each run covers 24 of them (`COVERAGE_BATCH` in
`server/src/routes/coverage.js`), reaching every company once per cycle before
any twice. Ignore `batch` in this `?all=1` reply: it is the list length, not
the nightly slice. On a brand-new deployment `total` is 0, and that's fine: a
run's step 3b searches outside the list and step 9d records what it finds, so
the list grows from the first night. To put a specific employer on it now, use
`../add-target-company/SKILL.md`.

What a track owes the list is a way to grow it: the doc must tell the run to
register a company it discovers with `./tracker swept`, not just write the name
down. The template already does. A doc that only notes names stops finding
anything new once every open posting at the known companies is tracked or
screened.

### 7. Register the scheduled tasks

A scheduled task stores an absolute path to `run-search.ps1` and runs it for
months, so register from the **main checkout**, never a git worktree - a
worktree is removed when its work is done, and the task then silently runs
nothing. Agents usually run in a worktree, so check:

```powershell
git rev-parse --git-common-dir   # ".git" = main checkout; a path = worktree
```

Run the main checkout's copy by absolute path. If your branch changed
`setup-scheduler.ps1`, diff the two first - the main checkout's copy is the
one that runs:

```powershell
& "C:\path\to\main\checkout\scripts\setup-scheduler.ps1" -DataDir "<data dir>" -User <user id>
```

It finds each person by `<data dir>\<id>\tracker.json` and reads their tracks
from their account. `-User` limits it to one person; without it, it sets up
everyone on the machine (cleanup only touches the people it processed). It
schedules from each track's `schedule_time` (a time change is a config post,
not a re-registration), warns about a missing prerequisite (the `claude` CLI,
`CLAUDE_CODE_OAUTH_TOKEN`) instead of failing, and registers the machine's one
`JobSearch-Applications` task, the nightly application fill
(`../../../server/README.md`, "Applications added as nothing but a URL").

Verify the registered paths rather than trusting the summary:

```powershell
Get-ScheduledTask -TaskName "JobSearch-*" | ForEach-Object {
  [PSCustomObject]@{ Name = $_.TaskName
                     Path = ($_.Actions[0].Arguments -split '-File ')[1] } } |
  Format-Table -AutoSize
```

### Intake mode: the same setup, unattended

`scripts/run-onboarding.ps1` runs this skill for someone who filled in the
setup form instead of talking to an installer (`docs/onboarding.md`). The
turn is confined to one staged folder and has no tracker access, so the steps
above still describe *what to write* - the difference is where the answers come
from and where the output goes.

| Step above | In intake mode |
|---|---|
| 1, provisioning | Already done. The account, folder, credential and documents exist. |
| 2, the resume | `resumes\` in the folder holds their resume - text, Markdown or PDF, all of which you can read. A Word resume is staged as the `.txt` the server extracted from it, and a pasted one is already uploaded as `.txt`. Draft the profile paragraph from it as usual. |
| 3, asking | `answers.json` is the interview, already answered. Nothing is confirmed with anyone: decide from what they wrote. Where an answer is thin, write the search anyway - a thin search they can see and correct beats no search. |
| 4, doc and config | Same fields, same template. They go in `out\` as files, not to the API. |
| 5, confirming | Nobody to confirm with. Prefer the reading that surfaces more jobs: an over-tight fit filter hides work they asked for and nobody is watching. |
| 6, posting | The script posts it, with their token, after checking it. |
| 7, scheduling | The script does it. |

The answers map onto the config like this:

| Answer | Becomes |
|---|---|
| `page_title`, `pronouns`, `priority_locations` | `display_title`, `settings.pronouns`, `priority_locations` - already written when the form was sent, not by you |
| `work_scope` ("Where can you work?") | `geo_scope_line` (a paragraph with worked examples) and `scope_clause` - the only answer that sets where a search may look |
| `location_limits` ("Anywhere you can't take a job?") | `scope_disqualifier` only. An exclusion never becomes the scope: a search scoped to the one place someone ruled out screens out everything it finds and reports a quiet night |
| the two together | checked by the script before anything is posted: the scope prose must name a place from `work_scope`, `scope_disqualifier` must name a place from `location_limits`, and `scope_clause` must not name a place that appears only in `location_limits`. Any miss fails the setup. A send whose ranked places all lie outside `work_scope` was already refused by the server |
| each role's `name` | the track `label`, and a slug `key` |
| each role's `titles` | `role_search_line` and `full_description` |
| each role's `company_kinds` | the track doc's candidate profile, as guidance for discovery - and any company they named by name in `named_companies`, which the script puts on the shared list |
| each role's `rule_outs` | `fit_clause` / `fit_disqualifier`, and `fit_filter_step` only for a real pivot |
| each role's `min_pay` | part of the fit filter: a *stated* range topping out below it disqualifies; no published range does not |
| `never_work_for` | `excluded_companies` - already written when the form was sent, not by you |
| `preferences` | the track doc's candidate profile, weighed - never turned into a rule-out |

Write `out\config.json` in the shape the run's prompt gives, and one
`out\docs\tracked_<key>_postings.md` per role. Leave `schedule_time`,
`target_companies`, `fed_by`, `doc_file` and `sort_order` out: the script owns
them, and it drops them if you send them. A track whose doc still holds a
`{{PLACEHOLDER}}`, whose key isn't a lowercase-hyphenated slug, or whose
`resume_line` doesn't name the staged resume is refused, and the person is told
their setup didn't finish - so check those three before your turn ends.

### 8. Offer a test run

Suggest running one new track now rather than waiting for its slot:

```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = [Environment]::GetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN','User')
scripts\run-search.ps1 -Task <key> -User <user id>
```

**Keep the first line.** `setup-scheduler.ps1` checks the token at User scope,
but `run-search.ps1` reads the process environment. A shell opened before
`setx` - an agent session open a while, say - has the first and not the second,
so the run fails on `Not logged in`. Scheduled runs start a fresh process and
don't need it.

**Read the exit code, then the log.** `run-search.ps1` exits 1 when the CLI
couldn't authenticate, when the job failed, or when the run wrote no run record
- the case of a run that stopped before finishing. It records that failure on
the tracker too, so the tab shows an error rather than a stale stamp. Exit 0
means the run recorded itself - unless the log warns it couldn't reach the
tracker to check, in which case the exit code says nothing. Either way,
`<data dir>\<id>\logs\<key>.log` says what happened; its `ERROR:` and
`WARNING:` lines name the cause.

Then open the page: the new tab should show when it last ran. A search with a
`fed_by` tab records a run against **both** keys, so both tabs update.

On a brand-new install, this is also when the page stops being empty: it had no
tabs until step 6.
