# Working in this repo

Several Claude sessions work here at once, each holding one role. A session
becomes a teammate by loading its role skill ("you are Backend Buddy" loads
`role-backend-buddy`); "set up the team" brings up every role that isn't
running (`team-setup`). The rules below hold for every session, whatever its
role.

## Team rules

- **Code over prompts.** Never leave to a model what a comparison, a lookup
  table or a check can decide. A nightly run nobody watches re-makes a judgement
  differently every night and still exits 0. A model decides content - the
  prose it writes - and nothing about storage, transport or control flow.
- **Comments and docs give the why; the code shows the what.** No history
  anywhere: nothing about how it used to be, dated incidents, PR numbers. State
  the rule and its reason in the present tense. Applied migrations and
  `docs/*-plan.md` are the exceptions and are never rewritten.
- **Plans state the design.** Give each section a line or two of context, name
  the files and constraints, and stop. Don't argue choices or narrate drafts;
  keep an explanation only where it prevents a wrong build, as a one-line
  directive. What isn't being done gets a few lines at the end at most. Write
  things readably: a route as `/api/documents/<path>`, not its regex.
- **Reference docs describe today.** A change that makes one wrong updates it in
  the same commit. A plan is never read as the current state.
- **A merge, a deploy, a pull of the main checkout or a live data write needs
  the user's go typed in the session doing it.** A go passed along by another
  session doesn't count; tell the user which session to say go in. Reviews
  approve a PR; her go is what merges it. The pull is in that list because it
  is what ships `scripts/`: merging one and pulling it are two goes, not one.
- **Every change goes through a PR, however small** - code, docs, plans,
  skills. Branch, rebase onto `origin/main` so no merge commit lands, and open
  the PR with a hand-written title and body saying what it does and what you
  checked. On her go it is merged with `gh pr merge <n> --squash` and a
  hand-written subject and body, never GitHub's default list of commits; the
  repo allows only squash merges and deletes a branch once merged. Nothing else
  goes straight to main.
- **`docs/backlog.md` is the exception,** and the product session pushes it
  straight to main, with no PR and no approval. It is a running list of intent,
  owned by one session, that changes several times a day and that nothing
  executes: no run reads it, and no teammate follows it as an instruction,
  though every session reads it when starting fresh. A wrong line there
  misleads a reader who can check; a wrong line in `CLAUDE.md` or a skill is
  followed. That is what makes it unlike those, which wait for the full set
  of reviewers however long that takes. The exception is the backlog alone - a
  plan is a PR like anything else, and another file wanting the same treatment
  is a change to this rule, not an application of it.
- **Who reviews:** Clean Code Companion, Documentation Dude and Fullstack
  Friend on every PR, plus the area's owner when they aren't the author, plus
  anyone whose area the change reaches - a prompt or runner change wants Prompt
  Bro, a client change Client Comrade. Fullstack Friend works across every area
  and sees the operator-side consequence the area's owner doesn't. An author is
  never one of their own required reviewers: when one of the three writes the
  PR, the area's owner takes that slot, and when the author is the area's owner
  too, Product Partner takes it - it owns no code area, so it is always free to
  stand in, and the count stays at three readers.
- **When a required reviewer's session isn't running,** say so in the PR and
  wait for it if the change can wait. If it can't, the remaining required
  reviewers may approve, and the PR names who was missing and why it couldn't
  wait. The absent reviewer reads it afterwards, and anything they find is an
  ordinary follow-up PR. This never applies to `CLAUDE.md` or anything under
  `.claude/`, which wait for the full set however long that takes. Push a
  branch freely: the gate is the merge, not the push.
- **A review reads the diff and says something specific.** Run the checks the
  change claims to pass and say what they printed, name each finding blocking
  or not, and approve explicitly. "LGTM" is not a review, and neither is
  approving a diff nobody read. Nobody approves their own PR, and a PR goes to
  the user for merging only once the required approvals are in.
- **An approval is a comment on the PR** naming the reviewer's role, the
  verdict and what it ran. Every session pushes as the same GitHub account, so
  `gh pr review --approve` and `--request-changes` are refused on our own PRs:
  whether the approvals are in is ours to honour, not GitHub's to enforce.
  Don't go looking for a button. The PR body carries a checklist of who has
  reviewed and what they ran, kept current as reviews land, because with no
  approve state to read it is the only place a PR's state is legible.
- **A broken nightly run is the one exception:** its fix goes to the user with
  whichever approvals it has. The PR names the failed run - its date and what
  it reported - so "broken" is evidence rather than the author's word, and the
  reviewers who hadn't read it read it afterwards. The short path defers a
  review; it doesn't skip one.
- **A merge is not a ship.** A merge puts a change on main; a deploy is what
  makes it live. So a merged `server/` or `prompt.js` change can sit on main
  reaching no nightly run, and a merged `client/` change can sit unseen.
  `scripts/` goes the other way: it is live the moment the main checkout is
  pulled, with no deploy at all. The session that merges says which of the
  three a change is in, and "shipped" means deployed - or pulled, for a script
  - never merged.
- **Other sessions push to main all the time.** Fetch before building on main,
  and coordinate before editing a file another session owns or is changing. A
  soft reset onto a moved `origin/main` reverts their commits: rebase instead,
  and read `git show --stat` before pushing.
- **A squash-merged branch keeps its original commits,** so `git branch -d`
  calls it unmerged and a diff against main shows every change since. Neither
  says whether its work landed:
  `gh pr list --state merged --json headRefName` does. A branch whose name is
  in that list is merged work; anything else is unmerged, an open PR, or a
  branch that never had one, and is looked at on its own.
- **Production data is written only through the API.** Never write production
  D1 by hand; the `block-remote-d1-writes` hook enforces it. Read it through the
  API, or load the newest local backup into `node:sqlite`; note the backup's
  time, since anything written after it is missing, and take a fresh backup when
  the answer must be current. If no route does what is needed, build one.
- **A maintenance pass reads the complete view, never the one the page reads.**
  A route built for a person's page answers the page's question, not "what is
  in the table", and which question it answers can change. A one-off backfill or
  audit built on one works from whatever the page happens to show that week, and
  reports a correct-looking count of the rows it never saw. Today
  `GET /api/data` is one: its screened rows answer "was this ever a posting of
  theirs?", within a window, while `?screened=all` asks what is in the table.
  Ask each route for everything it can serve, or read a backup, write down what
  each answer held, and stop when a count moves between two reads - that is the
  view moving, and the saved count is what tells it from the data.
- **The repo is public,** and a PR description, a commit message and a review
  comment are part of it. No account ids, tokens, passwords, resumes or
  anyone's search details in code, tests, docs, commit messages or PRs - and no
  real data from a real account either: counts, totals, row numbers, the
  companies a search covers. No narrating a person's reactions or instructions,
  which a public PR is not the place for: say what the change does and why the
  rule is what it is. A review is where the temptation is highest, because a
  reviewer wants to show they checked against something real; say what you
  checked and what held, without the rows.
- **Times are US Pacific,** labelled PT, and the system stays on Pacific: runs
  stamp their local date. Don't propose a switch to server-side UTC without a
  new reason. Date-only fields (`found`, `verified`, `last_swept`,
  `last_run.on`) are printed as they arrive: a bare date has no instant, and
  converting it shifts it a day back west of UTC. `last_run.at` is the one
  instant; show it relative or with `toLocaleString()`.
- **An unused function may be a feature dropped by accident.** Ask Product
  Partner before deleting one that looks like part of a user-facing rule.
- **A fixed mapping only governs new setups.** Configs already built keep the
  old prose: ask who is living with it and offer the rewrite as its own change.
- **A field a run reports crosses three layers** - the migration and route,
  `scripts/tracker.ps1`'s forwarding, and the prompt step - in one change. Miss
  one and nothing errors; the value just never arrives. The layers are Backend
  Buddy's and Prompt Bro's, so hand off explicitly, and check a real run's value
  lands in the row.
- **Scripts ship through the main checkout.** The scheduled tasks run
  `scripts/` from the checkout that registered them, so a script change is live
  once that checkout is pulled; a deploy doesn't ship it. Deploy `server/` and
  `client/` only from the main checkout.
- **Edit repo files with the Edit and Write tools,** not shell heredocs or
  `node -e` patches, which mangle quoting and escapes. Write a throwaway script
  with Write too, and normalise CRLF before a scripted text replace: the working
  copy has CRLF line endings.
- **Don't tell a teammate something is verified until it has actually run.**
- **Run `git push` on its own,** not chained with other commands; the
  permission check refuses a chained push.
- **The in-app browser pane reads the page as hidden.** TanStack Query pauses
  retries and `requestAnimationFrame` never fires there, so a live check can
  hang; `role-client-comrade` has the workarounds.
- **In PowerShell use `npm.cmd` and `npx.cmd`.** Execution policy can block the
  `.ps1` shims for the user even when they work in an agent's shell.

## Who owns what

Send a finding to the owner rather than fixing it in someone else's area.

| Role | Owns |
|---|---|
| Product Partner | product direction, `docs/backlog.md`, plans, run-health evidence, "is this unused code a dropped feature?" |
| Backend Buddy | `server/` except `prompt.js`: routes, `db.js`, `companies.js`, `r2.js`, migrations, admin routes for operator data fixes, `docs/schema.md`, `server/README.md`'s route reference, the server verifiers, server deploys; the backup scripts, with Fullstack Friend |
| Client Comrade | `client/`: the tracker page, mockups, client tests, `client/README.md`, the `edit-tracker-page` skill, client deploys, and reviews client changes from other sessions |
| Prompt Bro | the nightly runs: `server/src/prompt.js`, `scripts/tracker.ps1`, the runners, every search's stored config and track doc, and the `change-search-prompt`, `job-search-setup` and `add-target-company` skills |
| Fullstack Friend | small end-to-end features, fixes and refactors found in review (the area's owner reviews), operator scripts (`new-invite`, `setup-scheduler`, `import-documents`), the backup scripts with Backend Buddy, live end-to-end tests |
| Clean Code Companion | readability: behaviour-preserving refactors and code comments |
| Documentation Dude | reference docs in `docs/`, the root README, `private.example/`, `CLAUDE.md`, the `role-*` and `team-setup` skills, and checking any doc or skill against the code |
