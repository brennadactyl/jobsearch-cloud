# Backlog

What is worth building next, and why, ranked. Not a plan and not a promise: an
item leaves this list when it gets a plan of its own or ships.

Kept by whoever is holding the product manager role.

## How debt is ranked

Three questions, after
[Riot's taxonomy](https://www.riotgames.com/en/news/taxonomy-tech-debt):

- **Impact** - what it costs the person searching, and what it costs whoever
  changes the code next.
- **Fix cost** - the work, plus the risk of the change itself. A shape we'd
  never choose again can still be serving its users.
- **Contagion** - whether it spreads: copied into the next search's config,
  taught to the next night's prompt, or baked into an interface others build on.
  Contagion outranks impact when they disagree, because a spreading shape gets
  more expensive every week and a contained one doesn't.

Contained debt is left alone until something else makes it worth touching.
Debt in a foundation is replaced beside the old thing rather than in place, and
anything that writes data carries its own risk: prose in a search's config and
rows the runs write get far less review than code, and a wrong one is already
copied everywhere by the time it's noticed.

A wrong line in a doc or a skill spreads the same way, by being copied into a
track doc or another skill and then followed, so a fix looks for the copies and
counts them. What a doc claims is settled against the code, not against another
doc, and a finding says whether anything was built on the wrong line.

## Next

- **Team skills and tools** - approved from every role's workflow review. In
  order: commit the proof tools under `tools/` (comment-only checks, one prompt
  snapshot, the tracker helper rig, the doc link checker and diagram generator)
  with a `prove-a-change` skill; fix `verify-and-deploy`; three CLAUDE.md lines;
  then skills for testing the page against a local server, live end-to-end
  tests, rebuilding a search's doc and PowerShell script conventions; fixes to
  `edit-tracker-page`, `job-search-setup`, `add-target-company` and
  `change-search-prompt`; a nightly run report and a backup query script.
- **[One task asks what is due](dispatcher-plan.md)**, instead of one Windows
  task per search. The schedule is a copy of the config made when someone last
  ran `setup-scheduler.ps1`, and it drifts three ways: a new search with no
  task, a paused search whose task outlives it, and a task disabled by hand that
  the tracker knows nothing about. A dispatcher asking `GET /api/due` removes
  the copy, and with it the register, skip, unregister and report rules - none of
  which survive the searches leaving the PC. The endpoint answers with a claim,
  so two callers can't run one search twice; that is also what makes the move off
  the PC a transition rather than a cutover. Its cost is one point of failure
  where today a broken task costs one search, watched through run health. Backend
  Buddy for the endpoint, Fullstack Friend for the dispatcher, Prompt Bro on what
  a run needs at its start.
- **"Don't show me this company again", from a lead.** Ruling a company out
  means typing its name in settings today, at the moment the person is looking
  straight at it on a job. One action on the row adds the company to
  `excluded_companies` - the same list the account panel shows as chips, which
  the server matcher and the prompt already read - so no run brings it back.
  It covers every search, and it hides that company's existing leads too. The
  person is told what it did and can undo it, and removing the chip in the
  panel is the other way back.
- **[A pay floor on each search](search-fields-plan.md)** - the rest of that
  plan. The roles line and the two fit rules are live in the panel; the floor is
  the part that needs two stored values, a migration, and the clauses the prompt
  composes in step 7. A posting stays when its range reaches the amount or states
  none, and is screened only when its whole range sits below it. Prompt Bro has
  read the two searches that state a pay rule today, so their numbers can be set
  once the field exists.
- **Split a track doc into what is composed and what is accumulated.** One file
  holds both the parts generated from config and what the runs earn over weeks -
  companies tried, delisting guards, notes on a careers site - and its only
  writer replaces the whole file, so regenerating the first half destroys the
  second. That is why an answers edit can't be offered on a built account, and
  why a delayed setup retry overwrites a track it already built. The fix is the
  shape `GET /api/prompt/<key>` already has: compose the generated parts at read
  time from config, and store only what the runs accumulate, written through
  routes that add facts. Part of the work is deciding what stops being
  duplicated, since the shared company list and `company_sweeps` already hold
  much of it. It retires most of what `rebuild-track-doc` exists for. Prompt Bro
  owns the prose, Backend Buddy the storage and routes; every existing track
  migrates one account at a time, each with a night watched after it.
- **Recover a setup that failed.** A failed setup is retried for three nights
  from the send, so fixing the resume on the fourth day fixes nothing. A narrow
  "try tonight" action that re-stamps the retry window and changes no answers is
  enough; the run then takes its usual unbuilt-account path. Until something
  ships, a failure note tells the person to ask whoever invited them.
- **A delayed setup retry overwrites a track it already built.** When a first
  setup writes up one track and then the night fails, the retry rebuilds every
  track it finds and replaces the built one's doc. It costs one night's notes
  today, and more the longer the retry is delayed. The fix is local to
  `run-onboarding.ps1`: decide per track whether it is unbuilt (no
  `role_search_line`, no doc) and give a built one prose only, leaving its doc,
  `documents`, `schedule_time` and `label` alone. No server change. Moot if the
  doc split above ships first.
- **Reset a search, from its block in the account panel.** A search whose rules
  were wrong for weeks carries weeks of wrong results, and there is no way back
  short of an operator deleting rows. Reset empties what the runs put there for
  one search: its leads and its screened rows. It works on a single tab as well as
  on a search that fills several, because a tab is where a mis-scoped rule shows.
  It keeps what the person did: applications stay, since they record what someone
  applied to and not what a search found. **It resets that search's place in the
  company rotation** (`tracks.sweep_cursor`) so the next night starts the list
  again: a reset that left the cursor where it was would sit empty for weeks while
  the search worked round to companies it had already covered. Prompt Bro says
  what else a fresh cycle needs - the per-company sweep records are the other
  thing a night reads.
  It is the most destructive thing the panel would offer, so: a danger-styled
  step that names the search and the counts it is about to delete, confirmed by
  typing the search's name, outside the panel's one Save because it isn't an edit,
  and not undoable - say so rather than implying a trash can. One route of its own,
  never a side effect of another write. Client Comrade and Backend Buddy, with
  Prompt Bro on the rotation.
- **An `attempts` column on `intake`** - the retry bound is a three-day rule on
  `sent_at` today, which is the right stop in the wrong unit. Counting nights is
  one column and one increment, and needs its own migration.

- **Split `db.js`, moving the shared company list into its own module**, ahead of
  any work that touches the company list or coverage. At ~1,850 lines it is the
  file every server feature edits, and it mixes per-person data with the one
  list every account shares.

- **One CLI-failure check for all three runners.** `run-search`, `run-fill` and
  `run-onboarding` each find the CLI and recognise "not logged in" their own way,
  and the wordings have drifted, so a new CLI message can fail the fill silently
  while the searches catch it. Detection becomes one shared helper; what each
  run does about it stays its own. Onboarding stops putting an operator's login
  problem on a person's page: it leaves the intake pending and fails loudly in
  the log. Owner: Prompt Bro, as its own change with a stub-CLI test per wording.

- **Refuse a search whose documents are all unreadable.** The prompt route
  refuses an empty `documents` list, but a list naming only `.docx` passes and
  the run screens on its profile alone. The same readable-format check belongs
  there, in the onboarding run's validation, and in the account panel's picker.
  Owner: Prompt Bro, with Backend Buddy for the route.

- **Show the page 90 days of screened postings, and keep the rest.** The table
  grows about 4,900 rows a year per search - nothing for one person, gigabytes at
  a few hundred - and a rejection a season old is clutter on the tab. So
  `GET /api/data` returns the last 90 days plus a count of what is older, and the
  page says those are kept rather than gone. Nothing is deleted.
  Deleting was the first shape and it is worse: it needed carve-outs for a
  delisting and for hand-added rows, it made "90 days" mean 90 days of active
  searching, and a purged posting still listed would be fetched and screened again
  on a later night. Windowing costs none of that.
  It is safe because no run reads that route: dedupe comes from
  `/api/dedup/<key>`, scoped to tonight's companies and the last few days, and
  every `POST /api/leads` and `/api/screened` is deduped server-side against the
  whole table whatever the caller has seen.
  **The export keeps meaning what it says:** its "everything this tab holds"
  option asks the server for the full set rather than the window, since someone
  exporting to a spreadsheet wants their whole record. Client Comrade owns the
  wording, Backend Buddy the parameter.
  Moving screened rows to a blob store keyed by user and day, so a lifecycle rule
  could expire them, was considered and rejected: dedupe asks "have we ever seen
  this URL?", which is random access over all history, and splitting one live
  dataset across two stores to buy an expiry rule gives up what D1 is for. If
  storage ever binds, archive whole accounts instead. Owner: Backend Buddy.
- **Record which kind of reason screened a posting**, from a fixed list, beside
  the sentence a run already writes. The Screened tab lists what a search set
  aside, and every run stamp now gives both counts, so a thin night reads
  differently from a rule setting everything aside. What can't be answered is
  "what is this rule costing me?": each reason is a sentence about one posting
  and no two are worded alike, so 33 rows in 30 days on one account are read one
  at a time. A stored kind makes them countable, and the grouped artboard of the
  [Screened postings mockup](https://claude.ai/artifact/EfsFEW2tDuUfEeBUAGJUYy)
  is a day's work once it exists. It is a field a run reports, so the column and
  route, `tracker.ps1` and the prompt step go together - Backend Buddy and Prompt
  Bro, then Client Comrade for the grouping.
  The list, from counting every screened row on the five live searches:
  `delisted`, `dead`, `duplicate`, `out-of-scope`, `pay-below-floor`,
  `wrong-level`, `wrong-role`, `contract`, `other`. A third of rows cite two
  reasons, so the run picks by a fixed precedence in that order - first one that
  applies - and the sentence keeps saying everything. `contract` is in from the
  start although no current search excludes contract work, because adding a kind
  later means backfilling again.
  **`delisted` is its own kind, not `dead`:** a posting found already gone was
  never anyone's, while a delisted one was a lead on a person's board and then
  vanished, which is the only screened row that records something lost. It is
  also the row the 30-day purge keeps, so the distinction has to be stored rather
  than inferred from a reason string.
  **The path that can lose a row forgives; the path that can't refuses.**
  `POST /api/screened` stores an unknown kind as `other` and reports the value,
  since refusing loses the only record stopping tomorrow's run re-finding that
  posting. The operator backfill refuses a kind outside the list and writes
  nothing, and writes only rows whose kind is still empty.
  A delisting is stored as `dead` and also carries the exact reason
  `posting taken down`, which `countRunActivity` splits on. Once the backfill has
  run, that split reads the kind and the string stops being load-bearing.

## Worth doing, unscheduled

- **[Split user tokens from machine tokens](token-split-plan.md)** - planned;
  unassigned. Every session token reaches every route today, so a search's
  token on a machine can rewrite config or delete leads.
- **Rate-limit `/api/login` and `/api/signup`.** Both are public and unthrottled;
  password length is the only defence. `server/README.md` says so in its own
  security notes.
- **Tokens never expire.** Revoking means deleting a `sessions` row by hand.
- **A privacy posture for strangers.** Whoever administers the Cloudflare
  account can read every account's rows in D1. Honest for friends; with
  strangers' resumes it needs a retention policy and a deletion path a person
  can invoke themselves. The delete-account route is the operator half of this.
  Nothing deletes a person's rows on a clock today: the screened window hides old
  rows rather than removing them, so a retention promise to a stranger still needs
  its own mechanism, not tied to them still searching.
- **Company discovery as its own nightly job**
  (planned on the unmerged `company-discovery-plan` branch) - searches
  re-evaluate the same companies on the same nights.

## Small

- A stray phrase in `prompt.js` step 3b, "when the named list reads as big
  tech", left over from per-search company lists. Next change that touches
  `prompt.js`.
- Adding or removing a search from the account panel: a new role means a new
  tab, and removing one has leads and applications hanging off it.
  [Splitting a search across tabs](tab-grouping-plan.md) is planned separately,
  and promoting a tab to its own search waits on the track-doc split.
- Show a person the rule their search actually follows, served from `prompt.js`
  rather than copied into the page: the composed pay clause first, since a floor
  is the rule most easily contradicted by their own words. A copy in the page was
  ruled out for being a second wording of one rule.
- The run record counts leads added, screened and swept per day, so two runs
  of one search on the same day are counted together in the nightly run report.

## Watching

- **The first nights without per-search company lists, and with the run queue.**
  Compare companies covered, leads found, run length and queue waits against the
  week before.
- **Whether an empty first morning is normal.** The page now says it is. The one
  run that produced it had an inverted scope, so it is not yet evidence.
- **The shape of a `prompt.js` step.** Each fragment is a named function now, so
  the next step gets written by copying one: a wrong shape spreads on the next
  change rather than sitting still. Product Partner and Prompt Bro read one
  together before the next step is added.
