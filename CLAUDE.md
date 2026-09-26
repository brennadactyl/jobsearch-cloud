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
- **Every change goes through a PR, however small** - code, skills, `CLAUDE.md`.
  Branch, rebase onto `origin/main` so no merge commit lands, and open
  the PR with a hand-written title and body saying what it does and what you
  checked. On her go it is merged with `gh pr merge <n> --squash` and a
  hand-written subject and body, never GitHub's default list of commits; the
  repo allows only squash merges and deletes a branch once merged. Nothing else
  goes straight to main.
- **`docs/**` is the exception,** and goes straight to main with no PR and no
  approval: the reference docs, the plans and the backlog alike. Nothing under
  `docs/` is executed - no run reads it, and no teammate follows it as an
  instruction - so a wrong line there misleads a reader who can check, while a
  wrong line in `CLAUDE.md` or a skill is followed. That is what makes those
  two different, and why they take two reviewers. The exception is `docs/`
  alone: another path wanting the same treatment is a change to this rule, not
  an application of it. Where a doc has a check, the author runs it and says so
  in the commit - `server/verify-schema-doc.mjs` for `docs/schema.md`,
  `tools/docs/check-links.mjs` for every link. What made review worth having
  there was the check, not the second reader.
- **Who reviews: the area's owner,** or Fullstack Friend when the owner is the
  author, or Product Partner when that fails too. One reviewer. `CLAUDE.md` and
  anything under `.claude/` take two, because a wrong line there is followed
  rather than read, and they wait for both however long that takes. Push a
  branch freely: the gate is the merge, not the push.
- **Changes to `CLAUDE.md` and the skills are collected and go as one PR,**
  unless something in them is wrong now. A rule PR costs two readers and a
  round of fixes, and rules written separately contradict each other in ways
  one diff would have shown.
- **A review reads the diff and says something specific,** in about three
  lines. Run the checks the change claims to pass and say what they printed,
  name each finding blocking or not, and approve explicitly. "LGTM" is not a
  review, and neither is approving a diff nobody read. Nobody approves their
  own PR, and a PR goes to the user for merging once its approval is in.
  Findings go once: the author fixes them and takes it to her, and the reviewer
  reads again only if it named something blocking.
- **An approval is a comment on the PR** naming the reviewer's role, the
  verdict and what it ran. Every session pushes as the same GitHub account, so
  `gh pr review --approve` and `--request-changes` are refused on our own PRs:
  whether the approval is in is ours to honour, not GitHub's to enforce. Don't
  go looking for a button. The PR body says what the change does and what the
  author checked.
- **A broken nightly run is the one exception:** its fix goes to the user
  unreviewed. The PR names the failed run - its date and what it reported - so
  "broken" is evidence rather than the author's word, and the reviewer reads it
  afterwards. The short path defers a review; it doesn't skip one.
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
  calls it unmerged, and a diff against main shows every change main has taken
  since, merged or not. Neither says whether the branch's work landed: git is
  answering "is this commit an ancestor", correctly, and the squash is what
  makes that the wrong question. Clearing local branches goes in this order:
  `git rev-list --count origin/main..<branch>` of 0 means the branch holds
  nothing main lacks, so delete it; non-zero but the name is in
  `gh pr list --state merged --limit 300 --json headRefName` means the work
  landed as a squash, so delete it; non-zero with no merged PR means read it
  before deciding, because that bucket holds unmerged work, closed PRs and
  branches nobody opened one for, and from outside they look alike. Pass
  `--limit 300`: the default is 30, which reads as though every older branch
  never merged. A name can be used twice, so that list says a name merged, not
  that this branch did - for a branch you didn't just create, check its last
  commit is older than that PR's `mergedAt` before deleting. Skip anything
  `git branch --list` marks `+`, which another worktree has checked out.
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
