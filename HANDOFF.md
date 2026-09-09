# Handoff: turning this into a hosted service

**Status: handoff, not a finished plan.** The fork is done and verified. The
productization design was interrupted during exploration — the runner approach below
is a *hypothesis*, not a validated design. See "Not yet researched".

Delete this file once its contents have been absorbed into real issues or docs.

---

## ⚠️ This repo owns the live deployment

Not a copy of it, not a staging twin — **the running tracker**. That was a deliberate
choice over standing up a second deployment beside it, and it changes how everything
below should be read.

- `server/wrangler.toml` → `job-search-tracker`, D1 `104f139f-…` (the live database)
- `client/wrangler.toml` → `job-search-tracker-client`

The names are load-bearing. `wrangler deploy` does not rename a worker: a changed
`name` publishes a *new* worker on a *new* URL and leaves the old one serving.
Renaming would have stranded every bookmark, `client/public/local-config.js`, and the
scheduled runner on the old origin while this repo talked to an empty copy. Taking
over a deployment means keeping its identifiers, not changing them.

**Before the first deploy from here, main had to catch up.** The mirror was cut at
`d6ee5f2`; `JobSearchTracker` merged PR #19 afterwards, so the *running* client had a
"Signed in as …" password-change flow this repo had never had on main — it was sitting
unmerged on `claude/signed-in-as-opens-password`. Deploying without that merge would
have been a silent rollback of a live feature. `server/src`, `server/migrations` and
`client/public` are now byte-identical to the deployed code. **Any future divergence
between the two repos must be reconciled the same way, in this direction, before a
deploy.**

`client/public/local-config.js` (gitignored, holds the live API origin) has been placed
in the main checkout. It is still absent from every worktree, by design —
`client/predeploy-check.mjs` refuses a client deploy without it, because `[assets]`
replaces the live file list wholesale, so a missing file is a *deleted* file.

### What this costs, and it is not small

`npm run deploy` from here begins with `wrangler d1 migrations apply DB --remote`
against real users' data. The `block-remote-d1-writes` hook does **not** cover that —
it permits `migrations apply` on purpose, reasoning that schema changes have their own
reviewed path. So an unfinished migration in this tree is one command from production,
and the productization work below is *made of* schema changes. Run
`verify-migration.mjs` and take a `wrangler d1 export` first, every time.

The hook is otherwise now wired in properly, and travels: committed
`.claude/settings.json` pointing at
`$CLAUDE_PROJECT_DIR/.claude/hooks/block-remote-d1-writes.mjs`, so it applies in every
clone and worktree. It previously did not run here at all — its only configuration
lived in the *old repo's* `.claude/settings.local.json` at `C:/VibeCoding`, which never
bound sessions started in this folder.

### Still open

The repos were reorganised on 2026-09-09: the personal tracker, which used to sit
directly at `C:/VibeCoding`, now lives at `C:/VibeCoding/job-search-tracker/`, and
`jobsearch-cloud` is its sibling rather than a folder nested inside its working tree.
Paths in older notes predate that.

- **The old repo can still deploy to these same resources.** `job-search-tracker/`
  has an unchanged `wrangler.toml` naming the same worker and the same D1. Two repos
  able to publish to one deployment, with histories that have already diverged once,
  is the next thing to close. Left alone deliberately — it is a public template whose
  README documents deploying it, so removing its wrangler config would break it for
  anyone forking. Blanking its `database_id` is the cheaper move if it comes up again;
  that would also get the live database id out of a public repo.
- **The runner has not moved.** Windows Task Scheduler still invokes
  `job-search-tracker/scripts/` against `job-search-tracker/private/`. The deployment
  moved; the thing that feeds it nightly did not.
- **Path-anchored guards are the thing the move kept breaking.** Two were found dead
  in this repo afterwards, both silent: the hook's rule protecting `private/` stopped
  matching once the silo gained a path segment, and the hook's own test harness had
  the pre-move absolute path hardcoded, so it spawned nothing and reported every case
  as allowed. Both are fixed, and the suite now exits non-zero rather than only
  printing. Worth suspecting the same failure mode anywhere else a literal path was
  written down.

---

## How this repo came to exist

Mirror push from `brennadactyl/JobSearchTracker`, not a GitHub fork. That repo is
public, and GitHub does not allow changing a fork's visibility, so a true fork could
never be private. A fork would also default PRs to upstream, which with a
branch-per-session workflow means `claude/*` PRs quietly opening against the personal
repo. The mirror gives identical history with neither problem.

Verified parity: 195 commits on `main`, tip SHA `d6ee5f2`, identical to upstream. All
7 branches carried. Three were **not merged into main** and hold unique work:
`claude/improved-user-onboarding-b07a78`, `claude/jeff-onboarding-4334d0`,
`claude/signed-in-as-opens-password`. No tags.

`JobSearchTracker` itself is untouched and is to be left that way.

Commit `0900180` added five contributor skills to `.claude/skills/`, joining the
existing `job-search-setup`:

| Skill | Covers |
|---|---|
| `verify-and-deploy` | free-port dev worker, the two verifiers, per-half deploys, never from a worktree |
| `add-api-route` | the two route lists, `http.js`/`Db` rules, isolation checks owed to `verify-local.mjs` |
| `add-d1-migration` | numbered migrations, prose-over-DDL comments, backup before `--remote` |
| `edit-tracker-page` | ES5-only house style, `esc()`/`safeUrl()`, `state`→`render()`, config-driven tabs |
| `change-search-prompt` | the three surfaces + reconciling sibling track docs — **shelf life: describes the runner being replaced** |

---

## The gap

Target: **hosted service with sign-up.**

**What survives.** `server/` and `client/` are in better shape than expected. Per-row
`user_id`, a `Db` bound to one user at construction (so no query *can* forget to
filter), config-in-D1 rather than baked into the client, and ~170 cross-user isolation
checks in `verify-local.mjs`. That is the expensive part of a multi-tenant backend and
it is already done.

**The runner must be replaced, not ported.** Today: Windows Task Scheduler → `claude`
CLI with a personal `CLAUDE_CODE_OAUTH_TOKEN` → multi-minute agentic run with many web
fetches. Users' `schedule_time` values are staggered *because they share one CLI*.
Tool allowlist is `Read Write Edit Glob Grep WebSearch WebFetch Bash`
(`scripts/run-search.ps1`). This does not scale to sign-ups, and its replacement
determines cost-per-user-night, which determines the pricing model.

**The privacy posture must change.** `server/README.md` states plainly that whoever
administers the Cloudflare account can read any user's rows directly in D1, and that
this is "for people who are fine with that." Honest for friends; with strangers'
resumes it becomes a privacy policy, a retention policy, and a deletion path.

**Auth was built for people who know each other.** No sign-up page (accounts minted
with `ADMIN_TOKEN` over curl), tokens never expire, `/api/login` has no rate limiting —
flagged in the README's own security notes.

**`private/` must move into storage.** Resumes (`.docx`) and the per-track baseline doc
`private/<user-id>/docs/tracked_<key>_postings.md` live on disk. The track doc is
*edited by the run as it goes*, so it needs a real read-write home (R2 or D1), not a copy.

---

## Runner hypothesis (NOT yet validated)

A Cloudflare **Workflow** driven by a **Cron Trigger**, one instance per user-track,
calling the **Anthropic API directly** instead of shelling out to a CLI. Workflows
rather than a plain cron Worker because the run is multi-minute and needs to be durable
and resumable across steps.

The crux of feasibility: the current prompt depends on Claude Code's `WebSearch` and
`WebFetch` tools plus `Bash` for `curl` calls back to the tracker API. A server-side
replacement needs equivalents — the Anthropic API's own web search / web fetch tools,
with tracker API calls becoming ordinary tool definitions.

### Not yet researched — this is where to pick up

1. `scripts/run-search.ps1` and `scripts/run-fill.ps1` read in full — env vars, error
   handling, logging, how the CLI result is interpreted. Only skimmed.
2. `server/src/prompt.js` `buildSearchPrompt` read in full — every capability and
   external dependency the prompt assumes.
3. Cloudflare Workflows: actual duration/step limits, pricing, whether a long agentic
   loop fits the step model.
4. Anthropic API server-side web search + web fetch: availability, pricing per call,
   and whether fetch reliability matches what the CLI achieves today. **The whole
   verification premise — "every candidate URL must be fetched and confirmed to render
   a real job description" — depends on this.**
5. Cost per run, measured on one real search. This number decides BYO-key vs. subscription.
6. `run-fill.ps1` fans out to one subagent per posting. Whether that maps to Workflow
   steps or needs a different concurrency primitive.

### Open product questions

- **Who pays for tokens** — BYO Anthropic key (kills sign-up friction, simplest) vs.
  you eat it and charge. Upstream of the sign-up flow and the pricing page.
- ~~Does the hosted version still ship a Claude Code plugin?~~ **Decided: no.**
  `.claude-plugin/plugin.json` is removed and the README points at `git clone`. The
  skills still load as project skills from `.claude/skills/`, which is all they were
  doing; what is gone is the ability to `/plugin install` this repo. Note both
  unmerged feature branches still modify that manifest, so each will conflict with
  its deletion when it lands.
- Does `job-search-setup` (conversational onboarding) survive, or does sign-up replace it?
