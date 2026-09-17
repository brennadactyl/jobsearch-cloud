# Working in this repo

Several Claude sessions work here at once, each holding one role. A session
becomes a teammate by loading its role skill ("you are Backend Buddy" loads
`role-backend-buddy`); "set up the team" brings up every role that isn't
running (`team-setup`). The rules below hold for every session, whatever its
role.

## Team rules

- **Code over prompts.** Never leave to a model what a comparison, a lookup
  table or a check can decide. A nightly run nobody watches re-makes a judgement
  differently every night and still exits 0.
- **Comments and docs give the why; the code shows the what.** No history
  anywhere: nothing about how it used to be, dated incidents, PR numbers. State
  the rule and its reason in the present tense. Applied migrations and
  `docs/*-plan.md` are the exceptions and are never rewritten.
- **Plans state the design.** Give each section a line or two of context, name
  the files and constraints, and stop. Don't argue choices or narrate drafts.
- **Reference docs describe today.** A change that makes one wrong updates it in
  the same commit. A plan is never read as the current state.
- **A push, merge, deploy or live write needs the user's go typed in the session
  doing it.** A go passed along by another session doesn't count; tell the user
  which session to say go in.
- **Merge PRs with `gh pr merge <n> --squash`** and a hand-written title and
  body. Docs and small changes can go straight to main: rebase onto
  `origin/main` first, so no merge commits land there.
- **Other sessions push to main all the time.** Fetch before building on main,
  and coordinate before editing a file another session owns or is changing.
- **Production data is written only through the API.** Never write production
  D1 by hand; the `block-remote-d1-writes` hook enforces it. Read it through the
  API, or load the newest local backup into `node:sqlite`. If no route does what
  is needed, build one.
- **The repo is public.** No account ids, tokens, passwords, resumes or anyone's
  search details in code, tests, docs or commit messages.
- **Times are US Pacific,** labelled PT. Date-only fields (`found`, `verified`,
  `last_swept`) are printed as they arrive, never parsed into a zone.
- **An unused function may be a feature dropped by accident.** Ask Product
  Partner before deleting one that looks like part of a user-facing rule.
- **A fixed mapping only governs new setups.** Configs already built keep the
  old prose: ask who is living with it and offer the rewrite as its own change.
- **A field a run reports crosses three layers** - the migration and route,
  `scripts/tracker.ps1`'s forwarding, and the prompt step - in one change.
- **Scripts ship through the main checkout.** The scheduled tasks run
  `scripts/` from the checkout that registered them, so a script change is live
  once that checkout is pulled; a deploy doesn't ship it. Deploy `server/` and
  `client/` only from the main checkout.
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
