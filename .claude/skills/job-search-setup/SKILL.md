---
name: job-search-setup
description: Onboards a person into this job-search tracker (or adds a track to an existing one) - provisions their account, reads their resume(s), asks about desired role tracks and locations, uploads their resume and per-track baseline doc, posts their search config and page config to /api/config, and registers their scheduled tasks. Use when someone wants to set up this repo for themselves, add a second person to an existing deployment, or add/change a tracked search.
---

# Job search setup

This repo's tooling (`scripts/`, `server/`, `client/`) is generic - it has no
opinion on whose job search this is, how many tracks they want, or what
locations matter to them. The personal part lives in the deployment, keyed by
user id: search and page config in D1 (see `../../../server/README.md`'s
`/api/config` section), resumes and each track's baseline doc in R2 (see
`/api/documents`). What is left on disk is that person's credential and their
logs (see `../../../private.example/README.md`). This skill is what fills those
in conversationally, instead of hand-authoring JSON.

One deployment holds any number of people. Run this the same way for the
first person, for a second person joining an existing deployment, and for
adding one more track to someone who already has some - check what's already
there (step 1) and only ask about what's missing. It also runs the same way
whether this repo got here via `git clone` or via `/plugin install` - the one
place that differs is step 7 (registering scheduled tasks), which needs to
know which one it is.

**Not for the demo account.** A request for a demo, sample or fake account is
`../../../scripts/seed-demo-user.ps1`, not this skill: what that account needs
is invented data and *no* private folder and *no* scheduled tasks, which is
the opposite of steps 2, 4 and 7 below. Running this skill for it would give
a demo a nightly search that costs real CLI time looking for jobs nobody
wants. See the README's "The demo account" section.

## One identifier per track

Pick **one lowercase-hyphenated slug per track** (e.g. `engineering`,
`data-science`, `technical-pm`) and use it as *all three* of: the
`docs/tracked_<key>_postings.md` filename, the D1 `tracks.key` / `search`
value sent to `/api/leads`, and the `-Task` value passed to
`run-search.ps1`. Track keys only have to be unique per person - two people
can both have a `SWE`, and their leads, tabs and run history stay separate.
(This repo's own first three tracks predate this skill and split that into
two different values - `SWE`/`TPM`/`CPM` for the tracker vs.
`engineering`/`technical-pm`/`product` for the files - purely for historical
reasons. Don't replicate that split for new tracks; one slug is simpler and
there's no reason left not to.)

## Steps

### 1. Establish who this is, and see what already exists

One deployment can hold several people's job searches, each keyed by a GUID
user id. So the first question is *whose* search this is.

- Data dir is `$JOB_SEARCH_DATA_DIR` if set, else `private/` next to this
  repo. Inside it, each person has their own folder named by their user id,
  holding `tracker.json` and `logs/` - and nothing else that matters. Their
  documents (resumes, each track's baseline doc, reference files) live in the
  tracker and are fetched per run into a throwaway `.run/<key>/`. See
  `../../../docs/private-storage-plan.md`.
- **Existing person?** Ask for their name and find their folder (their id is
  in `tracker.json`, or `GET /api/me` with their token returns it). Read
  `GET /api/config` with their token - the tracks it returns are what they
  already have, so this is an "add a track" run for whatever's missing.
- **New person?** They need an account before anything else can be stored
  against them. That takes the deployment's `ADMIN_TOKEN` (a worker secret -
  whoever runs the Cloudflare account has it):

  ```
  curl -s -X POST "$TRACKER_URL/api/users" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"Their Name","password":"<a long random password - see below>"}'
  ```

  It returns their `id`. Create `<data dir>/<id>/` - just the folder; the
  document subfolders are not used any more - then mint the long-lived token
  their scheduled searches will use and write it alongside:

  ```
  curl -s -X POST "$TRACKER_URL/api/login" -H "Content-Type: application/json" \
    -d '{"name":"Their Name","password":"<the same password>","label":"scheduled-search"}'
  ```

  Write `{"url": "<tracker url>", "token": "<the token it returned>"}` to
  `<data dir>/<id>/tracker.json`. Never put the password in that file, or
  anywhere else on disk - it's only ever typed into the webpage's sign-in.

  **Don't ask for, invent, or type their real password here.** Those two
  commands need *a* password, not *their* password, and whatever goes on that
  command line lands in shell history and in the transcript of whoever ran it.
  So generate a long random one **in the same process that sends both
  requests**, never printing it - a short script that POSTs `/api/users`, then
  `/api/login`, then writes `tracker.json`, and emits only the user id. That
  leaves an account whose password nobody knows, which is fine and is the
  point: the scheduled searches authenticate with the token, and a reset needs
  the admin token rather than the old password.

  Then have **them** set a real one, at a prompt, in their own terminal:

  ```powershell
  scripts\set-password.ps1 -Name "Their Name"
  ```

  It reads the password with `Read-Host -AsSecureString`, confirms it, zeroes
  the plaintext afterwards, and warns if the reply says `created: true` -
  which means the name didn't match and a second, empty account now exists.
  (`users.name` is `UNIQUE COLLATE NOCASE`, so case is safe and spelling is
  not.) Resetting only rewrites `password_hash`; sessions are a separate
  table, so the scheduled-search token keeps working and step 7 does not need
  redoing.
- If you don't have `TRACKER_URL`, or the deployment doesn't exist yet, keep
  going (steps 2-5 don't need it) but tell the installer they'll need
  `../../../server/README.md`'s setup done and step 6 re-run before the
  searches can sync anywhere.

### 2. Get the resume(s)

- Ask the installer for their resume file(s) - any format (`.docx`, `.pdf`,
  `.txt`). Anywhere on disk is fine; nothing has to be staged in a particular
  folder, because these are uploaded rather than left in place.
- Read it. Plain text/Markdown: read directly. PDF: try the Read tool, but
  don't assume it works - it renders pages via `pdftoppm` (poppler-utils),
  which is missing on plenty of machines, and fails outright when it is.
  `py -m pip install pypdf` then `pypdf.PdfReader(path).extract_text()` is
  the fallback that doesn't need it. `.docx`: use the `docx` skill to extract
  text, or ask the installer for a plain-text copy. If nothing readable is
  present, ask the installer to paste their key experience/skills directly in
  chat instead of blocking on a file.
- **Upload both the original and a plain-text copy**, and point `resume_line`
  (step 4) at the `.txt`. Whether *you* can read the PDF here is not the
  question: the nightly run is headless and gets no interactive fallback, so a
  resume stored only as `.pdf` or `.docx` is one the search may read *nothing*
  from. That failure is silent in the worst way - the run still completes,
  still posts leads, and still reports success, having screened every posting
  against an empty candidate profile. Keep the `.txt` filename stable
  (`<Name>_Resume.txt`) so a later resume version is a content swap rather than
  a config edit.

  ```bash
  curl -s -X PUT "$TRACKER_URL/api/documents/resumes/Their_Name_Resume.pdf" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/pdf" \
    --data-binary @"/path/to/resume.pdf"
  ```

  Or hand the whole job to `scripts/import-documents.ps1`, which walks a
  folder, picks the content type per extension and refuses anything it cannot
  name. Filenames must start and end with a letter or digit and must not be a
  Windows device name - the API refuses the rest, because these get written to
  a real disk on every run.
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
- **Companies**: don't ask for a list. The deployment has one company list,
  shared by every search and every account, and this track reads it from its
  first night. If the installer names a company they particularly want
  searched, check whether it is already there and add it with
  `.claude/skills/add-target-company/SKILL.md` - and if they name one they
  never want to see, that is `excluded_companies` in their settings, not a
  company list of their own.
- Any **track-specific fit caveat** worth calling out (e.g. a PM track that
  should exclude non-technical PM roles) - optional. Keep this scoped to an
  actual, verifiable mismatch (a skill, language, location, or level the
  installer genuinely doesn't have), not a list of qualifications or role
  categories to require verbatim - the template already defaults every track
  to weighing a stated requirement against the candidate profile rather than
  auto-disqualifying on it (see its "Fit philosophy" section). Watch for this
  same mistake at the category level, not just the requirement level: "the
  resume doesn't document experimentation ownership" is not the same claim as
  "exclude experimentation-flavored roles," and it's an easy one to write
  down as a caveat without noticing the substitution. This matters most for a
  track that's a real stretch from the installer's resume (a title/domain
  pivot, not a lateral match) - that's exactly where an overly literal fit
  caveat quietly screens out real, well-fitting opportunities before the
  installer ever sees them.

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
  (step 4) - keep them in sync; a search-runner writing location text that
  doesn't match the configured tiers is exactly the bug this skill exists to
  avoid.
- **Display title** for the tracker page (e.g. "Jordan's Job Search").
- **Pronouns** - the `pronouns` setting, which the composed prompt uses when
  it writes about them ("his board", "they would rather see it"). Ask; don't
  infer it from their name or their resume. Left empty the prompt stays
  generic, which is a fine answer if they'd rather not say - but it has to be
  their answer rather than your guess.
- **Any hard compensation floor**, if they have one. There is no salary field:
  it goes in `fit_clause` / `fit_disqualifier` (step 4), and how you word it
  decides whether it helps. Screen on a *stated* range only, and keep a
  posting that publishes none - "a range topping out below $X" disqualifies,
  "no published range" does not. A literal floor throws away most postings
  from states without pay-transparency laws, which is the majority of a
  remote search, and it does it invisibly. Say in the doc's Candidate Profile
  what the floor is and that an unstated range is not a reason to screen.

### 4. Write the per-track doc, and draft the track's config

There is no prompt file to generate any more. The daily prompt is composed by
the worker from the track's config in D1 (see
`../../../server/src/prompt.js`), so this step produces *config*, posted in
step 6 - plus one document:

- Fill `templates/tracked-postings.template.md` and `PUT` it to the tracker at
  `docs/tracked_<key>_postings.md`:

  ```bash
  curl -s -X PUT "$TRACKER_URL/api/documents/docs/tracked_<key>_postings.md" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/markdown" \
    --data-binary @filled-template.md
  ```

  This stays a document rather than config because the search itself edits it,
  accumulating fetch-reliability notes run over run. **Check whether it exists
  first** (`GET /api/documents`) and ask before overwriting - it holds real
  history, not something to regenerate casually. An unconditional `PUT` over an
  established doc destroys weeks of accumulated findings with no error.

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

- `{{LOCATION_TIER_ROWS}}`: one Markdown table row per priority tier, e.g.
  `| Top | Seattle, Bellevue, ... - or remote within scope | teal stripe +
  "Seattle area" / "Remote US" tag, sorted to the top of its tab |`. Keep
  these in step with the `priority_locations` you'll post in step 6. The
  client ranks by a rule's *position* in that list and ignores its `tier`
  string, so the order you post them in is the order they rank in.

**If this search fills a `fed_by` tab, say so in the doc.** One search, one
doc - the fed tab shares the feeder's, and the template is written as though
the track were the only tab. This used to make the template's step 1 actively
wrong: it named `/api/dedup/<key>`, one tab's worth, while the prompt fetched
every tab and merged them, so the doc and the prompt disagreed about what
"already seen" meant - and the doc is what the run reads first. That
particular trap is gone: step 1 now names `./tracker dedup`, which asks the
config which tabs this search feeds and merges them itself, so the doc cannot
disagree with the prompt about it any more.

What is still worth adding to that step is the part no command can supply:
which tabs this search fills, and that a posting tracked under *either* key is
not new whichever tab today's run would file it under.

**Write the distinction between the tabs, not a fallback tab.** The composed
prompt already breaks a genuine tie, among the tabs the posting actually reads
as, taking whichever comes first in tab order. A doc line naming one tab as
where ambiguous postings go reads tidier and is worse: the only tab a doc has
to name is the feeder, and the feeder is whichever tab happens to own the
scheduled search rather than a general-purpose one - so ambiguity lands in a
tab the posting was never a candidate for. That is not hypothetical; it is how
a Senior Software Engineer, Insurance role reached an Eng - Gaming tab. If the
split needs a finer rule, write the question that separates the tabs ("ask
what the company sells"), never a destination.

Then draft the track's config fields for step 6. Most of them are **prose
the prompt uses verbatim**, not keywords the worker expands - write them as
the finished sentence you want the search to read:

- `role_search_line` - the titles/seniority to search for, as it will appear
  mid-sentence ("Senior/Staff Software Engineer, Backend Engineer, or
  Distributed Systems roles").
- `target_companies` - this search's *strategy* prose: which kinds of
  employer it favours and why ("gaming first, then creator platforms, then
  anything with a real engineering org in the scope"). Step 3 of the prompt
  names it as context beside the companies step 1c hands the run. It is not
  the list of companies to search - that list is shared and lives in the
  tracker - so don't write names here expecting them to be searched. Leave it
  empty when the track has no preference worth stating.
- `search_note` - anything qualifying how those companies are searched. This
  is where "none of these are industry-only searches, surface any matching
  role at them" goes.
- `resume_line` - the whole "read the resume" instruction: which file, any
  fallback file, and how this track frames that resume. **Name the `.txt`
  from step 2 as the file to read, and say plainly that the binary original
  beside it is not readable headless** - that goes for `.pdf` every bit as
  much as `.docx`, and PDF is what most people hand you. A line that names
  only the PDF is a search that reads no resume at all and never says so.
  Each track frames the same resume differently; that framing lives here, not
  in a shared setting.
- `fit_clause` / `fit_disqualifier` - a short requirement and its mirror in
  the disqualified list ("a real fit (...)" / "poor fit"). Both empty when
  the track has no fit filter beyond the role line.
- `fit_filter_step` - only for a track that's a genuine pivot, where fit is
  the hard part and one clause won't carry it. Set, it becomes a whole
  screening step of its own before the capture step. Keep it to verifiable
  mismatches (a skill, level, or region they genuinely don't have) - see the
  warning in step 3 about over-literal fit caveats.
- `doc_file` / `doc_summary` - the doc you just wrote, and what it contains.
- `doc_update_line`, `report_line`, `leads_note`, `screened_examples` - only
  when the defaults won't do. Leave them empty otherwise; the composed prompt
  has sensible generic versions.
- `schedule_time` - `HH:mm` local. This *is* the schedule now (step 7 reads
  it), so stagger it: 30 minutes after the last existing track across all
  users on that machine, since they share one CLI. Leave it empty on a track
  with `fed_by` set - that tab has no run of its own.
- `fed_by` - only for a track that's a second tab on a sibling's search rather
  than a search of its own (see step 3). `GET /api/prompt/<fed key>` refuses to
  compose a prompt for one; the feeding track's prompt is the whole search.

Once per person, the settings half (`geo_scope_line`, `scope_clause`,
`scope_disqualifier`, `location_guidance`, `footer_note`, `pronouns`) - also
verbatim prose. Write `geo_scope_line` and `location_guidance` as full
paragraphs with worked examples ("a role that is only London, Bangalore,
... is excluded"; `"Remote (U.S.)"` vs `"USA - Remote"`), not one-word
scopes. The generic fallbacks are deliberately weak; the examples are what
make these actually filter.

### 5. Confirm with the installer

Show the doc you wrote and the config you drafted (or a summary if long)
before moving on - cheaper to fix a wrong role line or location tier now
than after it's pushed live and scheduled.

After step 6 has posted it, fetch the composed prompt and show them that too:

```
curl -s "$TRACKER_URL/api/prompt/<key>" -H "Authorization: Bearer $USER_TOKEN"
```

This is the actual text their search will run every morning, assembled from
what you just posted. It's the fastest way to catch a `resume_line` naming a
file that isn't there, a fit filter that reads harsher than intended, or a
geo scope that says nothing. Read the whole of a step before judging it -
several are long, and the qualifying clause tends to be at the end (step 1b's
multi-tab dedup instruction is the last sentence of a paragraph, and looks
missing if you skim the first half).

**Scripting any of these calls? Send a `User-Agent`.** Every example here is
curl, and curl sets one. Cloudflare's browser-integrity check rejects some
default agents - Python's `urllib` among them - with **HTTP 403 and a body of
`error code: 1010`**, before the request reaches the Worker. It is
indistinguishable from a rejected `ADMIN_TOKEN` unless you read the response
body, so it reads as "the deployment's credentials have been rotated" when
nothing is wrong. Any ordinary UA string fixes it.

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
or leads". The prompt renders it into a single never-search sentence, so an
exclusion is an append to a list rather than a sentence hand-written into some
track's prose (which is how the first two ended up in two different fields).

Send the prose settings from step 4 in the same call: `geo_scope_line`,
`scope_clause`, `scope_disqualifier`, `location_guidance`, `footer_note`,
`pronouns`. They're per person, so a second person's settings never disturb
the first's.

Three further optional settings, only worth sending if the installer wants
something other than the defaults: `overview_label` and `applications_label`
rename the two built-in tabs (default "Overview" / "Applications"), and
`stale_run_hours` (default 36) sets how long a track's scheduled search can
go without reporting a run before the page flags that tab as stale. Raise it
for a search scheduled less often than daily - a weekly search left at 36
would show a warning nearly all week.

Posting `tracks` also creates each new track's `search_runs` row, so its tab
shows "No run recorded yet" until its first scheduled run reports in. That's
expected on a fresh setup, not a problem to chase.

**There is no company list to seed.** One list serves the whole deployment -
every search, every account, reads the same one - and a new track starts at the
front of it on its first night. Nothing registers companies for a new person,
and a per-person list is not a thing that can exist.

Sanity-check that the list is there, with any key:

```
curl -s "$TRACKER_URL/api/coverage/<key>?all=1" \
  -H "Authorization: Bearer $USER_TOKEN" | node -pe '"companies: " + JSON.parse(require("fs").readFileSync(0,"utf8")).total'
```

Each run covers `COVERAGE_BATCH` of them - a hard constant of 24 in
`server/src/routes/coverage.js` - and every company is reached once per cycle
before any is reached twice, so a 144-company list turns over in about six
nights. Ignore `batch` in the `?all=1` branch: it reports the whole table's
length, not the nightly slice.

A deployment whose list is empty is the one case worth a word: the first
deployment ever, before any run has recorded a company. Nothing needs seeding
there either - step 3b of each nightly run searches outside the list and step 9d
records what it finds, so the list builds itself from the first night. Say so
rather than typing names in, and if the installer wants a specific employer on
it today, use `.claude/skills/add-target-company/SKILL.md`.

The one thing a track still owes the list is a working way to grow it: the
track's doc must tell the run to register a company it discovers with
`./tracker swept`, not to write the name into prose. `templates/tracked-postings.template.md`
carries that rule and the non-tech verticals already. A track whose doc only
notes names in prose finds nothing new once the postings its known companies
have open are all tracked or screened - that happened to a track here, which ran
eight days, drew all 75 of its leads from the same 12 employers, and was finding
nothing at all by day six.

If there's no deployment to post to yet, skip this step and tell the
installer to come back to it (re-running this skill is fine, or they can run
the curls above by hand) once they've deployed the API and the webpage.

### 7. Register the scheduled tasks

Run `scripts/setup-scheduler.ps1` from the repo root (or with `-DataDir`
pointing at a non-default data dir). A clone is a stable location, which is
what a scheduled task needs - it stores an absolute path and runs it unattended
for months.

This used to fork on whether the repo arrived by clone or by `/plugin install`,
because `$env:CLAUDE_PLUGIN_ROOT` points at a cache directory that gets
replaced when a plugin updates, so a task registered against it broke silently
a fortnight later. This is no longer published as a plugin, so a clone is the
only way in and that hazard is gone with it. If you find a task still pointing
into a plugin cache from the old arrangement, re-register it from the clone.

**Unless you are in a git worktree, which is not.** Check before running it:

```powershell
git rev-parse --git-common-dir   # ".git" = main checkout; a path = worktree
```

A worktree is a temporary checkout that gets removed when the work is done,
and agents run in one routinely - so this is the ordinary case, not an exotic
one. The task records an absolute path to `run-search.ps1`, so registering
from `<repo>/.claude/worktrees/<name>/scripts` produces a task that works
today, breaks the moment the worktree is cleaned up, and fails from then on
by running nothing at all. Exactly the `CLAUDE_PLUGIN_ROOT` hazard above,
reached a different way.

So register from the **main checkout**, by absolute path, without `cd`-ing
there:

```powershell
& "C:\path\to\main\checkout\scripts\setup-scheduler.ps1" -DataDir "<data dir>" -User <user id>
```

Diff the two copies first (`diff scripts/setup-scheduler.ps1
<main>/scripts/setup-scheduler.ps1`) - if your branch changed the script,
the main checkout's version is the one that will actually run tonight.

Whichever path you take, **verify what got registered rather than trusting
the summary**, since a wrong path fails silently months later:

```powershell
Get-ScheduledTask -TaskName "JobSearch-*" | ForEach-Object {
  [PSCustomObject]@{ Name = $_.TaskName
                     Path = ($_.Actions[0].Arguments -split '-File ')[1] } } |
  Format-Table -AutoSize
```

Either way, `setup-scheduler.ps1` discovers people by their
`<data dir>\<user id>\tracker.json` and asks each one's account what tracks
it has - nothing to pass it about which tracks exist. Add `-User <user id>`
to set up only this person; without it, it processes everyone on the
machine, which is also fine (its cleanup only ever touches the people it
processed). It warns about any missing prerequisite (the `claude` CLI,
`CLAUDE_CODE_OAUTH_TOKEN`, unreadable config) rather than failing outright,
so it's safe to run mid-setup.

Note the schedule now comes from each track's `schedule_time` in D1, not from
this script - so a time change is a config post, not a re-registration. When
a machine runs more than one person's searches, stagger across all of them:
they share one CLI and one Claude account (the machine owner's), and each run
takes several minutes.

One further task gets registered that isn't a search and isn't per person:
`JobSearch-Applications`, the nightly fill for applications logged on the
tracker page by pasting a job posting's URL and nothing else. It runs
`run-fill.ps1` once for the whole machine - every account in one turn - and
reads those postings to write down the company, role and location. None of it
is visible on the page: no setting, no status, nothing to configure here, and
nothing extra to do when you add a second person. Worth mentioning to them,
though: it is the reason adding an application is a paste rather than nine
fields typed out by hand.

Re-run this step (the copy + `setup-scheduler.ps1`) any time after a plugin
update, so the stable copy and the registered tasks stay current.

### 8. Offer a test run

Suggest running one new track immediately rather than waiting for its
scheduled time:

```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = [Environment]::GetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN','User')
scripts\run-search.ps1 -Task <key> -User <user id>
```

**That first line is not optional for a manual test.** `setup-scheduler.ps1`
checks the token at *User scope* (the registry) and reports "is set";
`run-search.ps1` reads it from the *process* environment. Any shell started
before the variable was set - which includes an agent session that has been
open a while - has the first and not the second, so setup says it is fine and
the run then dies on `Not logged in - Please run /login`. Task Scheduler
spawns a fresh process at the scheduled time and picks it up from User scope,
so this gap only ever bites the manual test, which is exactly when someone is
deciding whether the whole setup works.

**Exit code 0 does not mean the run worked.** `run-search.ps1` returns 0 when
the CLI underneath it failed - it captures the CLI's output into the log
rather than propagating its status. A run that authenticated nowhere and did
nothing takes about 20 seconds and reports success. So judge it by the log
and the elapsed time, never by the exit code: a real run takes minutes.

Then check `<data dir>\<user id>\logs\<key>.log` for what happened, and confirm on the
tracker webpage that the new track's tab shows up *and* now reports when it
last ran. A tab still reading "No run recorded yet" after a completed run
means the prompt's step 9c (`./tracker run`) didn't land - worth chasing,
since that record is the only thing that will later distinguish a quiet day
from a search that stopped firing. (It is also the backstop for the exit-code
problem above: a run that died early never reaches 9c, so the stale tab is
what surfaces it.) For a search with a `fed_by` tab, expect a run recorded
against **both** keys - a fed tab with no run of its own reads as stale
forever.

If this was a brand-new install, this is also the point where the page stops
being empty: it had no tracks at all until step 6 posted the config.
