# Handoff: turning this into a hosted service

**Status: handoff, not a finished plan.** The fork is done and verified. The
productization design was interrupted during exploration — the runner approach below
is a *hypothesis*, not a validated design. See "Not yet researched".

Delete this file once its contents have been absorbed into real issues or docs.

---

## ⚠️ Read this before running anything here

This repo is a full copy of `JobSearchTracker`, so it still carries **production
deploy config pointing at the live tracker**:

- `server/wrangler.toml` → `name = "job-search-tracker"`,
  `database_id = "104f139f-bc84-4e72-8034-8541ef563ae4"` (the live D1)
- `client/wrangler.toml` → `name = "job-search-tracker-client"`

A `npm run deploy` from this repo would **overwrite the live Worker and apply
migrations to the real D1 database.** Renaming both Workers and provisioning separate
D1 is task zero, before any other work.

Also: the `block-remote-d1-writes` PreToolUse hook is configured in
`.claude/settings.local.json` with an **absolute path** to
`C:/VibeCoding/.claude/hooks/block-remote-d1-writes.mjs` — it currently points back at
the *old* repo's copy. Repoint it or copy the hook in.

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
- Does the hosted version still ship a Claude Code plugin? `.claude-plugin/plugin.json`
  still declares `job-search-tracker` v5.0.0 pointing at the skills dir — left alone
  deliberately; it's a design question, not cleanup.
- Does `job-search-setup` (conversational onboarding) survive, or does sign-up replace it?
