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

- **[An operator's dashboard](admin-dashboard-plan.md)** - run health across
  every account, who exists and what state their setup is in, the shared company
  list, and the actions that are scripts today, minting an invite first among
  them. An operator signs in as themselves, with a flag on the account; the
  admin token stays the machine's. Planned, unbuilt.
- **Removing an application should put its lead back.** Marking a lead
  **Applied** sets the lead's status to Applied and creates the application,
  which keeps a `leadId` pointing home. Deleting that application deletes only
  the application row, so the lead is left at Applied with nothing it belongs
  to: not on the Open chip, which is New and Reviewing; not in Applications;
  visible only under **All** on its own tab. Someone who moves a lead across by
  mistake and undoes it has no way back that they would think to look for, and
  the row reads as lost.
  The return trip needs nothing new - the application already carries the
  `leadId`, and the lead row was never deleted. Deleting an application whose
  `leadId` resolves sets that lead back to an open status, and **Reviewing** is
  the honest one: the person has handled this row, so claiming nobody has looked
  at it would be false and would put it back in the tab's badge, which counts
  only what is untouched. An application with no `leadId`, or one whose lead no
  longer resolves, is deleted as it is today. Worth doing as its own small
  change rather than waiting for a bigger one: the stranding happens on every
  removal, not only a mistaken one.
- **A setup answer can land in the wrong field and nothing says so.** One
  signup's answer to the work-scope question held seven company names, which
  were stored as places, so the night was told to search "at Amazon" as though
  it were a city. Nothing refused it and nothing warned; it surfaced only because
  someone read the composed step. Two halves: the form asks in a way that invites
  the wrong answer, and nothing shows a person the sentence their answers
  compose. The second is the general fix, and it is the same one the pay floor
  wanted - the page shows the composed step a run reads, served from `prompt.js`
  rather than restated.
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
- **Retype the lists a comma already split**, once the page can store one. The
  three location lists are becoming JSON arrays of entries, so from then on
  "Vancouver, BC" is one place; that is being built and is not this item. What
  it cannot do is recover a list already stored. The split happened on the way
  in and took the information with it: "Vancouver" and "BC" are two entries now,
  and nothing downstream can tell a separator from part of a name after the
  fact. Guessing is the one way the change could lose something, so the
  conversion deliberately stores each list as the entries it already reads as
  and nothing more.
  So each affected list is retyped by the person whose list it is, through the
  account page - **after the client half is live, not alongside it**, since
  until then the page has no way to put a comma inside one entry.
  The scope is small. In the 2026-10-06 backup, 21 lists are stored across every
  account; one entry is unmistakably an orphan - a bare region code sitting
  after another entry - and three more are region names that may be exactly what
  their owner meant, since a list like "Portland OR, Texas" is ordinary. So at
  most three lists on two accounts, and only their owners can say which. Bare
  country entries are not in that count: a list that is just "US" is a
  whole-country search, not a split.
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
  the search worked round to companies it had already covered.
  **It deletes that search's `company_sweeps` rows too** - about 190 per search
  today, each a dated note on one company in the run's own words. They are
  knowledge, but knowledge reached under the rules being reset: a note saying a
  company's roles are all out of scope was written against the locations or the
  level that are about to change. So a reset forgets them, and the next cycle
  re-reads every company, which is the cost being bought deliberately. The shared
  company list (`company_fetch`) is untouched: how to fetch a company is a fact
  about the company, not about one search.
  It is the most destructive thing the panel would offer, so: a danger-styled
  step that names the search and the counts it is about to delete, confirmed by
  typing the search's name, outside the panel's one Save because it isn't an edit,
  and not undoable - say so rather than implying a trash can. One route of its own,
  never a side effect of another write. Client Comrade and Backend Buddy, with
  Prompt Bro on the rotation.
- **An `attempts` column on `intake`** - the retry bound is a three-day rule on
  `sent_at` today, which is the right stop in the wrong unit. Counting nights is
  one column and one increment, and needs its own migration.

- **`db.js` is 1,900 lines**, and every server feature edits it. The shared
  company list already moved to `companies.js`; what is left is one file holding
  every table's access. Worth splitting the next time something large lands in
  it, rather than as a change of its own.

- **Refuse a search whose documents are all unreadable.** The prompt route
  refuses an empty `documents` list, but a list naming only `.docx` passes and
  the run screens on its profile alone. The same readable-format check belongs
  there, in the onboarding run's validation, and in the account panel's picker.
  Owner: Prompt Bro, with Backend Buddy for the route.


## Worth doing, unscheduled

- **[Split user tokens from machine tokens](token-split-plan.md)** - planned;
  unassigned. Every session token reaches every route today, so a search's
  token on a machine can rewrite config or delete leads.
- **Rate-limit `/api/login` and `/api/signup`.** Both are public and unthrottled;
  password length is the only defence. `server/README.md` says so in its own
  security notes.
- **Tokens never expire.** Revoking means deleting a `sessions` row by hand.
- **"Download all my data", in My account.** One action that hands a person
  everything the service holds about them: their settings and every search's
  configuration, their leads, applications and screened rows whatever their age,
  their run history, and the documents they uploaded. It belongs beside the
  password and the rest of the account, not on a tab, because it is about the
  account rather than about one search. `?screened=all` already answers for the
  rows the page's window hides; the rest is deciding the shape of the file - one
  archive, or a JSON file plus the documents - and whether it is built on the
  spot or prepared and offered as a download. It is also half of the privacy
  posture below, the half a person invokes themselves.
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

- `users.demo` is declared `INTEGER` and `users.admin` `BOOLEAN`, two spellings
  for the same two values sitting next to each other in one table, which
  `docs/schema.md` then has to show differently while calling them the same.
  SQLite stores both identically, so this is legibility, not correctness - and
  the fix is a table rebuild, since an applied migration is never rewritten and
  a column's declared type can't be altered in place. Worth doing when `users`
  is being rebuilt for another reason, or deliberately with
  `verify-migration.mjs` covering it; not the quick win it looks.
- The page's `--good` and `--crit` are a red and green four ΔE apart under
  deuteranopia, so a reader with it can't separate them. Fine wherever colour
  sits beside an icon and words, which is most of the page; the work is finding
  where colour carries the meaning alone and giving it a second signal. Found by
  the palette validator; Client Comrade's.
- A stray phrase in `prompt.js` step 3b, "when the named list reads as big
  tech", left over from per-search company lists. Next change that touches
  `prompt.js`, along with a line saying why step 7(c)'s fixed "wrong level"
  stays even when a track's own rule repeats it.
- A script for querying the newest backup, so reading production doesn't mean
  writing a one-off node script each time. The rest of the team-tools work -
  the proof tools under `tools/`, the role and procedure skills, the run report -
  has shipped.
- Adding or removing a search from the account panel: a new role means a new
  tab, and removing one has leads and applications hanging off it.
  [Splitting a search across tabs](tab-grouping-plan.md) is planned separately,
  and promoting a tab to its own search waits on the track-doc split.
- Show a person the rule their search actually follows, served from `prompt.js`
  rather than copied into the page: the composed pay clause first, since a floor
  is the rule most easily contradicted by their own words. A copy in the page was
  ruled out for being a second wording of one rule. Now also the fix for an
  answer landing in the wrong field, above.
- The Screened tab's "today" is the newest run's day, so it moves when the
  search in view changes: a search whose task has stopped shows its own last
  day, and clicking back to all searches can read 0 one click after reading 4.
  Each view counts one window correctly and the page names neither day. The
  honest fix is naming the day instead of saying "today", which was decided
  against twice in favour of the plain word, so this is evidence held rather
  than a request to reopen - the instance that reopens it is someone actually
  confused by it.
- The page decides whether removed postings can be counted by checking whether
  any screened row carries a `found` value, so a change in what the server sends
  can leave the flag reading true over incomplete data. The server should say
  whether it counts them rather than the page inferring it.
- The run record counts leads added, screened and swept per day, so two runs
  of one search on the same day are counted together in the nightly run report.

## Watching

- **What a search's own rules cost it, now that every rejection carries a kind.**
  A month of counts per kind per search is the first evidence of whether a rule
  is set where its person thinks it is.
- **Whether an empty first morning is normal.** The page now says it is. The one
  run that produced it had an inverted scope, so it is not yet evidence.
- **The shape of a `prompt.js` step.** Each fragment is a named function now, so
  the next step gets written by copying one: a wrong shape spreads on the next
  change rather than sitting still. Product Partner and Prompt Bro read one
  together before the next step is added.
