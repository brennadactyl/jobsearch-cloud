# Job Search Tracker client — React rebuild

A **second** client for the same API, built beside
[`../client/`](../client/) rather than replacing it. That one still ships and is
still the one to use; this one is not finished and is deployed, if at all, to its
own URL where nobody depends on it.

Why it exists, what it has to clear before it could replace anything, and what
happens if it never does: [`../docs/react-adoption-plan.md`](../docs/react-adoption-plan.md).

**Status: Phase 1.** Signs in, loads `/api/data` through a typed boundary, and
reports what came back. No tabs, no tables, no writes — those are Phases 3 and 4.

## Stack

React 19, Vite, TypeScript (`strict`), TanStack Query, Zod, Vitest +
Testing Library. Five dependencies with a job each rather than a starter
template taken whole — the reasoning is in the plan's "The target" section.

Not here on purpose: any component library, any CSS framework, any state manager
beyond Query plus `useState`, and SSR. This is a single-user dashboard behind a
login; there is nothing for a server renderer to do.

## Running it

```bat
cd client-react
npm install
copy .env.example .env.local
```

Edit `.env.local` and set `VITE_API_BASE` to your `../server/` deploy's URL, then:

```bat
npm run dev
```

`.env.local` is gitignored, the same treatment `../client/public/local-config.js`
gets and for the same reason — it is *your* deployment's detail, not something
that belongs in the template other people fork.

The blocks here are `cmd.exe`. In PowerShell they can die with "running scripts
is disabled on this system" before running anything; use `npm.cmd` / `npx.cmd`,
or see [`../server/README.md`](../server/README.md)'s setup section.

## Checks

```bat
npm run typecheck
npm test
```

Both run in CI on every push and pull request
([`../.github/workflows/checks.yml`](../.github/workflows/checks.yml)) — the
repo's first. What the tests cover at this phase:

- **`src/api/schema.test.ts`** — the API boundary. That the schema defaults what
  a brand-new deployment omits, ignores fields the server has and this client
  does not render, and fails loudly rather than quietly on a payload it cannot
  make sense of.
- **`src/theme.test.ts`** — that every colour token is defined in all three
  theme blocks, and that no rule inlines a hex value. A check the single-file
  page cannot make of itself, covering the failure its editing skill warns about.
- **`src/App.test.tsx`** — the gate and the summary, queried by role and
  accessible name. Querying that way is what turns "every interactive element is
  a real control" into an assertion: a `div` with a click handler has no role to
  find, so these fail if one appears.

## The API URL is a build input, not a runtime file

`VITE_API_BASE` is baked into the bundle at build time, and
[`vite.config.ts`](vite.config.ts) **fails the build without it**.

This is the one place this client is strictly safer than the page it may replace.
Over there the URL is a gitignored runtime file, so a checkout missing it builds
and deploys perfectly happily into a site that tells every visitor "This
deployment has no API URL configured" — which is what happened on 2026-09-08,
from a git worktree, and took the sign-in page down for hours.
[`../client/predeploy-check.mjs`](../client/predeploy-check.mjs) exists to catch
that after the fact. Here the same failure cannot produce a deployable artifact
at all.

## Deploying

```bat
cd client-react
npm run deploy
```

Builds, then `wrangler deploy`s to its own Worker
(`job-search-tracker-client-react`) at its own URL. It shares nothing with
`../client/`'s deployment and cannot affect it.

**Main checkout, main branch, never a worktree** — see
[`../.claude/skills/verify-and-deploy/SKILL.md`](../.claude/skills/verify-and-deploy/SKILL.md).
The worktree rule bites differently here than it does for `../client/`: a
worktree has no `.env.local`, so the build fails rather than deploying something
broken. That is the guard working, not a problem to route around.

## Why the lockfile is committed here

`package-lock.json` is gitignored repo-wide, and un-ignored for this directory
(see [`../.gitignore`](../.gitignore)). The repo-wide rule is about `client/` and
`server/`, which have wrangler as effectively their only dependency and would
otherwise hand every forker a version that got pinned by accident. This is a real
application with a real dependency tree, where an unpinned install resolves
differently on every machine and in CI.

That is the supply chain the plan named as the honest price of this stack. The
single-file page has none at all.
