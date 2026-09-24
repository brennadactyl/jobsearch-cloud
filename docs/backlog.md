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

- **Somewhere to read what a search screened out, and why.** Every rule-out is
  stored with its reason and `GET /api/data` already sends them, but the page
  only counts them: no list shows what a night dropped. So a quiet morning can't
  be told from a rule that is screening out everything, which is the question
  behind most "why did it find nothing?" - and it is what makes a pay floor,
  or any rule a person writes, something they can check rather than trust.
  Screens: [Screened postings mockup](https://claude.ai/artifact/EfsFEW2tDuUfEeBUAGJUYy).
  Its first artboard needs nothing new stored. The grouped one needs the run to
  write which kind of reason it was, from a fixed list, beside the sentence it
  already writes: no two reasons are worded alike, so nothing can group them
  without guessing at the words.
  Owner: Client Comrade.

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
