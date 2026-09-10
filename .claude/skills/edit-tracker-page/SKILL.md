---
name: edit-tracker-page
description: Change the tracker webpage in client/public/index.html - the no-build single-file conventions (ES5, var, innerHTML with esc(), state/render(), config-driven tabs, the theme token pair), how to preview it against the live API, and what a static-assets deploy replaces. Use when changing the tracker page's UI, layout, styling, tabs, columns, sorting or any client-side behaviour.
---

# Changing the tracker page

One file: `client/public/index.html` - HTML, CSS and JS inline, no build
step, no framework, no bundler, no dependencies but two Google font links.
Open it in a browser and it runs. Every convention below exists to keep that
true, because "no build step" is what makes a two-line CSS fix a two-line
change rather than a toolchain.

`client/README.md` covers deployment and sign-in. This is about editing.

## Match the existing style, exactly

The script is deliberately, uniformly ES5. Measured across the file: **217
`var`, zero `let`, zero `const`, zero arrow functions.** Also: no template
literals, `function(){}` callbacks throughout, and `.forEach`/`.filter`/`.map`
rather than `for` loops. It is not accidental and it is not stale - a file
with one modern function in it reads as half-migrated and invites the rest.

Two more that matter more than they look:

- **`esc()` on every interpolated value.** The page builds HTML as strings and
  assigns `innerHTML`. Company names, titles, notes and locations all come
  from job postings the search read off the internet. An un-escaped one is an
  injection into the page.
- **`safeUrl()` on anything that becomes an `href`.** Same reason, different
  sink.

## How the page is put together

- **`state`** is what `/api/data` returned - `leads`, `applications`,
  `tracks`, `settings`, plus `user`. **`ui`** is view preferences (tab, query,
  filter, selection, sort), persisted per browser in `localStorage`.
- **`render()`** repaints the whole panel from `state` and `ui`. There is no
  diffing and no component model: change state, call `render()`. Note the two
  things it goes out of its way to preserve across the wholesale swap - the
  master-detail list's scroll position, and the focused element - so if you
  add a container that can scroll or hold focus, it needs the same treatment.
- **`api(path, opts)`** is the only way to reach the server. It attaches the
  bearer token and turns a 401 into `forgetSession()`, which is what makes a
  token revoked in another browser show a sign-in prompt rather than a
  confusing empty page. Never call `fetch` directly.
- **`setSaved()`** is the write indicator. Every write path sets "Saving…",
  then "Saved" or "Couldn't save — try again". A new write that skips it looks
  to the person like nothing happened.
- **`commit(el)`** is the generic field write: a whitelisted field goes to
  `/api/update` as one row patch. Status is the exception - it has dedicated
  endpoints because the server owns side effects a plain field write cannot
  do (creating a lead's application atomically, stamping a stage date). If a
  new field needs a side effect, it needs a route, not a special case here.

## Nothing about a track is hardcoded

`buildTracks()` and `buildTabs()` turn `/api/data`'s `tracks[]` and
`settings` into the tab bar as data. `kind` says which panel to draw; `label`,
the page title, the two built-in tab names, the priority-location tiers and
the staleness threshold all come from config. Adding a track in D1 adds a tab;
renaming one renames it.

**So never write a track key, tab label or page title into this file.** The
same deployed client serves everyone, and a hardcoded "SWE" is one person's
job search baked into everybody's page. If you need per-deployment or
per-person behaviour, it is a field on `/api/config`, and the convention is to
reuse an existing field before adding one.

`ui.tab` is restored from `localStorage` and can name a track that has since
been removed, so anything that resolves a tab needs the same fall-back
`render()` already does.

## Colour and theme

Colours are CSS custom properties on `:root`, redefined in two places: an
`@media (prefers-color-scheme:dark)` block guarded by
`:root:not([data-theme="light"])`, and a `[data-theme="dark"]` block for an
explicit choice made while the OS is light. **A new colour needs a value in
all three**, or it will be right in one theme and invisible in the other.
Never inline a hex value in a rule - use a token, adding one if none fits.
The priority tiers are `--pri-0`..`--pri-4` with a `-soft` companion each.

## Previewing a change

It is a static file, so open it directly - `client/public/index.html` in the
Browser pane. It needs `public/local-config.js` beside it (gitignored; copy
`local-config.example.js` and set `LOCAL_API_BASE`) or the gate just reports
no API URL. The API sends `access-control-allow-origin: *`, so a local page
signs in against the live API fine.

Check both themes and a narrow viewport before calling it done, and check the
browser console - a thrown error in `render()` leaves the panel half-drawn
with no other symptom.

To exercise states that are awkward to reach on a real account, sign in to the
demo account (`scripts/seed-demo-user.ps1`): leads across every status and
location tier, twenty screened postings, applications walked from "To Apply"
to an offer, a `fed_by` tab pair, and a track with a stale run stamp. Every
row in it is invented and every URL is under `example.com`.

## Deploying

```bash
cd client && npm run deploy
```

Through the npm script, never a bare `wrangler deploy` - the `predeploy` hook
is what stops a checkout missing `local-config.js` from deleting that file off
the live site. A static-assets deploy publishes exactly what is in `public/`
and removes anything that is not, which is also why `README.md`,
`package.json` and `wrangler.toml` live outside that directory rather than
being filtered out of it.

Read `verify-and-deploy` first for where the deploy has to be run from. The
short version: main checkout, main branch, never a worktree.

A client change needs no server deploy. If it calls a route that does not
exist yet, that is `add-api-route`, and the server ships first.
