---
name: prove-a-change
description: Prove a change does what you say it does, with this repo's tools under tools/ - the comments-only checks, the prompt snapshot, the tracker helper rig, the doc link check and the architecture diagram - and the proof each area's owner accepts before a PR merges. Use for a refactor, a comment or doc edit, or any change whose PR claims behaviour is unchanged.
---

# Proving a change

A change that claims to alter no behaviour has to be proved, not asserted: a
clean test run is also what a check that tests nothing looks like. Every tool
here lives in `tools/` and needs no install beyond the repo's own.

`verify-and-deploy` covers proving a change that *does* alter behaviour - new
checks in `verify-local.mjs`, and breaking a guard on purpose to see them fail.

## The tools

| Change | Tool | Passes when |
|---|---|---|
| Comments only, in JS/TS/CSS/HTML or config | `tools/proof/check-comment-only.mjs` | the parsed code before and after is identical |
| Comments only, in a `.ps1` | `tools/proof/check-ps1-tokens.ps1` | the non-comment tokens are identical |
| `server/src/prompt.js` | `tools/proof/prompt-snapshot.mjs` | the composed prompts diff as intended |
| `scripts/tracker.ps1` | `tools/tracker-rig/run.sh` | output, exit codes, files and requests all match |
| A doc or skill | `tools/docs/check-links.mjs` | no broken link or anchor outside plans |
| `docs/architecture.html` | `tools/docs/build-architecture-svg.mjs` | the regenerated SVG matches the diagram |

Each tool's usage is in its own header. Notes that catch people out:

- **Both comment checks take the base to compare against:** `--base=<ref>` for
  the node one, `-Base <ref>` for the PowerShell one, default `HEAD`. Use
  `HEAD` for uncommitted edits and `origin/main` for a pushed branch.
- **Run the node one from the repo root,** with `client/node_modules` present:
  it takes esbuild from `client/`'s npm install, and `node_modules` is
  gitignored, so a fresh worktree needs `npm install` in `client/` first. It
  says so rather than skipping files.
- **Line endings.** The working copy is CRLF and git normalises on commit, so a
  difference in line endings alone is not a code change; the comment checks
  report it as a note.
- **Run a snapshot or rig against main *and* the branch,** in separate folders,
  and diff the folders. A single run proves nothing.

## What each owner accepts

Put the result in the PR - the command and its summary line, not the whole
output.

- **Comments only, any area:** the matching comment check passes.
- **`server/` (Backend Buddy):** `server/verify-local.mjs` against
  `wrangler dev --local` and `server/verify-schema-doc.mjs` pass, plus its
  line-by-line read of the diff.
- **`server/src/prompt.js` (Prompt Bro):** `prompt-snapshot.mjs` run from main
  and from the branch, then diffed.
  - A refactor: zero difference.
  - A behaviour change: the diff touches only the intended step lines, with a
    count of other changed lines, which must be 0.
  - A change to a live search's behaviour: also run with `--configs` against
    the live configs (that folder stays outside the repo).
  - `verify-local.mjs` passes, with checks for any new behaviour.
- **`scripts/tracker.ps1` (Prompt Bro):** `tools/tracker-rig/run.sh` against
  main and the branch. For a refactor, output and requests are identical. For a
  behaviour change, only the intended scenarios differ, and a new scenario line
  covers it.
- **The runners (Prompt Bro):**
  - the PowerShell parser reports 0 errors;
  - a stub-CLI run through the changed path, from a short data dir, with a test
    worker in its own worktree, and the log lines shown;
  - after anything that touched `setup-scheduler.ps1`, no scheduled task is
    left whose data dir isn't the real `private\` folder.
- **`client/` (Client Comrade):** `tsc -b --noEmit`, `vitest run` and
  `oxlint src` pass with no test file edited. A flow that depends on a server
  branch is checked with `verify-client-against-local-server`.
- **Docs and skills (Documentation Dude):** the link check passes, a rebuilt
  SVG matches when the diagram changed, and every claim is checked against the
  code it describes.

**All areas:** every CI check green before the merge.
