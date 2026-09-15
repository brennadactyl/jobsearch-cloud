---
name: edit-tracker-page
description: Change the tracker webpage in client/ - a React + TypeScript app built with Vite - covering where things live (components, domain rules, the API layer, view preferences), the rules its tests enforce (one path to the server, no HTML from strings, safeUrl hrefs, config-driven tabs, the drill invariant, theme tokens, stylesheet class names), how every write reports through the save indicator, previewing against the live API, and deploying. Use when changing the tracker page's UI, layout, styling, tabs, columns, sorting or any client-side behaviour.
---

# Changing the tracker page

`client/` is a React 19 + TypeScript (`strict`) app built with Vite, served as
static assets by its own Worker. `client/README.md` covers setup, sign-in and
deployment; this is about editing.

Don't add a component library, a CSS framework, a state manager beyond
TanStack Query plus `useState`, or SSR.

## Where things live

- **`src/api/`** — the server boundary. `schema.ts` is the Zod schema every
  response is parsed through; types come from it, never hand-declared.
  `client.ts` is the only code that calls `fetch`. `mutations.ts` holds every
  write, as an optimistic mutation over the one `["data"]` query.
- **`src/domain/`** — pure rules with no React: drills, row sorting, location
  tiers, run staleness, tab building, formatting. Tested directly.
- **`src/components/`** — the UI. `Shell.tsx` is the header, tab bar and
  routes; one component per tab; `writes.tsx` holds the editable controls;
  `facts.tsx` the detail cards.
- **`src/ui/`** — per-browser state: `prefs.ts` (view, sort, selection, folded
  groups, in `localStorage`), `saved.ts` (the write indicator), `hooks.ts`
  (theme, the Overview's scroll region).
- **`src/tracker.css`** — the whole stylesheet.

The URL holds what you are looking at - the tab (`/applications`, `/all-leads`,
`/t/<track>`), and the `drill`, `filter` and `q` query params - so a view can be
linked to and the back button works. Per-browser preferences go in `prefs.ts`,
never the URL, and never the account.

## Rules the tests enforce

`npm test` fails on each of these; they exist because none of them would
otherwise fail anywhere.

- **One path to the server.** `fetch` only in `api/client.ts`. `request()`
  attaches the token, parses the response through a schema, and ends the
  session on a 401, which brings back the sign-in. (`boundaries.test.ts`)
- **No HTML from strings.** No `dangerouslySetInnerHTML`, no `innerHTML`.
  Company names, titles and notes come from job postings on the internet.
  (`boundaries.test.ts`)
- **Every `href` through `safeUrl()`** (`domain/format.ts`). React escapes text
  but renders a `javascript:` URL into an `href` as given. (`boundaries.test.ts`)
- **Nothing per-person is hardcoded.** No track key, tab label or page title in
  shipped code; the fixture is imported only by tests. The same deployed client
  serves everyone. (`boundaries.test.ts`)
- **A number and the rows it opens share one predicate.** Every Overview figure
  that opens a filtered list names an entry in `domain/drills.ts`; the count is
  `drillCount`, the length of `drillRows`, never a second copy of the rule.
  (`domain/drills.test.ts`)
- **Class names exist in `tracker.css`.** Every literal `className` a component
  writes must be selected somewhere in the stylesheet - an invented class is
  silently unstyled. Change a rule rather than invent a name. (`classes.test.ts`)
- **Colours are tokens, defined three times.** Custom properties on `:root`,
  redefined under `@media (prefers-color-scheme: dark)` guarded by
  `:root:not([data-theme="light"])`, and under `[data-theme="dark"]` for an
  explicit choice while the OS is light. A new token needs all three; a rule
  never inlines a hex value. (`theme.test.ts`)
- **Fonts requested.** A font family the stylesheet names must be in
  `index.html`'s Google Fonts link. (`fonts.test.ts`)

## Writes

- **Every write is a hook in `api/mutations.ts`** built on `useWrite`: it sets
  "Saving…", applies the optimistic change, replaces it with the row the server
  returns, and rolls back and says "Couldn't save — try again" on failure. A
  write outside that path looks to the person like nothing happened.
- **Fields commit on blur** (`EditableField`, `EditableNotes`). The draft is
  held until the write settles, so the field never flashes its old value.
- **Status has its own endpoints**, on leads and applications, because the
  server owns the side effects: setting a lead to Applied creates its
  application; a stage change stamps a date. A new field that needs a side
  effect needs a route (`add-api-route`), not a special case here.
- **The server's row wins.** An optimistic change is a guess; `onResult`
  replaces it with what came back.

## Previewing a change

```bat
cd client
npm run dev
```

It needs `client/.env.local` with `VITE_API_BASE` (copy `.env.example`). The
API sends `access-control-allow-origin: *`, so the dev server signs in against
the live API.

Check both themes and a narrow viewport before calling it done, and check the
browser console.

To exercise states that are awkward to reach on a real account, sign in to the
demo account (`scripts/seed-demo-user.ps1`): leads across every status and
location tier, screened postings, applications walked from "To Apply" to an
offer, a `fed_by` tab pair, and a track with a stale run stamp. Every row in
it is invented and every URL is under `example.com`.

## Checks

```bat
npm run typecheck
npm test
npm run lint
```

CI runs typecheck, tests and a build. Add a test with a behaviour change - query
by role and accessible name, as `App.test.tsx` does.

## Deploying

```bat
cd client
npm run deploy
```

Builds, then deploys `dist/`, replacing the live file set. Where to deploy from:
the `verify-and-deploy` skill - main checkout, never a worktree.

A client change needs no server deploy. If it calls a route that does not exist
yet, that is `add-api-route`, and the server ships first.
