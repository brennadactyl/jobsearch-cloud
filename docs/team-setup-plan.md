# The team travels with the repo

A clone on any PC can bring up the same set of teammate sessions - each with its
role, its rules and its handoffs - by running one skill. What a teammate knows
about its job lives in the repo, not in one machine's memory.

This adds a root `CLAUDE.md`, one skill per role under `.claude/skills/`, and a
`team-setup` skill that creates the sessions. No code under `server/`, `client/`
or `scripts/` changes.

## Context

The repo already carries the engineering skills (`add-api-route`,
`verify-and-deploy` and the rest) and the hook that blocks writes to the live
database. The team does not travel. Each role, and every rule the team has
agreed - deterministic code over prompts, comments that explain why, how plans
are written, squash merges, a go counting only in the session doing the work -
is a memory file on one PC. Two roles, Backend Buddy and Prompt Bro, were never
written down at all.

The repo is public, so everything added here is rules and roles only: no
account ids, tokens, passwords or anyone's search details.

## `CLAUDE.md`: the rules every session follows

Loaded by every session in the repo, whatever its role. It holds the team rules
that are true of the codebase and the way this team works:

- Deterministic code over prompts: never leave to a model what a comparison, a
  table or a check can decide.
- Comments and docs give the why; no history in them.
- Plans state the design, give each section its context, and don't argue.
- Merge a PR with `--squash` and a hand-written title and body; docs and small
  changes can go straight to main.
- A push, deploy or live write needs the user's go typed in the session doing
  it; a go passed along by another session doesn't count.
- Times in US Pacific; date-only fields printed as they arrive.
- An unused function may be a feature dropped by accident: ask the product
  session before deleting it.
- A fixed mapping only governs new setups: ask who is living with the old one.
- Scripts ship through the main checkout; production reads go to the latest
  local backup.
- Who owns what, as a table of the roles below, so any session knows where to
  send a finding.

Each rule becomes one or two lines. The memory files it replaces are deleted
once `CLAUDE.md` merges, so the rule has one home.

## One skill per role

`.claude/skills/role-<name>/SKILL.md`, triggered by "you are <name>". Loading it
is how a session becomes that teammate.

| Skill | Role | Owns |
|---|---|---|
| `role-product-partner` | Product manager | direction, `docs/backlog.md`, plans, run-health evidence |
| `role-backend-buddy` | Server | `server/`, migrations, routes, server deploys |
| `role-client-comrade` | Tracker page | `client/`, mockups, client deploys |
| `role-prompt-bro` | Nightly runs | `server/src/prompt.js`, `scripts/` runners, track configs and docs |
| `role-fullstack-friend` | Small end-to-end work | operator scripts, end-to-end tests with the user |
| `role-clean-code-companion` | Readability | behaviour-preserving refactors |
| `role-documentation-dude` | Docs | `docs/` reference docs, READMEs, skills' wording |

Every role skill has the same sections, so they read alike:

- **Owns** - the files and decisions that are this role's.
- **Doesn't own** - what it hands to whom, by role name.
- **Gates** - what needs the user's go in this session.
- **How it works** - the checks it runs before calling something done, and what
  it reports to the product session.
- **Starting fresh** - what to read first on a new machine: the backlog, open
  plans, `git log`, open PRs.

Each role's skill is reviewed by the session that holds that role today before
it merges, so it describes the job as it is actually done.

## `team-setup`: creating the teammates

`.claude/skills/team-setup/SKILL.md`, triggered by "set up the team". It brings
up every role that isn't already running, and changes nothing about one that is.

1. **Checks the machine first**, and stops with a list of what's missing rather
   than half-creating the team: the repo is a git checkout with an `origin`,
   `claude` is authenticated, and - only if this machine will run the nightly
   searches - the `private\` folder is present.
2. **Lists existing sessions** and skips any role whose title already exists.
3. **For each missing role**, when the app offers a tool to start a session: a
   new session in its own worktree, titled with the role name, pinned, and
   started with the message "You are <role name>." When the app offers no such
   tool, it prints the same, per role, as the exact title and first message to
   paste, in the same order.
4. **Offers Remote Control** for each session it created, and turns it on only
   when the user says yes.
5. **Reports** each role as created, already running, or needing a manual start.

Titles are the role names in the table, spelled exactly, because that is how
the skill recognises a teammate that already exists.

## What stays on one machine

- **`private\`** - account tokens, `deployment.json` and the admin token. Copied
  by hand, never committed. `private.example/README.md` already describes it.
- **The nightly scheduled tasks.** They run on one machine only. Two machines
  running them would run every search twice and race each other writing the
  same search docs. `team-setup` never registers tasks; `setup-scheduler.ps1`
  stays a deliberate step, and its README section says to run it on one PC.
- **Session history.** Teammates on a new PC start from the role skills, the
  plans, the backlog and git history, not from another machine's transcripts.
- **Personal memory** - the demo account's password and similar - stays in the
  machine's own memory folder.

## Order of work

1. `CLAUDE.md` and the seven role skills, written by the documentation session,
   each role reviewed by its current holder.
2. `team-setup`, once the role names and titles are fixed.
3. The memory files now covered by `CLAUDE.md` or a role skill are deleted from
   this machine's memory folder.
4. A test on a second PC: clone, copy nothing but `private\` if it will run
   searches, run `team-setup`, and check each teammate loads its role.
