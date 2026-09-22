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
- **[Account settings](account-settings-plan.md), the rest** - the resume and
  locations sections and "My account" are live. Still to build: editing the page
  title, pronouns, excluded companies and search names, and the setup answers
  the night turns into prose. Needs its own mockup pass first.
- **"Don't show me this company again", from a lead.** Ruling a company out
  means typing its name in settings today, at the moment the person is looking
  straight at it on a job. One action on the row adds it to
  `excluded_companies`, which the server matcher and the prompt already read, so
  no run brings it back. What the action does to leads already found from that
  company, and whether it covers one search or all of them, is the design
  question; the person should be told what it did and be able to undo it.
- **An `attempts` column on `intake`** - the retry bound is a three-day rule on
  `sent_at` today, which is the right stop in the wrong unit. Counting nights is
  one column and one increment, and needs its own migration.

- **Recover a failed setup.** A setup that fails on its own answers - a resume
  that turns out unreadable - has no way forward today: the form is one-shot, so
  the person cannot do what the failure note asks. [Account
  settings](account-settings-plan.md) is the fix; until it ships the notes say
  to ask whoever invited them.
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
