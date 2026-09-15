# Job Search Tracker client (Cloudflare Workers, static assets)

The tracker webpage: React 19, Vite, TypeScript (`strict`), TanStack Query,
React Router, Zod, and Vitest with Testing Library. It builds to static files
in `dist/`, which a Cloudflare Worker serves from its own origin. It is a
separate deployable from the API ([`../server/`](../server/)) and calls it
cross-origin over `fetch` with a Bearer token. It holds no data of its own; it
renders and edits whatever the API returns.

Writes are optimistic: the row changes on screen first, and the server's answer
decides whether it stays changed. Tabs are real URLs (`/applications`,
`/all-leads`, `/t/<track>`), so a filtered view can be linked to and the back
button undoes a drill.

Don't add a component library, a CSS framework, a state manager beyond Query
plus `useState`, or SSR. The `edit-tracker-page` skill covers how the code is
put together.

## How it finds its API

One deployed client talks to one server. The API URL is a **build input**, not
something a visitor types in: `VITE_API_BASE` is baked into the bundle, and
[`vite.config.ts`](vite.config.ts) **fails the build without it**. A page that
can't reach any API would otherwise deploy and look healthy.

```bat
cd client
copy .env.example .env.local
```

Set `VITE_API_BASE` in the copy to your `../server/` deploy's URL. `.env.local`
is gitignored, so a deployment's own URL never lands in the template others
fork.

## Signing in

The page asks for a **name and password** and posts them once to
`/api/login`, which returns a session token. The token lives in `localStorage`
(`tracker_token`, with `tracker_name` to prefill the form next time) and is
sent only to `VITE_API_BASE`; the password is never stored or sent again. Each
browser signs in once.

**"Signed in as ..."** (in the header) opens the dialog that changes your own
password. It asks for the current password as well as the session, and can sign
out your other browsers without touching the credential your scheduled search
holds. See [`../server/README.md`](../server/README.md#changing-your-own-password).

**Log out** (in the header) revokes that token on the server and clears the
view preferences. It leaves that person's other sessions alone, including the
one their scheduled searches use. A token revoked anywhere else brings the
sign-in back on the next request.

Accounts are created by whoever operates the deployment; there's no sign-up
here. See [`../server/README.md`](../server/README.md#accounts). Each person
sees only their own tracks, leads, applications, page title and location rules.

## One-time setup

Deploy [`../server/`](../server/) first - you'll need its Worker URL for
`VITE_API_BASE`.

### Quick deploy

No Node.js or `wrangler` CLI required locally - the build and deploy happen in
Cloudflare's own environment (Workers Builds).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/brennadactyl/JobSearchTracker/tree/main/client)

1. Click the button and sign in to Cloudflare. It forks this `client/`
   directory into a new repo in your own GitHub.
2. On the setup page, set the **deploy command** to `npm run deploy` (it
   builds, then deploys), and add a **build variable** `VITE_API_BASE` set to
   your API Worker's URL. Build variables exist only while building, which is
   the only time this one is read.
3. If the first build ran before the variable was set, it fails with
   "VITE_API_BASE is not set - refusing to build". Add the variable under the
   Worker's **Settings > Build** and retry the build.
4. Your client's URL is shown on the dashboard (something like
   `https://job-search-tracker-client.<your-subdomain>.workers.dev`).
5. Open it and sign in with the name and password of the account you created
   (see [`../server/README.md`](../server/README.md#accounts)) - it's
   remembered in this browser for next time.
6. **Expect an empty page here.** A new database has no tracks, title or
   location rules, so you'll see only the Overview and Applications tabs until
   the [job-search-setup](../.claude/skills/job-search-setup/) skill posts your
   config to `/api/config` (see the root [README](../README.md)'s setup step
   5). Track tabs then appear, reading "No run recorded yet" until their first
   scheduled search reports in.

### Manual setup

```bat
cd client
npm ci
copy .env.example .env.local
REM set VITE_API_BASE in .env.local
npx wrangler login
npm run deploy
```

Prints your live URL. Then sign in as in step 5, and expect the empty page of
step 6 until your config is posted.

The blocks here are `cmd.exe`. In PowerShell use `npm.cmd` / `npx.cmd` (see
[`../server/README.md`](../server/README.md#one-time-setup)).

## Working on it

```bat
npm run dev          REM against the API in .env.local
npm run typecheck
npm test
npm run lint
```

Typecheck, tests and a build run in CI on pushes to `main` and on pull requests
([`../.github/workflows/checks.yml`](../.github/workflows/checks.yml)). What the
tests cover:

- **`src/api/schema.test.ts`** — the API boundary.
- **`src/theme.test.ts`** — every colour token is defined in all three theme
  blocks, and no rule inlines a hex value.
- **`src/classes.test.ts`** — every literal class name a component writes
  exists in `tracker.css`.
- **`src/fonts.test.ts`** — every font family the stylesheet names is requested
  by `index.html`.
- **`src/boundaries.test.ts`** — source-level rules: one path to the server, no
  HTML from strings, every `href` through `safeUrl`, nothing per-person
  hardcoded.
- **`src/layout.test.ts`** — layout rules jsdom can't apply, read from
  `tracker.css`: the Overview's tile row reserves the scrollbar gutter only
  while its region scrolls.
- **`src/deploy-config.test.ts`** — `wrangler.toml` falls back to `index.html`,
  so tab URLs don't 404 on reload.
- **`src/domain/drills.test.ts`** — the drill invariant: for every tile and
  funnel row, the number shown is the length of the rows it opens.
- **`src/domain/domain.test.ts`** — URL safety, location tiers, sorting, fill and run
  states, dates and tabs.
- **`src/domain/export.test.ts`** — CSV quoting, the byte-order mark, the
  formula guard, filenames, and that every header is one of the page's labels.
- **`src/export.test.tsx`** — the Export button writes exactly the rows its list
  renders, in order, and counts them.
- **`src/App.test.tsx`** — the gate, shell and routing, queried by role and
  accessible name.
- **`src/writes.test.tsx`** — the optimistic layer.
- **`src/parity.test.tsx`** and **`src/review.test.tsx`** — detail-pane, grid,
  copy, focus, selection and save-indicator behaviour.

## Updating after code changes

**Deploy from `main` in the main checkout, never from a branch or worktree** -
see [verify-and-deploy](../.claude/skills/verify-and-deploy/SKILL.md). A
worktree has no `.env.local`, so its build refuses.

```bat
cd client
npm run deploy
```

That builds, then `wrangler deploy`s `dist/`. A static-assets deploy replaces
the live file set with exactly what `dist/` holds.

A client-only change (styling, a new field, a UI fix) never needs a server
redeploy. A change that depends on a new API field or route needs the server
deployed first - check [`../server/README.md`](../server/README.md)'s API
section for what the deployed server supports.

## The lockfile is committed here

`package-lock.json` is gitignored repo-wide and un-ignored for this directory
(see [`../.gitignore`](../.gitignore)). CI installs with `npm ci`, which fails
when `package.json` and the lockfile disagree, so commit them together.

## Custom domain / different host

Only the deploy step is specific to Cloudflare. `dist/` is plain static files
and works from any static host (another Workers/Pages project, S3 + CloudFront,
GitHub Pages, any web server) - the API's CORS response
(`Access-Control-Allow-Origin: *`) allows any origin. Two requirements carry
over from `wrangler.toml`: the host must serve `index.html` for any path that
isn't a file, or tab URLs 404 on reload; and it must serve over HTTPS, because
browsers block an HTTPS API's `fetch` as "mixed content" from a page loaded
over plain HTTP.
