# Job Search Tracker client — React rebuild

A **second** client for the same API, beside [`../client/`](../client/).
`../client/` is the one in use; this one is not finished, is deployed only to
its own URL, and nothing depends on it. See
[`../docs/react-adoption-plan.md`](../docs/react-adoption-plan.md).

It signs in, draws the Overview, both leads tabs and Applications in Detail and
Grid, changes your password and logs out. Every field saves on blur, statuses
go through their own endpoints, and rows can be added and removed. Writes are
optimistic - the row changes first and the server's answer decides whether it
stays changed.

## Stack

React 19, Vite, TypeScript (`strict`), TanStack Query, React Router, Zod,
Vitest + Testing Library.

Don't add a component library, a CSS framework, a state manager beyond Query
plus `useState`, or SSR.

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

`.env.local` is gitignored, like `../client/public/local-config.js`.

The blocks here are `cmd.exe`. In PowerShell use `npm.cmd` / `npx.cmd` (see
[`../server/README.md`](../server/README.md#one-time-setup)).

## Checks

```bat
npm run typecheck
npm test
```

Both run in CI, with a build, on pushes to `main` and on pull requests
([`../.github/workflows/checks.yml`](../.github/workflows/checks.yml)). What the
tests cover:

- **`src/api/schema.test.ts`** — the API boundary.
- **`src/theme.test.ts`** — that every colour token is defined in all three
  theme blocks, and that no rule inlines a hex value.
- **`src/classes.test.ts`** — that every literal class name a component writes
  exists in `tracker.css`.
- **`src/fonts.test.ts`** — that every font family the stylesheet names is
  requested by `index.html`.
- **`src/boundaries.test.ts`** — source-level rules, checked by reading the
  source.
- **`src/deploy-config.test.ts`** — that `wrangler.toml` falls back to
  `index.html`, so tab URLs don't 404 on reload.
- **`src/domain/drills.test.ts`** — the drill invariant: for every tile and
  funnel row, the number shown is the length of the rows it opens.
- **`src/domain/domain.test.ts`** — the ported rules.
- **`src/App.test.tsx`** — the gate, shell and routing, queried by role and
  accessible name.
- **`src/writes.test.tsx`** — the optimistic layer.
- **`src/parity.test.tsx`** — behaviour of `../client/` this client had to be
  taught.
- **`src/review.test.tsx`** — differences a side-by-side review of the two
  clients found.

## The API URL is a build input, not a runtime file

`VITE_API_BASE` is baked into the bundle at build time, and
[`vite.config.ts`](vite.config.ts) **fails the build without it**.

## Deploying

```bat
cd client-react
npm run deploy
```

Builds, then `wrangler deploy`s to its own Worker
(`job-search-tracker-client-react`) at its own URL, separate from
`../client/`'s deployment.

**Main checkout, main branch, never a worktree** — see
[`../.claude/skills/verify-and-deploy/SKILL.md`](../.claude/skills/verify-and-deploy/SKILL.md).

## The lockfile is committed here

`package-lock.json` is gitignored repo-wide and un-ignored for this directory
(see [`../.gitignore`](../.gitignore)). CI installs with `npm ci`, which fails
when `package.json` and the lockfile disagree, so commit them together.
