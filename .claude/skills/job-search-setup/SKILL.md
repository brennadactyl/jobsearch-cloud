---
name: job-search-setup
description: Onboards a person into this job-search tracker (or adds a track to an existing one) - provisions their account, reads their resume(s), asks about desired role tracks/target companies/locations, uploads their resume and per-track baseline doc, posts their search config and page config to /api/config, and registers their scheduled tasks. Use when someone wants to set up this repo for themselves, add a second person to an existing deployment, or add/change a tracked search.
---

# Job search setup

This repo's tooling (`scripts/`, `server/`, `client/`) is generic - it has no
opinion on whose job search this is, how many tracks they want, or what
locations matter to them. The personal part lives in the deployment, keyed by
user id: search and page config in D1 (see `../../../server/README.md`'s
`/api/config` section), resumes and each track's baseline doc in R2 (see
`/api/documents`). What is left on disk is that person's credential and their
logs (see `../../../private.example/README.md`). This skill fills those in
conversationally, instead of hand-authoring JSON.

One deployment holds any number of people. Run this the same way for the
first person, for a second person joining an existing deployment, and for
adding one more track to someone who already has some - check what's already
there (step 1) and only ask about what's missing.

**Not for the demo account.** A request for a demo, sample or fake account is
`../../../scripts/seed-demo-user.ps1`, not this skill: that account needs
invented data, no private folder and no scheduled tasks - the opposite of
steps 2, 4 and 7. See [the README](../../../README.md)'s "The demo account"
section.

## One identifier per track

Pick **one lowercase-hyphenated slug per track** (e.g. `engineering`,
`data-science`, `technical-pm`) and use it as *all three* of: the
`docs/tracked_<key>_postings.md` filename, the D1 `tracks.key` / `search`
value sent to `/api/leads`, and the `-Task` value passed to
`run-search.ps1`. Track keys only have to be unique per person - two people
can both have a `SWE`, and their leads, tabs and run history stay separate.

## Steps

### 1. Establish who this is, and see what already exists

One deployment can hold several people's job searches, each keyed by a GUID
user id. So the first question is *whose* search this is.

- Data dir is `$JOB_SEARCH_DATA_DIR` if set, else `private/` next to this
  repo. Inside it, each person has their own folder named by their user id,
  holding `tracker.json` and `logs/`. Their documents (resumes, each track's
  baseline doc, reference files) live in R2, uploaded with
  `PUT /api/documents/<path>` (steps 2 and 4); each run fetches them into a
  throwaway `.run/<key>/`.
- **Existing person?** Ask for their name and find their folder (their id is
  in `tracker.json`, or `GET /api/me` with their token returns it). Read
  `GET /api/config` with their token - the tracks it returns are what they
  already have, so this is an "add a track" run for whatever's missing.
- **New person?** They need an account before anything else can be stored
  against them. The API behind these calls is documented in
  [`server/README.md`](../../../server/README.md)'s "Accounts" section. It takes
  the deployment's `ADMIN_TOKEN` (a worker secret - whoever runs the Cloudflare
  account has it):

  ```
  curl -s -X POST "$TRACKER_URL/api/users" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"Their Name","password":"<a long random password - see below>"}'
  ```

  It returns their `id`. Create `<data dir>/<id>/` (just the folder), then
  mint the long-lived token their scheduled searches will use:

  ```
  curl -s -X POST "$TRACKER_URL/api/login" -H "Content-Type: application/json" \
    -d '{"name":"Their Name","password":"<the same password>","label":"scheduled-search"}'
  ```

  Write `{"url": "<tracker url>", "token": "<the token it returned>"}` to
  `<data dir>/<id>/tracker.json`. Never put a password in that file, or
  anywhere else on disk.

  **Don't ask for, invent, or type their real password here.** Those two
  commands need *a* password, not *their* password, and whatever goes on a
  command line lands in shell history and the transcript. Generate a long
  random one (12 characters minimum) **in the same process that sends both
  requests**, never printing it - a short script that POSTs `/api/users`, then
  `/api/login`, then writes `tracker.json`, and emits only the user id. Nobody
  knowing that password is fine: the scheduled searches authenticate with the
  token.

  **Send a `User-Agent` from any script that calls the API**, here or in later
  steps. Cloudflare's browser-integrity check rejects some default agents -
  Python's `urllib` among them - with **HTTP 403 and a body of
  `error code: 1010`** before the request reaches the Worker; read the body
  before concluding `ADMIN_TOKEN` is wrong. curl sets one already.

  Then have **them** set a real password, at a prompt, in their own terminal:

  ```powershell
  scripts\set-password.ps1 -Name "Their Name"
  ```

  If it warns `created = True`, the name didn't match and a second, empty
  account now exists (case doesn't matter, spelling does). A password reset
  leaves sessions alone, so the scheduled-search token keeps working and step
  7 does not need redoing.
- If you don't have `TRACKER_URL`, or the deployment doesn't exist yet, keep
  going (steps 2-5 don't need it) but tell the installer they'll need
  `../../../server/README.md`'s setup done and step 6 re-run before the
  searches can sync anywhere.

### 2. Get the resume(s)

- Ask the installer for their resume file(s) - any format (`.docx`, `.pdf`,
  `.txt`), anywhere on disk; they get uploaded, not left in place.
- Read it. Plain text/Markdown: read directly. PDF: try the Read tool, but
  it needs `pdftoppm` (poppler-utils) and fails outright without it;
  `py -m pip install pypdf` then `pypdf.PdfReader(path).extract_text()` is
  the fallback. `.docx`: use the `docx` skill to extract text, or ask the
  installer for a plain-text copy. If nothing readable is present, ask the
  installer to paste their key experience/skills directly in chat instead of
  blocking on a file.
- **Upload both the original and a plain-text copy**, and point `resume_line`
  (step 4) at the `.txt`. The nightly run is headless and may read nothing
  from a `.pdf` or `.docx` - and it still completes, posts leads and reports
  success, having screened every posting against an empty profile. Keep the
  `.txt` filename stable (`<Name>_Resume.txt`) so a later resume version is a
  content swap rather than a config edit.

  ```bash
  curl -s -X PUT "$TRACKER_URL/api/documents/resumes/Their_Name_Resume.pdf" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/pdf" \
    --data-binary @"/path/to/resume.pdf"
  ```

  Or hand the whole job to `scripts/import-documents.ps1`, which walks a
  folder, picks the content type per extension and refuses anything it cannot
  name. Filenames must start and end with a letter or digit and must not be a
  Windows device name - each run writes them to a real disk, so the API
  refuses the rest.
- From it, draft a **candidate profile paragraph** (experience level, most
  recent roles in brief, core skills, location) and a **best-fit roles
  sentence**. Show both to the installer and revise from their feedback
  before using them in step 4 - don't guess silently on anything that
  reads as a stretch.

### 3. Ask about tracks and location scope

For each desired track, get from the installer (infer a first draft from
the resume where reasonable, then confirm):
- **Label** (e.g. "Engineering") and the **key** slug (suggest one from the
  label; confirm it doesn't collide with an existing track from step 1).
- **Role search line**: the actual titles/seniority to search for (e.g.
  "Senior/Staff Software Engineer, Backend Engineer, or Distributed Systems
  roles").
- **Target companies**: a starter list is fine. It seeds the shared company
  list in step 6, and discovery adds to that list with `./tracker swept` as
  runs find companies.
- Any **track-specific fit caveat** worth calling out (e.g. a PM track that
  should exclude non-technical PM roles) - optional. Scope it to an actual,
  verifiable mismatch (a skill, language, location, or level the installer
  genuinely doesn't have), not a list of qualifications or role categories to
  require verbatim - the template already weighs a stated requirement against
  the candidate profile rather than auto-disqualifying on it (its "Fit
  philosophy" section). Watch for the same mistake at the category level:
  "the resume doesn't document experimentation ownership" is not the claim
  "exclude experimentation-flavored roles." Be most careful on a track that's
  a real stretch from the resume (a title/domain pivot), where an over-literal
  caveat screens out well-fitting roles before the installer sees them.

- **Is this a second search, or a second tab on the same search?** Two tracks
  usually mean two different searches, each with its own daily run. But a
  split by level or kind of role ("EM of engineers" vs "EM of managers /
  Director") often searches the *same* boards with the *same* resume and
  differs only in which tab a posting lands in - one search, two tabs. For
  that, set the second track's `fed_by` to the first's key and leave the rest
  of its search config empty; each track's `full_description` doubles as the
  rule for what belongs in that tab, so write both as a real description of
  the roles. Ask which way it is rather than assuming.

Once per setup (applies to every track, new and existing):
- **Geographic scope** - the hard filter on what's in-scope at all (e.g. "US
  only", "UK and EU", "no restriction"). This becomes the `geo_scope_line`
  setting, written as a full paragraph with worked examples of what's
  excluded. If "no restriction", leave it empty rather than writing a filter
  that excludes nothing.
- **Priority locations** - one or two tiers of locations that should sort to
  the top within that scope (e.g. "Seattle metro, or remote in the US" as
  top tier, "Portland" as medium). This becomes both the `priority_locations`
  config pushed in step 6 *and* the location-tier table in every track's doc
  (step 4). Keep them in sync: the page sorts by the configured tiers, and a
  doc that disagrees has the run writing location text that sorts wrong.
- **Display title** for the tracker page (e.g. "Jordan's Job Search").
- **Pronouns** - the `pronouns` setting, which the composed prompt uses when
  it writes about them ("his board", "they would rather see it"). Ask; don't
  infer it from their name or their resume. Empty keeps the prompt generic,
  which is a fine answer if it's theirs rather than your guess.
- **Any hard compensation floor**, if they have one. There is no salary field:
  it goes in `fit_clause` / `fit_disqualifier` (step 4). Screen on a *stated*
  range only - "a range topping out below $X" disqualifies, "no published
  range" does not. A literal floor silently discards most postings from states
  without pay-transparency laws, which is most of a remote search. Say in the
  doc's Candidate Profile what the floor is and that an unstated range is not
  a reason to screen.

### 4. Write the per-track doc, and draft the track's config

The daily prompt is composed by the worker from the track's config in D1 (see
`../../../server/src/prompt.js`), so this step produces *config*, posted in
step 6 - plus one document:

- Fill `templates/tracked-postings.template.md` and `PUT` it to the tracker at
  `docs/tracked_<key>_postings.md`:

  ```bash
  curl -s -X PUT "$TRACKER_URL/api/documents/docs/tracked_<key>_postings.md" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/markdown" \
    --data-binary @filled-template.md
  ```

  It is a document rather than config because the search itself edits it,
  accumulating fetch-reliability notes run over run. **Check whether it exists
  first** (`GET /api/documents`) and ask before overwriting: an unconditional
  `PUT` over an established doc destroys its accumulated findings with no
  error.

  Every `{{PLACEHOLDER}}` in it, and what goes there (the template carries no
  comments of its own - anything left in it would be copied into the live doc
  the search reads every morning):

  | Placeholder | What it takes |
  |---|---|
  | `{{TRACK_TITLE}}` | The track's title for the doc heading - "Software Engineering", "Engineering Management". |
  | `{{SEARCH_GOAL_SENTENCE}}` | One sentence naming what this search looks for, quoted in the intro line. |
  | `{{SIBLING_DOCS_NOTE}}` | A sentence pointing at this person's other track docs, or empty for their first. Say "do not merge them" - a run that reads a sibling doc as its own searches the wrong thing. For a `fed_by` tab, see the note below instead: that tab shares this doc rather than getting one. |
  | `{{TRACK_KEY}}` | The track key slug. It appears in the API paths the doc quotes, so a wrong one sends every run at another tab's data. |
  | `{{ROLE_SEARCH_LINE}}` | Same text as the track's `role_search_line` config, so the doc and the prompt agree. |
  | `{{GEO_SCOPE_PARAGRAPH}}` | Same text as the `geo_scope_line` setting, worked examples and all. |
  | `{{SCOPE_ADJECTIVE}}` | Fills "any other{{SCOPE_ADJECTIVE}} location" in the tier table - " US" for a US-only search, empty when there's no geographic scope. Note the leading space. |
  | `{{CANDIDATE_PROFILE_PARAGRAPH}}` | The profile paragraph from step 2, as agreed with the installer. |
  | `{{BEST_FIT_SENTENCE}}` | The best-fit-roles sentence from step 2. |
  | `{{RESUME_FILENAME}}` | The resume the profile came from, named in the section heading. |
  | `{{TARGET_COMPANIES_CORE}}` | The starter company list, comma-separated. The same list seeds the shared company list in step 6. |

- `{{LOCATION_TIER_ROWS}}`: one Markdown table row per priority tier, e.g.
  `| Top | Seattle, Bellevue, ... - or remote within scope | teal stripe +
  "Seattle area" / "Remote US" tag, sorted to the top of its tab |`. Keep
  these in step with the `priority_locations` you'll post in step 6. The
  client ranks by a rule's *position* in that list and ignores its `tier`
  string, so the order you post them in is the order they rank in.

**If this search fills a `fed_by` tab, say so in the doc.** The fed tab shares
the feeder's doc, and the template is written as though the track were its
only tab. Add to the doc's step 1 the tabs this search fills, by key, and that
a posting tracked under *either* key is not new, whichever tab today's run
would file it under.

**Write the distinction between the tabs, never a fallback tab.** The composed
prompt already breaks a genuine tie among the tabs a posting reads as; a doc
line naming one tab for ambiguous postings sends them to a tab they were never
a candidate for. If the split needs a finer rule than each tab's
`full_description`, write the question that separates the tabs ("ask what the
company sells").

Then draft the track's config fields for step 6. Most are **prose the prompt
uses verbatim** - write each as the finished sentence the search should read
(why: `../../../server/README.md`, "Config fields are mostly prose, on
purpose"):

- `role_search_line` - the titles/seniority to search for, as it will appear
  mid-sentence ("Senior/Staff Software Engineer, Backend Engineer, or
  Distributed Systems roles").
- `target_companies` - a JSON array of names, joined with commas into the
  prompt. Pass a plain string instead when the list has structure worth
  keeping ("gaming first (...), then creator platforms (...), then the
  expanded net in the doc") - it's used as written.
- `search_note` - anything qualifying that company list. This is where "none
  of these are industry-only searches, surface any matching role at them"
  goes.
- `resume_line` - the whole "read the resume" instruction: which file, any
  fallback file, and how this track frames that resume. **Name the `.txt`
  from step 2 as the file to read, and say plainly that the binary original
  beside it (`.pdf` as much as `.docx`) is not readable headless** - a line
  that names only the binary is a search that reads no resume and never says
  so. Each track frames the same resume differently; that framing lives here,
  not in a shared setting.
- `fit_clause` / `fit_disqualifier` - a short requirement and its mirror in
  the disqualified list ("a real fit (...)" / "poor fit"). Both empty when
  the track has no fit filter beyond the role line.
- `fit_filter_step` - only for a track that's a genuine pivot, where fit is
  the hard part and one clause won't carry it. Set, it becomes a whole
  screening step of its own before the capture step. Keep it to verifiable
  mismatches - see the fit-caveat warning in step 3.
- `doc_file` / `doc_summary` - the doc you just wrote, and what it contains.
- `doc_update_line`, `report_line`, `leads_note`, `screened_examples` - only
  when the defaults won't do. Leave them empty otherwise; the composed prompt
  has generic versions.
- `schedule_time` - `HH:mm` local. This is the schedule (`setup-scheduler.ps1`
  reads it), so stagger it: 30 minutes after the last existing track across
  all users on that machine, since they share one CLI and each run takes
  several minutes. Leave it empty on a track with `fed_by` set - that tab has
  no run of its own.
- `fed_by` - only for a track that's a second tab on a sibling's search rather
  than a search of its own (see step 3). `GET /api/prompt/<fed key>` refuses to
  compose a prompt for one; the feeding track's prompt is the whole search.

Once per person, the settings half (`geo_scope_line`, `scope_clause`,
`scope_disqualifier`, `location_guidance`, `footer_note`, `pronouns`) - also
verbatim prose. Write `geo_scope_line` and `location_guidance` as full
paragraphs with worked examples ("a role that is only London, Bangalore,
... is excluded"; `"Remote (U.S.)"` vs `"USA - Remote"`), not one-word
scopes: the generic fallbacks are weak, and the examples are what filter.

### 5. Confirm with the installer

Show the doc you wrote and the config you drafted (or a summary if long)
before moving on - a wrong target company or location tier is cheaper to fix
now than after it's live and scheduled.

After step 6 has posted it, fetch the composed prompt and show them that too:

```
curl -s "$TRACKER_URL/api/prompt/<key>" -H "Authorization: Bearer $USER_TOKEN"
```

This is the text their search will run every morning. Check it for a
`resume_line` naming a file that isn't there, a fit filter that reads harsher
than intended, or a geo scope that says nothing. Read the whole of a step
before judging it - the qualifying clause is often at the end (step 1b's
multi-tab dedup instruction is the last sentence of its paragraph).

### 6. Push config to the tracker API

**GET `/api/config` first and merge** - `POST /api/config`'s `tracks` field
*replaces the whole track list* (see `../../../server/README.md`); posting
only the new track(s) would delete every existing one. So:

```
curl -s "$TRACKER_URL/api/config" -H "Authorization: Bearer $USER_TOKEN"
```

The token decides whose config this is, so use *that person's* token
throughout - there's no user id in the request. Take its `tracks` array,
add/update entries for the track(s) from this run (`key`, `label`,
`full_description` = the role search line or a short description,
`sort_order` = next available index, plus the search-config fields drafted in
step 4), and POST the full merged list back along with `display_title` and
`priority_locations` (only include `display_title`/`priority_locations` if
this run is setting or changing them - omitting a field leaves it as-is):

```
curl -s -X POST "$TRACKER_URL/api/config" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tracks":[...merged list...],"display_title":"...","priority_locations":[...]}'
```

`priority_locations` is an ordered list of `{tier: "p-high"|"p-med", label,
anyOf: [...substrings], allOf?: [...substrings]}` - first match wins,
`anyOf` needs at least one substring present in the (lowercased) location
text, `allOf` (optional) needs all of them present too (used for something
like "remote AND a US indicator", not just "remote" alone).

`excluded_companies` is a JSON array of companies this person will not work
for at all - plain names, or a catch-all phrase like "any other company X owns
or leads". The prompt renders it into a single never-search sentence, so add
an exclusion to this list, never to a track's prose.

Send the prose settings from step 4 in the same call: `geo_scope_line`,
`scope_clause`, `scope_disqualifier`, `location_guidance`, `footer_note`,
`pronouns`. They're per person, so a second person's settings never disturb
the first's.

Further optional settings, only worth sending if the installer wants
something other than the defaults: `overview_label`, `applications_label` and
`all_leads_label` rename the built-in tabs (default "Overview" /
"Applications" / "All leads"), and `stale_run_hours` (default 36) sets how
long a track's scheduled search can go without reporting a run before the page
flags that tab as stale. Raise it for a search scheduled less often than daily
- a weekly search left at 36 would show a warning nearly all week.

Posting `tracks` also creates each new track's `search_runs` row, so its tab
shows "No run recorded yet" until its first scheduled run reports in. That's
expected on a fresh setup.

**Seed the shared company list with this track's starter companies.** Every
track rotates through the deployment's one company list - steps 1c, 9d and 9e
are in every search's prompt. Each night, step 1c serves a run the next
`COVERAGE_BATCH` companies (24, in `../../../server/src/routes/coverage.js`)
from that search's own cursor.

```
curl -s -X POST "$TRACKER_URL/api/coverage" \
  -H "Authorization: Bearer $USER_TOKEN" -H "Content-Type: application/json" \
  -d '{"search":"<key>","on":"","swept":[{"company":"Acme","board":"greenhouse"},{"company":"Globex"}]}'
```

- **Send `on: ""`, never today's date.** `""` registers companies without
  claiming anyone swept them. A date claims a sweep that didn't happen and
  moves the cursor past companies nothing has looked at.
- **Order doesn't matter.** New companies get shuffled positions, so seed in
  whatever order the list comes in. Companies already on the list (under any
  spelling `normalize()` matches) are not added twice.
- **Set `board` only where you know it** (`greenhouse`, `ashby`, `lever`,
  `workday cxs`); leave it out otherwise - a run fills it in when it finds one.
- **Use the feeding track's key in `search`**, never a `fed_by` tab's - the
  fed tab has no run of its own.
- **Seed every strong name you can justify.** A longer list lengthens the
  cycle; it never widens the nightly slice, which is `COVERAGE_BATCH`.
- **Make sure discovery can grow the list.** The list is the only one a run
  reads, so one that never grows goes quiet once its companies' postings are
  all tracked or screened. The track's doc must tell discovery to register a
  company it finds with `./tracker swept`, not only write the name into the
  doc - the template's step 3 says this; keep it if you edit that step.
- **Check back after a few days:**

  ```
  curl -s "$TRACKER_URL/api/coverage/<key>?all=1" -H "Authorization: Bearer $USER_TOKEN"
  ```

  `total` should have grown since seeding; if it hasn't, discovery isn't
  reaching the list, whatever the doc says. Ignore `batch` in this response -
  with `?all=1` it reports the whole list's length, not the nightly slice.

If there's no deployment to post to yet, skip this step and tell the
installer to come back to it (re-running this skill is fine, or they can run
the curls above by hand) once they've deployed the API and the webpage.

### 7. Register the scheduled tasks

Run `scripts/setup-scheduler.ps1` from the **main checkout**, never from a
git worktree: a task stores the absolute path of the script it runs, so one
registered from a worktree breaks silently once the worktree is removed.
Check first:

```powershell
git rev-parse --git-common-dir   # ".git" = main checkout; a path = worktree
```

From a worktree, call the main checkout's copy by absolute path, without
`cd`-ing there:

```powershell
& "C:\path\to\main\checkout\scripts\setup-scheduler.ps1" -DataDir "<data dir>" -User <user id>
```

Diff the two copies first (`diff scripts/setup-scheduler.ps1
<main>/scripts/setup-scheduler.ps1`) - if your branch changed the script,
the main checkout's version is the one that will actually run tonight.

**Verify what got registered rather than trusting the summary**, since a
wrong path fails silently:

```powershell
Get-ScheduledTask -TaskName "JobSearch-*" | ForEach-Object {
  [PSCustomObject]@{ Name = $_.TaskName
                     Path = ($_.Actions[0].Arguments -split '-File ')[1] } } |
  Format-Table -AutoSize
```

`setup-scheduler.ps1` discovers people by their
`<data dir>\<user id>\tracker.json` and asks each one's account what tracks
it has - nothing to pass it about which tracks exist. Add `-User <user id>`
to set up only this person; without it, it processes everyone on the
machine, and its cleanup only touches the people it processed. It warns about
any missing prerequisite (the `claude` CLI, `CLAUDE_CODE_OAUTH_TOKEN`,
unreadable config) rather than failing outright, so it's safe to run
mid-setup.

The time each task runs comes from the track's `schedule_time` in D1, so a
time change is a config post. Re-run `setup-scheduler.ps1` when a track is
added or removed.

It also registers `JobSearch-Applications`, one machine-wide nightly task
that fills in applications logged on the tracker page as just a posting URL -
nothing to configure per person (see `../../../server/README.md`,
"Applications added as nothing but a URL"). Tell the installer that adding an
application is a paste of the posting's URL.

### 8. Offer a test run

Suggest running one new track immediately rather than waiting for its
scheduled time:

```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = [Environment]::GetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN','User')
scripts\run-search.ps1 -Task <key> -User <user id>
```

**That first line is not optional for a manual test.** `setup-scheduler.ps1`
checks the token at *User scope* and reports "is set"; `run-search.ps1` reads
it from the *process* environment. A shell started before the variable was
set - including an agent session open a while - has the first and not the
second, so the run dies on `Not logged in - Please run /login`. Scheduled
runs start a fresh process and aren't affected.

`run-search.ps1` exits 1 when the run wrote no run record, whatever the
reason. Read `<data dir>\<user id>\logs\<key>.log` either way: an `ERROR:`
line says why a run failed, and `WARNING: couldn't check whether a run record
was written` means the exit code proves nothing. A real run takes minutes.

Then confirm on the tracker webpage that the new track's tab shows up *and*
reports when it last ran. A tab still reading "No run recorded yet" after a
completed run means the prompt's step 9c (`./tracker run`) didn't land - chase
it: that record is what tells a quiet day from a search that stopped firing
(see `POST /api/runs` in `../../../server/README.md`). For a search with a
`fed_by` tab, expect a run recorded against **both** keys - a fed tab with no
run of its own reads as stale forever.

If this was a brand-new install, the page had no tracks until step 6 posted
the config.
