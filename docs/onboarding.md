# Onboarding

How someone with an invite link ends up with a working nightly search. The API
contract for every route named here is in
[`../server/README.md`](../server/README.md#invites-and-first-run-setup); this
doc is the flow across the page, the worker and the machine, and the rules that
hold it together. Terms are defined in [`glossary.md`](glossary.md).

## The flow

1. **Invite.** The operator runs `scripts/new-invite.ps1`, which calls
   `POST /api/invites` with `ADMIN_TOKEN` and prints
   `<client URL>/?invite=<code>`. Only the code's hash is stored.
2. **Signup.** The page checks the code (`GET /api/invite/<code>`), then
   `POST /api/signup` claims the invite and creates the account in one batch,
   so a taken name leaves the invite unused. The person is signed in.
3. **Setup form.** An account with no tracks and no intake gets
   `client/src/components/Setup.tsx` instead of the tracker. It uploads resume
   files to `/api/documents/resumes/<name>` first, then sends the answers to
   `POST /api/intake`.
4. **Send builds the tracker.** `handlePostIntake`
   (`server/src/routes/onboarding.js`) writes, in one transaction
   (`Db.createIntakeWithConfig`): the `intake` row with status `pending`, the
   form's settings, one track per role block, and a "never ran" run record
   for each. The page re-reads `/api/data` and shows the tracker straight
   away, with a notice that the night still has work to do.
5. **The night writes it up.** `scripts/run-onboarding.ps1` runs at 00:00 and
   works through `GET /api/intake/pending`. For each person it:
   - reuses their `tracker.json` token, or mints one (`POST /api/tokens`,
     label `scheduled-search`) and writes `tracker.json` before anything else;
   - picks a schedule slot per track (see [Slots](#slots));
   - stages their answers, their readable resumes (`.txt`, `.md`, `.pdf`) and
     the track doc template into `<DataDir>\<id>\.onboarding\`;
   - runs one `claude -p` turn confined to that folder: file tools only, no
     shell, no network, no token, 25-minute limit. It writes
     `out\config.json` and one `out\docs\tracked_<key>_postings.md` per track;
   - validates that output, then posts it as the person: each track doc to
     `/api/documents`, each track's prose to `POST /api/writeup`, the
     companies they named to `POST /api/coverage` with `start_here`, and
     registers their tasks with `setup-scheduler.ps1 -User <id>`;
   - re-reads the tracker and Task Scheduler, and records the outcome with
     `POST /api/intake/complete` - `done`, or `failed` with a note the person
     reads on their own page.

## Why it is split this way

**The form owns values; the night owns prose.** Everything the form collects
is a value that needs no judgement, so it is written at send: `label`,
`sort_order`, `display_title`, `pronouns`, `priority_locations` and
`excluded_companies`. Turning a resume and "senior backend, Seattle or remote"
into the sentences `server/src/prompt.js` reads verbatim needs a model, so that
waits for the night. The two sets don't overlap. `POST /api/writeup` accepts
only the night's half - `WRITEUP_FIELDS` and `WRITEUP_SETTINGS` in
`server/src/db.js` - and refuses any other key by name, so a run cannot
overwrite what the person chose. `fed_by` is in neither; pairing tabs is the
tracker's own configuration, through `POST /api/config`.

**The send is write-once.** A second `POST /api/intake` gets 409, whatever
state the first is in. Once the tracker exists, the tracker's own config is how
a search changes, so nothing can put an account back to `pending` and have the
night rebuild over edits the person has made since.

**A track key is fixed at creation.** It is a slug of the role's name
(`tracksFromRoles`), with the role's position appended when the slug is empty
or already taken. Renaming a role later changes its label only, so no lead
filed under the key is orphaned.

**"Written up" means `role_search_line` is set.** A track without it would
still compose a well-formed prompt from the generic fallbacks, and a run would
carry out that hollow search and report success. So `GET /api/prompt/<key>`
answers 409 for such a track, and `setup-scheduler.ps1` registers no task for
it until a run has written it up.

**The scope check runs at send, not overnight.** `scopeProblem` refuses a send
with no answer to "What locations should be searched?", because the person is
still on the form and can fix it. That is the only refusal: the places ranked
under "Which locations should come first?" and that answer aren't compared.

**A ranked place is always in scope.** Where the location answers disagree, the
place is included rather than excluded. What a run searches comes from the
scope prose the overnight write-up writes, and `run-onboarding.ps1` adds every
ranked place to that prose itself after the model writes it, so a ranked place
is searched even when "What locations should be searched?" leaves it out or
"Anywhere you can't take a job?" names it. The rule is applied at write-up: a
search's stored prose isn't rewritten when the rule changes. The ranked places
also order the leads on the page.
[location-settings-plan.md](location-settings-plan.md) plans location answers
as settings the prompt reads directly.

**Done and failed are read from the tracker, not from the model.** A person is
`done` when the tracker has their written-up tracks and docs and the machine
has their tasks. Anything short of that is `failed`, so their page stops
promising a tracker and says what happened.

## Retries

A `failed` intake stays in `GET /api/intake/pending` while its `sent_at` is
less than three days old (`RETRY_NIGHTS` in `server/src/onboarding.js`), so the
following nights retry it with the same answers. The bound lives in what the
run is handed rather than in the run's memory, so a second machine or a run
that lost its state cannot keep retrying an abandoned setup. Nothing counts
attempts: a night the machine was off still spends one of the three days.

`done` is final - `POST /api/intake/complete` refuses to change it.

The tracker's notice follows the status (`SetupNotice` in `client/src/App.tsx`):

- `pending` promises tonight's run. Once `sent_at` is older than the account's
  `stale_run_hours` (`setupOverdue`), it stops promising tonight and says the
  run may not have happened, since repeating the promise would renew it every
  day it stays false.
- `failed` shows the run's note. Once `GET /api/intake`'s `retries_end_at` has
  passed (`retriesEnded`), it says the run has stopped trying and to ask
  whoever invited them, because the stored note can still promise another
  night. The server sends the cutoff so the page never holds its own copy of
  the retry window.

## Slots

A new search is scheduled inside the night, between this run and the
application fill:

- no earlier than 01:00;
- no later than 05:45, clear of the 06:30 fill;
- on the quarter hour, at least 45 minutes after the latest search already
  scheduled, and at least 45 minutes from the 03:15 backup and from every other
  search on the machine.

Taken times are read from every account's config on this machine, because the
config is what `setup-scheduler.ps1` registers from. When no slot is left the
setup fails with a note telling the person to ask whoever invited them.

## Scheduling and prerequisites

`setup-scheduler.ps1` registers `JobSearch-Onboarding` daily at 00:00 only
while `<DataDir>\deployment.json` holds an `admin_token`, and removes it
otherwise: the run needs that token to read the queue and mint search tokens.
It runs before the night's first search so a new person can be given a slot
later the same night. It logs to `<DataDir>\logs\onboarding.log`.

The run reads the job-search-setup skill (`.claude/skills/job-search-setup/`)
and its track doc template from the checkout it runs from.

`run-onboarding.ps1` does not take `scripts/run-lock.ps1`; only
`run-search.ps1` and `run-fill.ps1` do.

## Where the data lives

| What | Where |
|---|---|
| Invites | `invites` |
| Answers and status | `intake` |
| The form's settings | `meta` |
| Tracks, and the night's prose on them | `tracks` |
| "Never ran" rows | `search_runs` |
| The machine's token | `sessions`, label `scheduled-search` |
| Resumes and track docs | R2, under `resumes/` and `docs/` |

Columns are in [`schema.md`](schema.md).
