# Build the tracker page a second time, in React

> Status: **proposed** (2026-09-10). A new `client-react/` deployable — React,
> Vite, TypeScript, TanStack Query, Vitest — built alongside the page that ships
> today rather than converting it. The existing `client/` keeps working and keeps
> deploying throughout, and the two only ever meet at a cutover decision that is
> explicitly deferred to the end.
>
> **This is not the cheapest way to serve this app.** The cheapest is recorded in
> "The option this passed over" below, and it was the earlier recommendation. The
> deciding requirement is a stated goal that a maintenance-cost argument does not
> speak to: hands-on experience with the industry-standard stack, which means the
> toolchain, the type system and the test runner, not only the rendering model.
>
> **Phase 0 has shipped** (`0083ae9`). It found more than this document had
> assumed: the drill-parity problem below was not only unenforced but already
> extended to every funnel row, which held its own copy of the stage predicate
> too. It is now demonstrable rather than asserted — change `DRILLS["gone-quiet"]`
> from 14 days to 21 and nothing else, and the page as it stood showed a tile
> reading 3 above a list of 2. That is the best single piece of evidence in this
> document, and it is worth more than the bug list: a one-off slip says someone
> was unlucky, while a defect the structure invites in four places at once says
> something about the structure.

## Context

`client/public/index.html` is 2,480 lines and 128 KB: HTML shell, 491 lines of
CSS and 1,874 lines of JS in one file, no build step, no bundler, no framework,
no dependencies but two Google Fonts links. Open it in a browser and it runs.
`npm run deploy` uploads `public/` to a Worker as static assets.

Measured at `d5a68d4`, and the number is a moving target rather than a fact:
the same file was 2,420 lines earlier the same day, and a grouped-row change
to the Applications grid is in flight as this is written. **The growth rate is
itself part of the argument** — a file that gains 60 lines between a plan being
started and finished is not one that has settled.

It works, and the properties that make it cheap to edit are real: a two-line CSS
fix is a two-line change, there is no supply chain, and the "Deploy to
Cloudflare" button forks `client/` and serves it with no build configuration.
Nothing here takes those away from it — they stay exactly as they are, on a page
that stays deployed.

### What is straining

This round added drill-down tiles, a `DRILLS` registry, a cross-track All-leads
tab, a pinned header/tiles layout with the Overview scrolling inside its own
region, and a scrollbar-gutter width measured in JS and fed back into CSS as
`--sbw`. Three properties of the page are getting more expensive as it grows:

**Every repaint is wholesale.** `render()` (`client/public/index.html:1990`)
replaces `#panel.innerHTML` and then hand-restores what the swap destroyed:
`.md-list` scrollTop, `.panel-scroll` scrollTop, the `.scrolled` hairline, a
re-attached scroll listener, `scrollIntoView` on the selected row when there was
no previous list, and — in the `input` handler at `:2156` — the search box's
focus and caret position. Six manual preservations for two scroll regions and one
text input, and the failure mode when a seventh is forgotten is silent.

**The XSS boundary is a discipline, not a property.** Lead data is read off job
postings on the internet. The page builds HTML as strings: 94 `esc()` calls and 4
`safeUrl()` calls, correct today because someone remembered each one. Nothing
enforces the 95th.

**The drill-down invariant is not actually enforced.** The commit says a tile's
count and the rows it opens come from one predicate. They don't. In `dashboard()`
(`:1400`), four of six tiles compute their count with a predicate written a second
time next to the one in `DRILLS` (`:798`):

- `active` re-states `ACTIVE.indexOf(a.status)>=0`, which is `in-conversation.test`.
- `stale` re-states the 14-day rule, which is `gone-quiet.test`.
- `near` excludes `"Applied"`; `top-geo-open.test` does not — they agree only
  because `leadsTab()` (`:1608`) drops applied leads before the drill ever runs.
- "Tracked leads" counts `status!=="Applied"` inline, the same filter `leadsTab()`
  applies, written out twice.

They all agree right now, and none of them agree *by construction*. That is a
live bug waiting on one edit, it is independent of anything in this plan, and it
is Phase 0.

## Why a second client rather than a conversion

**Nothing is at risk.** The page in daily use during an actual job search does not
enter a half-migrated state. There is no phase where a scroll position, a theme
token or a status write is broken in the thing being used to track real
applications. The new client is deployed to its own URL from Phase 1 and used by
nobody until it earns it.

**It teaches the whole stack rather than the hooks slice.** Converting
`index.html` in place means hooks and a `vite.config.ts` written once. Building
fresh means the parts that are actually asked for: a typed API boundary, a data
layer with cache invalidation and optimistic writes, routing, and a test suite.
This app has the shape for all four — one big read, many small writes, tabs that
should be URLs, and a set of invariants that want asserting.

**Abandoning it costs nothing.** If it stalls, `client/` is still there, still
deployed, still the thing that works. That is not true of a conversion at Phase 3.

**And if it wins, the cutover is a DNS-level decision, not a merge.** Two
deployables that never shared code cannot half-cut-over.

The cost being accepted, stated plainly: **it is roughly twice the work of
converting, and it creates a period where two clients exist.** See "Divergence"
under Cost.

### The option this passed over

**Preact + htm, vendored as one UMD file, no build step.** Preact's API *is*
React's — the same hooks, the same reconciliation model, the same component
shape — and htm gives tagged templates that escape interpolated values by
default. It fixes both structural problems above (diffing makes scroll and focus
survive; escaping stops being a rule) for about two sessions of work, one
vendored file, no lockfile, no CI, no transitive dependencies, and no change to
how the page deploys or previews.

It was the right answer to "what does this repo need". It is the wrong answer to
"what is worth learning", because the parts it deliberately avoids — the build,
the types, the ecosystem, the test runner — are most of what the industry means
by React experience, and "Preact" is a weaker thing to have worked in even when
the skill transfers whole. Recorded here so the more expensive choice is on the
record as a choice.

## The target

A third deployable beside `server/` and `client/`, sharing no code with either
and talking to the same API over the same CORS-open, bearer-token contract.

**Stack** — React (whatever `npm create vite@latest` gives at scaffold time; 19+),
Vite, TypeScript in `strict` mode. React Router for tabs. TanStack Query for the
read and the writes. Vitest + React Testing Library. Zod at the API boundary.

That is five dependencies with a stated job each, not a starter template taken
whole:

| | Why it is here |
|---|---|
| Vite + TS | the toolchain and type system, which is the point |
| React Router | `ui.tab` in `localStorage` becomes a real URL — shareable, back button works |
| TanStack Query | one `/api/data` read, then optimistic writes on every field edit; today the page hand-patches `state` after each write and full-refetches via `boot()` in some paths |
| Zod | parse `/api/data` once at the boundary; every downstream type is inferred from the schema rather than hand-declared and hoped for |
| Vitest + RTL | the invariants below become executable. RTL queries by accessible role, which makes the keyboard requirement structural rather than a checklist item |

Not here, deliberately: any component library, any CSS framework, any state
manager beyond Query plus `useState`, and SSR/Next.js. The app is a single-user
dashboard behind a login — there is nothing for a server renderer to do.

**Styling** — `client/public/index.html`'s CSS is copied wholesale into
`src/styles.css` as a plain global stylesheet, tokens untouched, class names
unchanged. No CSS modules, no CSS-in-JS, no Tailwind. The design is done and
good, the three-way theme system is the part most likely to break silently in a
rewrite, and re-learning CSS is not the goal. Components emit the class names the
stylesheet already targets.

**The API URL** — `import.meta.env.VITE_API_BASE`, from a gitignored `.env.local`,
baked at build time. This replaces the runtime `local-config.js` pattern and is
strictly better in one specific way worth noticing: a build with no
`VITE_API_BASE` should **fail the build**, not produce a deployable site that
tells every visitor "This deployment has no API URL configured". Add that guard in
`vite.config.ts` at scaffold time — it is `predeploy-check.mjs`'s job moved one
step earlier, where it belongs.

**Deploy** — `client-react/` gets its own `wrangler.toml`, its own Worker name
(`job-search-tracker-client-react`) and its own URL. `[assets] directory = "./dist"`.
`npm run deploy` runs `vite build` then `wrangler deploy`. The "publishes exactly
what is on disk and deletes what isn't" hazard still applies, but to a *generated*
directory — a clean build always produces the complete set, which is why the
`local-config.js` class of accident cannot recur here.

**`client/` is untouched by every phase but Phase 0**, and Phase 0 is a bug fix
it wants anyway.

## Phase 0 — fix the drill parity in the shipping page

One commit against `client/public/index.html`, in its existing ES5 style, with no
relation to React. It fixes the live bug in Context and it produces the
specification Phase 2 is ported from: after this, the rule behind every Overview
number exists in exactly one place, which is the thing the React version needs to
copy.

- `dashboard()` computes every tile count by calling its own predicate. A tile
  with a `drill` gets its count from `DRILLS[id].test`; a tile with a plain
  `filter` uses the same status comparison the chip uses. None of the six keeps a
  second copy.
- Extract `leadRows(key)` and `appRows()` so `leadsTab()`'s `status!=="Applied"`
  exclusion and the "Tracked leads" tile call one function. `top-geo-open.test`
  then stops depending on the tab having already filtered for it.

**Ships alone, first.** **Rollback:** revert one commit. *Effort: ~1 hour.*

## Phase 1 — scaffold, deploy, sign in

The whole chain proven end to end on the smallest thing that can prove it: a page
that signs in against the live API and renders "Signed in as X — N leads, M
applications". Deployed to its own URL in this phase, not at the end, so the
deploy path is never the unknown.

- `npm create vite@latest client-react -- --template react-ts`, `strict: true`.
- `wrangler.toml` with `[assets] directory = "./dist"`, its own Worker name.
  `package.json`: `"build": "tsc -b && vite build"`, `"deploy": "npm run build && wrangler deploy"`.
- `.env.local` gitignored (add `client-react/.env.local` to `.gitignore` beside the
  existing `client/public/local-config.js` entry), plus the fail-the-build guard.
- `src/api/client.ts` — the analogue of `api()` (`:1324`) and the only path to the
  server: attaches the bearer token, turns a 401 into a session reset. Nothing
  else calls `fetch`.
- `src/api/schema.ts` — the Zod schema for `/api/data`'s
  `{user, updated, leads[], applications[], screened[], tracks[], settings}`
  (`server/src/routes/data.js`), with every type inferred from it.
- The gate: name and password to `POST /api/login`, token into `localStorage`.
- `.github/workflows/checks.yml` — `tsc --noEmit` and `vitest run` on
  `client-react/`. It has nothing to assert yet; it exists from the first commit
  so it is never a thing to retrofit.

**Rollback:** delete the directory. Nothing else references it.
*Effort: ~4 hours.*

## Phase 2 — port the pure logic, tests first

Everything in the current page that is a rule rather than markup: `geo()`,
`rank()`, `priClass()`, `leadComparator()`, `appComparator()`, `daysSince()`,
`hoursSince()`, `runState()`, `relWhen()`, `safeUrl()`, `hostOf()`, `buildTracks()`,
`buildTabs()`, and the `DRILLS` registry as Phase 0 leaves it.

These are pure functions over plain data. They are the ideal first Vitest target,
they are where the invariants that matter actually live, and porting them with
tests in front means the parity bar below is executable before a single component
exists. `src/domain/`, no React imports anywhere in it.

The fixture is the demo account's data shape (`scripts/seed-demo-user.ps1`,
`scripts/demo-user.json`) — leads across every status and location tier, twenty
screened postings, applications walked to an offer, a `fed_by` tab pair, a stale
run stamp. Every row invented, every URL under `example.com`.

**Rollback:** revert; no shipped surface depends on it yet.
*Effort: ~4 hours.*

## Phase 3 — the read-only UI

Tabs, Overview, both list panels, both views. No writes — every control that would
save is rendered and inert. This is the biggest phase and the one where the
learning actually happens.

- Tabs become routes: `/`, `/applications`, `/all-leads`, `/t/:trackKey`, with the
  drill-down as a query parameter. `ui.tab`'s `localStorage` restore and its
  fallback-when-the-track-is-gone become a route resolver against the config.
- `useQuery` on `/api/data`. The pinned Overview layout is ported as-is, with
  `--sbw` measured by a `ResizeObserver` in a `useLayoutEffect` keyed to the
  scroll region — which is the direct fix for the stale-measurement bug this
  session hit.
- Scroll and focus preservation: **delete it, don't port it.** All six manual
  restores exist to survive a wholesale `innerHTML` swap that no longer happens.
- RTL tests query by role and accessible name, so tiles being real buttons and
  the drill chip being dismissible from the keyboard are asserted rather than
  checked by hand.

**Rollback:** revert. `client/` is unaffected and still deployed.
*Effort: ~10 hours.*

## Phase 4 — writes

`useMutation` with optimistic updates and invalidation for: the generic field
commit (`/api/update`), lead status (`/api/leads/:id/status`), moving a lead
between tracks, application status with the stage-date modal
(`/api/applications/:id/status`), adding an application from a pasted URL, and
both deletes. The write indicator — "Saving…", then "Saved" or "Couldn't save —
try again" — is preserved as a contract; every write path sets it.

Do these against the **demo account only** until the phase is done. This is the
first point at which the new client can change real data.

**Rollback:** revert. *Effort: ~6 hours.*

## Phase 5 — account surfaces, then the cutover decision

Password change, logout, the theme toggle including the no-flash early script
(which stays a raw `<script>` in `index.html`, before React mounts — it has to run
before first paint, and that is not something a component can do).

Then a real comparison against the parity bar below, and an explicit decision with
three legitimate answers:

1. **Cut over.** Point the primary URL at the new Worker. `client/` goes to
   maintenance-only and then to the attic — kept in git, undeployed. The root
   `README.md`, `client/README.md` and `edit-tracker-page/SKILL.md` are rewritten
   for the new client, and the "Deploy to Cloudflare" button either gets a build
   command or is dropped with a note saying why.
2. **Keep both.** The ES5 page stays primary; the React one is the sandbox. Costs
   nothing as long as nobody pretends they are in sync.
3. **Abandon it.** The learning happened, `client/` never broke, and Phase 0's bug
   fix is a net win. This is a real outcome and not a failure.

**Do not decide this in advance.** *Effort: ~4 hours plus the decision.*

## The parity bar for cutover

Nothing here can *regress* — `client/` keeps working throughout. This is the list
the React client has to clear before it can be considered as a replacement, and
every item is a Vitest or RTL test unless marked manual.

**XSS at the data boundary.** React escapes interpolated children and attributes,
which covers text. It does **not** make a `javascript:` href safe — `safeUrl()`
ports over and gates every href and every link field, and this is the half the
framework does not fix. Tests: `dangerouslySetInnerHTML` appears zero times in
`client-react/src`; a fixture lead carrying `<img src=x onerror=1>` in `company`
and `javascript:alert(1)` in `url` renders the first as text and gives the second
no anchor at all.

**Config-driven tabs, nothing per-person hardcoded.** No track key, tab label,
page title or location tier is literal in `client-react/src` outside the defaults
that mirror `server/src/db.js:223`'s `DEFAULT_SETTINGS`. Tests: a source scan for the
demo fixture's track keys and labels; render against a config of two invented
tracks and assert the tab list matches; assert a route naming a since-removed
track resolves to the first tab rather than an empty panel.

**Drill parity.** For every tile naming a drill, the count displayed equals the
number of rows the route it links to renders with that drill applied, over the
demo fixture. This is the assertion Phase 0 makes possible and Phase 2 makes
executable.

**Three-way theming.** A colour needs a value in `:root`, in the
`prefers-color-scheme` block guarded by `:not([data-theme="light"])`, and in
`[data-theme="dark"]`. Test: parse `src/styles.css` and assert the three blocks
declare identical token name sets — a check the repo cannot make today, covering
exactly the failure `edit-tracker-page/SKILL.md` warns about. Manual: both themes,
and the toggle used while the OS preference is the opposite one.

**Scroll and focus across re-render.** Manual, per surface: `.md-list` scrollTop
survives selecting a row; `.panel-scroll` scrollTop survives a click on the
Overview; the filter box keeps focus and caret while typing; switching Grid to
Detail lands on the highlighted row. Plus a source check that no manual restore
code was ported.

**Keyboard reachability and focus-visible.** Every interactive element is a real
`button`, `select`, `input` or `a` — no click handler on a `div`. RTL's
`getByRole` covers most of this by construction. The `:focus-visible` rules still
match live elements. Manual: tab from the header through the tiles, open a drill
with Enter, dismiss the chip with Enter, Escape closes both modals.

**One authenticated path to the server.** `fetch(` appears only in
`src/api/client.ts` and the two places that legitimately sit outside a session —
login (no token yet) and logout (a token being discarded). Today's page has
exactly three call sites; the new one should too.

**The write indicator.** Every mutation sets "Saving…" and resolves to "Saved" or
"Couldn't save — try again". A write that skips it looks to the person like
nothing happened.

## Testing

`client-react/` carries the suite; `client/` carries none and gets none, since
investing in tests for a page that may be retired is the wrong spend.

- **Vitest + RTL, from Phase 1**, empty. CI exists before there is anything to run
  in it so it is never a retrofit.
- **Phase 2 is where it becomes real**: the pure domain functions are the highest
  value per line of test in the whole app, and they hold the invariants that
  actually matter. Drill parity, comparators, the geo tiers, `safeUrl()`, tab
  construction from config.
- **Phase 3 adds component tests** by accessible role, which is what makes the
  keyboard bar structural.
- **Phase 4 adds mutation tests** against a mocked API client — the optimistic
  update, the rollback on failure, the indicator transitions.
- **`tsc --noEmit` in CI from Phase 1**, which is the check that ends the
  hand-mirrored-constants problem: `LEAD_STATUS`, `APP_STATUS`, the settings
  defaults and `APP_STAGE_DATE_MAP` are each duplicated from the server today with
  a comment saying no build step ties the two together.

The server keeps `verify-local.mjs` (270 checks) and is untouched by all of this.
Adding a second CI job that runs it against `wrangler dev --local` is worth doing
and is independent of this plan; pin the wrangler version in the workflow, since
the repo deliberately commits no lockfile.

## Cost

| Phase | Effort | Risk to the working page |
|---|---|---|
| 0 — drill parity fix in `client/` | ~1h | one revertable commit; fixes a live bug |
| 1 — scaffold, deploy, sign in | ~4h | none |
| 2 — pure logic + tests | ~4h | none |
| 3 — read-only UI | ~10h | none |
| 4 — writes | ~6h | none (demo account only) |
| 5 — account surfaces + decision | ~4h | none until a cutover is chosen |

**Roughly 30 hours, against ~16 for converting in place.** That difference is what
is being paid for the learning goal and for the working page never being at risk.

**Divergence is the real ongoing cost, and it is not zero.** For as long as both
exist, a bug fixed in one is not fixed in the other, and the ES5 page is the one
in daily use. The mitigation is a rule rather than a hope: **once Phase 3 lands,
`client/` is maintenance-only** — bug fixes yes, new features no. Phase 0 is its
last structural change. If a new feature is wanted before the decision in Phase 5,
that is the signal to make the decision early.

**Maintenance taken on if the cutover happens:** a lockfile, five direct
dependencies and their transitive tree, monthly update noise, a build that can
break on a Node upgrade, and a deploy that goes through a build. The current page
has no supply chain at all. This is the honest price of the stack, and it is paid
only at cutover — not before.

## Verification

```bash
cd client-react && npm run build && npx vitest run
```

Per phase, against the demo account rather than a live one
(`scripts/seed-demo-user.ps1`): open the deployed React client, sign in, and walk
both themes, a narrow viewport, a short viewport, the tab-through and the console.

Then the one comparison that matters, from Phase 3 onward: **the same account open
in both clients, side by side**, on the same numbers. A tile counting differently
in the two is the bug this whole parity bar exists to catch.

No server change and no migration anywhere in this plan. `verify-local.mjs` and
`verify-migration.mjs` are untouched, and no phase needs a server deploy.

## Docs and skills

Nothing is rewritten until Phase 5 decides something — documentation that
describes a client nobody uses yet is worse than none.

What changes at scaffold time only: `.gitignore` gains `client-react/.env.local`,
and `client-react/README.md` is written with the phase's own work (how to run it,
where the API URL comes from, why it exists beside `client/`).

What changes only on a cutover: the root `README.md`, `client/README.md`,
`.claude/skills/edit-tracker-page/SKILL.md` (rewritten end to end — a skill still
describing string HTML and ES5 is how the next edit lands in the wrong client),
`.claude/skills/verify-and-deploy/SKILL.md`, and the "Deploy to Cloudflare" button,
which has no build command and needs one or a note saying why it went.

## Not in this round

Any change to `server/`, any migration, SSR or Next.js, a component library, a CSS
framework, replacing the existing client, retiring `client/`, or a shared
types package between client and server. The last is the natural follow-on if the
cutover happens and is deliberately out of scope until then.

---

**Recommendation:** build `client-react/` as a third deployable through Phases
0-4, deployed to its own URL from Phase 1, used by nobody until it clears the
parity bar. Hold the cutover decision until Phase 5 and let all three answers stay
open.

**First step:** Phase 0, on its own branch, and it is not React at all — rewrite
`dashboard()`'s six tile counts to call `DRILLS[id].test` and the extracted
`leadRows`/`appRows`. It fixes a real bug in the page that is in daily use, it is
one revertable commit, and it turns the drill-down rules into the single-source
specification that Phase 2 ports and Phase 3 is tested against.
