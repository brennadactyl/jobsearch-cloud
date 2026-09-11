# React client UX comparison against the page that ships

> Reviewed 2026-09-11, signed in to both clients as `demo`, same data, side by side.
> Old: https://job-search-tracker-client.brenna-duffitt.workers.dev (`client/public/index.html`).
> New: https://job-search-tracker-client-react.brenna-duffitt.workers.dev (`client-react/`).
>
> **The new client was redeployed mid-review.** The first pass ran against bundle
> `index-Ch74YGpz.js`; `bd89bf8` then shipped `index-X5bQimRS.js`, and `914cf3e`'s
> worker config followed. Every open finding below was re-checked against
> `X5bQimRS` with the SPA fallback live, unless it says "from source". Items the
> redeploy fixed are listed separately under
> [Found during this review and already fixed](#found-during-this-review-and-already-fixed).

## Re-verification after the fixes

Re-checked on 2026-09-11 against the React worker version
`ac3e8336-356c-4666-baa7-68abb553a7f8`, bundle `index-BMOtXW6V.js` and
`index-BHby8czA.css`, built from `origin/main` `b69ea92`. The old client is
unchanged: its `index.html` is byte-identical (142,127 bytes), and nothing has
touched `client/public/index.html` since `bd89bf8`. The findings in section 1
below describe the client *before* these fixes and are kept as the record.

Failures were simulated by stubbing `window.fetch` for a single request type in
the page. The re-check made these writes on demo and reverted every one of
them:

- one comp edit
- one lead moved to Data Science and back
- four test applications, created and deleted
- three demo browser sessions, revoked

Demo ends where it started: tiles 12 / 10 / 24 / 9 / 2 / 2, and badges
Applications 10, All leads 12, Engineering 6, Eng Leadership 3, Data Science 3.

| Finding | Status | How it was checked |
|---|---|---|
| 1.1 Applications foot notes | **Fixed** | Detail and Grid notes are word-for-word the old copy, with no "N of M shown" |
| 1.2 List row labels | **Fixed** | Stonebridge (To Apply) ends "Not applied yet"; a link-only row's title line is "—". "Couldn’t read the posting" can't be reached with the demo data, which has no failed-fill row |
| 1.3 Drill chip colour | **Fixed** | Chip text is `rgb(45, 212, 191)` on Applications and All leads; tiles stay `rgb(233, 235, 244)`. Live rule is `.tile, .jumplink { color: inherit; }` |
| 1.4 Expired session on a write | **Fixed** | Revoked the token, then edited Referral. Result: gate, "Your session has expired - sign in again.", name "Demo" kept, focus in the password field, URL `/`, token cleared. Referral unchanged on the server |
| 1.5 Save dot while saving | **Fixed** | `dot ok` → `dot off` → `dot ok` across a field edit and a move |
| 1.6 Move-lead copy | **Fixed** | "Moving…" → "Moved to Data Science", then "Moved to Eng Leadership". A rejected request gives "Couldn't move it — try again" with the picker back on Eng Leadership |
| 1.7 Grid → Detail scroll | **Fixed** | Fernbrook Robotics picked in Grid: Detail list `scrollTop` 1722, row in view. Selecting another row keeps 1722 |
| 1.8 Default row highlighted in Grid | **Fixed** | On a fresh load, Stonebridge (Detail's default) carries `gr-sel`; an explicit Harborline selection carries too |
| 1.9 Link box on add | **Fixed** | Box still holds the link right after the click, is empty after success, and empty on a duplicate (Quillfeather selected, "Already in your applications"). A rejected add keeps the link, says "Couldn't save — try again" and adds no row |
| 1.10 Password dialog | **Fixed** | Focus on `#pwCurrent` at open; `.pw-msg` always present; card 399.9 → 405.5px, the same as old |
| 1.11 Gate | **Fixed**, one difference kept | Placeholders "Name"/"Password" with aria-labels and no `<label>`. Log out from `/applications` goes to `/` and focuses the password field. Kept: the disabled "Signing in…" button |
| 1.12 Tab title | **Fixed** | `document.title` is "Demo Job Search (sample data)" |
| 1.13 Theme toggle height | **Fixed** | `id="themeToggle"`, line-height 15px, 29px tall |
| 1.14 Link cell arrow | **Fixed** | "careers.quillfeather.example.com ↗" |
| 1.15 Tooltip and hint | **Fixed** | Full tooltip text; curly apostrophes in the tooltip and the hint |
| 1.16 Select while stage dialog open | **Fixed** | Reads "Offer" while the dialog is open, "Onsite / Loop" after Escape |
| 1.17 Logout revoke failure | **Fixed** | With `/api/logout` rejected: "Signed out here, but couldn't reach the server to revoke this session.", focus in the password field, URL `/`. The token left live was then revoked by hand |
| 1.18 Loading and load failure | **Fixed** (copy); placement kept | A rejected `/api/data` retries twice, then shows "Couldn't load: Failed to fetch (test)" in the page body; "Loading…" is kept. **Still open:** that text is `rgb(233, 235, 244)`, not red, because `.err` is only coloured under `#gate` |
| 1.19 Favicon | Kept on purpose | — |
| 1.20 Tile focus ring offset | **Fixed** | Live stylesheet has `.tile:focus-visible { outline-offset: 0px; }`. Checked as a rule; the keyboard walk wasn't repeated |

Still open after the re-check:

- **1.18's error text isn't red.** Give the page-body `.err` the `--crit` colour, or scope the rule wider than `#gate`.
- **Seen once, not reproduced.** In the first add-from-link of this round, the selection still read Stonebridge right after "Added — it fills in overnight". Three later adds selected the new row in the same frame. My read most likely raced the render; it's noted here so it isn't lost.
- **The `--sbw` gutter bug in both clients** is tracked separately.

Testing note: the in-app Browser pane reports `document.visibilityState` as `hidden` even with the tab in front. TanStack Query v5 parks retries while hidden, so a failed load sits on "Loading…" in this pane indefinitely. To exercise 1.18, the check overrode `visibilityState` to `visible`.

How things were checked: `getComputedStyle` and `getBoundingClientRect` in both
tabs, DOM outlines of the same row in each client, text sequences of the save
indicator polled every 20ms during a write, a real-keyboard Tab walk, 1280×800,
375×812 and 1280×560 viewports, and both themes. Writes were made on the demo
account only, on different rows per client, and every one was reverted: two
comp edits, two lead status changes, two lead moves, and four test
applications created and deleted.

## 1. Findings

Most user-visible first. Type is one of: missing feature, styling gap, copy
difference, bug.

### 1.1 Applications foot notes say something different — copy difference

- **Screen:** Applications, both views.
- **Old, Detail:** "Edits save when you click away. Days counts from the applied date."
- **Old, Grid:** "Quick-scan columns only — referral, notes, team, setup, comp, and the rest are in Detail view (click a row to open them). Edits save when you click away. Days counts from the applied date."
- **New, Detail:** "10 of 10 shown."
- **New, Grid:** "Quick-scan columns only — referral, notes and the rest are in Detail view. 10 of 10 shown."
- The old Applications tab has no "N of M shown" count at all. The leads tabs' notes now match.
- **How:** `.note` text in each tab.

### 1.2 Application list rows lose their placeholder labels — missing feature

- **Screen:** Applications, Detail list (`.md-row`).
- **Old:**
  - A "To Apply" row says "Not applied yet" where the applied date goes.
  - A row with no role shows "—" on the title line.
  - A row whose posting couldn't be read says "Couldn’t read the posting".
- **New:** all three slots are empty.
- **How:**
  - Stonebridge Systems (To Apply) row text is "Stonebridge Systems To Apply Staff Engineer, Platform Not applied yet" in the old client and has no trailing label in the new one.
  - A freshly added link-only row reads "example.com Applied — Applied 2026-09-11 · 0d" in the old client and "example.com Applied Applied 2026-09-11 · 0d" in the new one.
  - Neither "Not applied yet" nor "Couldn’t read the posting" appears anywhere in `X5bQimRS`.

### 1.3 Drill chip text isn't the accent colour — styling gap

- **Screen:** the chip a tile or funnel row adds, on Applications and All leads.
- **Old:** accent text, `rgb(45, 212, 191)` in dark, on every drill.
- **New:** `rgb(113, 120, 146)` (`--ink3`) in the Applications key row, and `rgb(233, 235, 244)` (`--ink`) in the leads toolbar. Background and border are still accent-soft/accent, so the chip reads as a grey or white label in a teal pill.
- **Cause:** the block appended to `client-react/src/tracker.css` (deployed as `.tile,.chip.drill,.jumplink{color:inherit}`) comes later than `.chip.drill{color:var(--accent)}` at the same specificity, so it wins.
- **How:** computed `color` on `.chip.drill` after clicking each of the 6 tiles and 5 funnel rows.

### 1.4 An expired session doesn't go back to the gate — bug

- **Screen:** any write after the token has been revoked (for example, logged out from another browser).
- **Old:**
  - The first 401 drops straight to the gate with "Your session has expired - sign in again."
  - Focus lands in the password field, and the name is prefilled.
- **New:**
  - The token is removed from storage, and the header says "Couldn't save — try again".
  - The field rolls back and the page stays up and fully usable. Every later edit fails the same way.
  - Only a reload shows the gate, and then with no message.
- **Cause:** `useWrite`'s `onError` treats `UnauthorizedError` like any other failure; only the `/api/data` query routes it to `onSignedOut`.
- **How:** in each tab, revoked the page's own token with `POST /api/logout`, then edited Referral and clicked away. Afterwards the old client showed `#gate` visible with that message and `activeElement` `passwordInput`. The new client still showed `#app` with no gate, `tracker_token` `null`, and save text "Couldn't save — try again".

### 1.5 The save dot stays green while saving — styling gap

- **Screen:** header save indicator, on every write.
- **Old:** the dot is grey (`dot off`) during "Saving…" and "Moving…".
- **New:** the dot is green throughout. The class is `dot ` during "Saving…", because `saved.saving()` sets tone `""` and the stylesheet only greys `.dot.off`.
- **How:** polled `.stamp .dot` className across a field edit, a status change, a move, an add and a delete. Old: `dot` → `dot off` → `dot`. New: `dot ok` → `dot ` → `dot ok`.

### 1.6 Moving a lead says "Saving…/Saved" instead of naming the tab — copy difference

- **Screen:** lead Detail, the track picker above the company name.
- **Old:** "Moving…", then "Moved to Engineering" (the destination's label). On failure, "Couldn't move it — try again".
- **New:** "Saving…", then "Saved". On failure, the server's raw error text; "Moved to", "Moving…" and "Couldn't move it" appear nowhere in the bundle.
- The row leaves the list and the visible tab stays put in both clients.
- **How:** save-text sequence across a move and a move back, in each client.

### 1.7 Switching Grid → Detail doesn't scroll to the row picked in Grid — bug

- **Screen:** All leads (any list tab). Expand a row near the bottom in Grid, then switch to Detail.
- **Old:** the list scrolls the selected row into view: `scrollTop` 1722, row top 704 inside a list spanning 260–800.
- **New:** the right row is selected but `scrollTop` stays 0. The row sits at top 2440 against a list spanning 274–814, so the detail pane shows a row you can't see.
- This is the "switching Grid to Detail lands on the highlighted row" line of the parity bar.
- **How:** `getBoundingClientRect` of `.md-list` and `.md-row.sel`, with Fernbrook Robotics picked in Grid.

### 1.8 Detail's default row isn't highlighted in Grid — bug

- **Screen:** Applications (any list tab), fresh sign-in, Detail then Grid.
- **Old:** the row Detail shows by default (the first row) carries `gr-sel` in Grid.
- **New:** no row is highlighted until one is clicked. Selecting explicitly in Detail does carry over.
- **Cause:** the default selection is computed but never written to `prefs.selected`.
- **How:** listed `tr.gr-sel` right after switching views. Old: Stonebridge Systems. New: `[]`.

### 1.9 Adding from a link empties the box before the server answers — bug

- **Screen:** Applications toolbar, "Add from link".
- **Old:** the box clears only when the new row renders; if the save fails, the pasted link is still there to retry.
- **New:** the box is empty in the same tick as the click (`setLink("")` in `add()`), so a failed add loses the link.
- **How:** read `#appurl.value` synchronously after `click()`: `""` while the header still said "Saving…". The success path is otherwise identical ("Added — it fills in overnight", new row selected).

### 1.10 Password dialog: focus doesn't move in, and the dialog grows — bug (focus), styling gap (height)

- **Screen:** "Signed in as Demo" → Change your password.
- **Old:** focus moves to "Current password" on open. The message line is always present (`.pw-msg`, `min-height:1em`), so the card is 399.9px before and 405.5px after a message.
- **New:**
  - Focus stays wherever it was: `<body>`, or the link that had focus. A keyboard user has to Tab into the dialog, and focus isn't held inside it.
  - The message element renders only once there is a message, so the card goes from 375.4px to 405.5px and the buttons jump 30px on the first validation error.
- **How:** `document.activeElement` right after opening; card height before and after pressing "Change it" empty.
- Copy, checkbox default, the three validation messages, Escape and backdrop-click are identical.

### 1.11 The gate differs in markup, focus and where it leaves you — copy difference / bug

- **Screen:** sign-in gate.
- **Fields:**
  - Old: the two inputs carry placeholders "Name" and "Password", with no labels.
  - New: visible `<label>`s "Name" and "Password" above inputs with no placeholders. The labels have no rule, so they render as 15px body text.
- **Signing in:**
  - Old: "Signing in..." appears in the red error line.
  - New: the button text becomes "Signing in…" and the button is disabled.
- **Focus after Log out:**
  - Old: the password field.
  - New: `<body>`.
- **URL after Log out:**
  - Old: the next sign-in lands on Overview.
  - New: the gate is shown at the old URL (`/applications`), so the next sign-in resumes that tab. The prefs are cleared, but the route isn't.
- **How:** gate DOM and `activeElement` after pressing Log out in each client. Wrong-password and empty-field messages are identical.

### 1.12 The browser tab title isn't the configured title — missing feature

- **Screen:** every page.
- **Old:** `document.title` is `settings.display_title` ("Demo Job Search (sample data)").
- **New:** stays "Job Search Tracker". `document.title` appears nowhere in the bundle.
- **How:** `document.title` in each tab after sign-in.

### 1.13 Theme toggle button is taller — styling gap

- **Screen:** header.
- **Old:** 29px tall, because `#themeToggle{line-height:1}` applies.
- **New:** 36.5px tall (line-height 22.5px). The button has no `id="themeToggle"`, so that rule matches nothing and the header's right-hand row is 7.5px taller.
- **How:** computed `line-height` and rect height of the toggle.

### 1.14 Applications Grid link cell drops the arrow — copy difference

- **Old:** "careers.quillfeather.example.com ↗".
- **New:** "careers.quillfeather.example.com".
- **How:** `td.lk a` text.

### 1.15 Add-application tooltip and hint are shortened or re-punctuated — copy difference

- **URL box `title`:**
  - Old: "The posting’s own page, not a search or a careers index — that page is what tonight’s run opens and reads. Greenhouse, Lever, Workday and company careers pages all work."
  - New: "The posting's own page, not a search or a careers index."
- **Hint once a link is typed:**
  - Old: "Tonight’s run opens the posting…" (curly apostrophe).
  - New: "Tonight's run…" (straight). The same straight quote is in the tooltip.

### 1.16 Stage-date dialog: the select shows the old status while it's open — styling gap

- **Screen:** application status select → a stage with no date yet.
- **Old:** the select already reads the stage you picked ("Recruiter Screen") behind the dialog, and reverts on Cancel/Escape/backdrop.
- **New:** the select stays on the current status ("To Apply") the whole time, because it's controlled.
- Title, subtitle, default date (today), focus on the date input, Escape, Cancel, backdrop-click, and refusing an empty date on Save or Enter are all identical.

### 1.17 No message when Log out can't reach the server — missing feature (from source)

- **Old:** "Signed out here, but couldn't reach the server to revoke this session." appears on the gate.
- **New:** `logout()` in `api/client.ts` swallows the failure, so the gate shows nothing. Not exercised live.

### 1.18 Loading and load-failure states differ — copy difference (from source)

- **Loading:**
  - Old: with a stored token, the page shows the sign-in card until `/api/data` returns.
  - New: shows "Loading…".
- **Failure:**
  - Old: "Couldn't load: <message>" on the gate.
  - New: the bare error message in the page body, for example "The server sent something this page did not understand."
- The new loading state is arguably better, but it differs, so it's listed.

### 1.19 Favicon — styling gap

- **Old:** none (`/favicon.ico` 404).
- **New:** serves `/favicon.svg`.

### 1.20 Tile focus ring offset — styling gap, trivial

- Neither stylesheet has a `.tile:focus-visible` rule, so both clients draw the browser's default ring.
- **Old:** `outline-offset: 0px` on the `<button>`.
- **New:** `1px` on the `<a>`.
- **How:** real Tab key presses, then `:focus-visible` and computed outline. Measured on the first bundle.

## Found during this review and already fixed

Found on `Ch74YGpz`; confirmed fixed on `X5bQimRS` or the current worker config.

- **Deep links returned 404.** `/all-leads`, `/applications`, `/t/engineering` and `/applications?drill=applied` came back as 404 with an empty body, so reloading or bookmarking any tab but Overview gave a blank page. Now 200. `/applications?drill=gone-quiet` loaded directly shows its chip and 2 rows, and `/t/no-such-track` falls back to Overview.
- **Leads Detail foot note** said "Editing arrives in Phase 4 — this view is read-only for now." It now has the old copy.
- **Leads Grid foot note** was missing "Edits save when you click away." Fixed.
- **Details/Hide in Grid** rendered as a raw browser button (Arial 13.3px, grey background, outset border) in both themes. Now plain.
- **The Applications Grid expanded row** had no Stage history and added a Notes box. It now matches.
- **Application detail** added "Tonight’s run will read this posting and fill in what it states." for rows waiting on the fill. Removed.
- **Remove application** was a "×" ghost button in the status row, titled "Remove". It is now the trash icon in the header, titled "Remove application".
- **Adding from a link** ended on "Saved". It now ends on "Added — it fills in overnight".
- **Lead detail** had a "Role details" heading and Notes inside the facts card. It now matches: no heading, Notes below.
- **The empty track's "hasn’t reported a clean run recently" warning** could never render for a stale track, because of `||`/`&&` precedence. The compiled bundle now parenthesises it.

## 2. Already known

Status on the current deploy (`X5bQimRS`):

- **Role details, Notes and Stage history cards unstyled:** confirmed on the first bundle (`fcard`, `fgrid`, `label.f`, `h4`). **Fixed**: `facts-card` > `mf-label` > `more-grid` > `mf`, and `stage-hist`, now render.
- **Application header static, applied date and stage-history dates not editable:** confirmed. **Fixed**: `input.dh-in` company, role and location, applied-date input, and seven editable stage dates.
- **Adding an application:**
  - Didn't select the new row: confirmed. **Fixed**, the new row is `sel`.
  - Duplicate-link detection: "Already in your applications" is now in the bundle, but not exercised.
  - Create defaults: both clients now create status Applied with today's date.
- **Autofill note:** confirmed missing. Both sentences and `.af-why` are now in the bundle. Not reachable with the demo data, which has no row with an `autofill_note`.
- **No track label on an application:** confirmed. **Fixed** (Harborline shows "Eng Leadership").
- **No "Open" link beside Link:** confirmed. **Fixed**.
- **Grid rows don't expand on row click:** confirmed. **Fixed** (clicking the Days cell expands and selects).

## 3. Checked and identical

- **Overview:**
  - Header title and subtitle.
  - All six tiles: label, count, footer and colour. Values 12, 10, 24, 9, 2, 2.
  - Tab badges: Applications 10, All leads 12, Engineering 6, Eng Leadership 3, Data Science 3.
  - Daily-search bars: counts 17/6/8, segment widths, legends, run stamps and their tooltips.
  - Funnel: 9 · 100%, 5 · 56%, 4 · 44%, 3 · 33%, 1 · 11%.
  - Pipeline legend ("1 offer, 2 rejected, 1 withdrawn, 56% responded · avg 4d to first response"), both section sublines and the foot note.
  - Pinned layout geometry at 1280×800.
- **Every drill:**
  - Each of 6 tiles and 5 funnel rows lands on the same tab, with the row count equal to the number clicked, the same chip text and the "Clear this filter" tooltip.
  - Track-name jumplinks work.
  - Clearing the chip, and a tab click dropping the drill, behave the same. The new client's back button restores a cleared drill, as intended.
- **Lists:**
  - All leads (24), each track (14/5/5) and Applications (10), with the same rows in the same order.
  - Pills, geo badges, "Found" dates, the track tag in All leads, the location key, "Closest roles sorted first" and the run stamp or "3 tracked searches feed this list".
  - Sort options, and Company A-Z order.
  - Status chips, and "Nothing matches / Try a different filter." with the search box keeping focus.
- **Grids:** column headers for both grids; the fill-state group rows ("Applications 7", "Waiting on tonight’s fill 3 · added by link, nothing to do") and collapsing them.
- **Detail panes (current deploy):** lead header, move picker, status row, facts card and Notes; application header inputs, facts and Stage history cards.
- **Writes:**
  - Save text for a field edit, a lead status change, adding an empty row and both deletes ("Saving…" → "Saved"), apart from the dot in 1.5.
  - Pill and tab-badge updates after a status change.
  - Remove prompts: "Remove <company> <role>?\n\nWhy? This is kept so the search doesn't find it again." with default "outside target locations"; "Remove <name> from Applications?"; "Remove this row from Applications?".
- **Stage-date dialog:** titles ("When is this scheduled?" and "When did this happen?"), subtitle, default date, focus, Escape, Cancel, backdrop and empty-date refusal.
- **Password dialog:** copy, validation messages, Escape and backdrop.
- **Gate:** "Job search access", "Sign in to continue.", "That name and password don't match.", "Enter your name and password.", and the name prefilled after sign-out.
- **Theme:** the toggle sets `data-theme`, stores `bjs.theme`, and swaps emoji and label the same way. Body colours match in both themes.
- **Keyboard:** header (who → Log out → theme) → tabs → tiles → funnel jumplinks, in the same order with the same 2px accent rings. Selecting a row keeps `.md-list` `scrollTop` (400 → 400).
- **Viewports:**
  - 375×812: no horizontal overflow; identical header, tab and toolbar geometry; Overview unpinned; list/detail stacked.
  - 1280×560: `.topbar` static, `.tabs` sticky, Overview unpinned.
- **`--sbw` after resizing a pinned Overview from 1280×800 to 375 wide:** identical, but wrong in both. It stays `15px` while the region no longer scrolls, so the tile row ends 15px short of the cards (347 vs 362). `usePinnedLayout`'s comment calls the ResizeObserver the fix for exactly this stale measurement; it doesn't cover this transition. A reload at 375 measures 0 in both.

Not reachable with the demo data, so not compared:
- an empty track
- a zero-count (disabled) tile or unreached funnel stage
- stale or error tab warning dots
- failed or partial autofill rows
- a duplicate-link add
- moving a lead to Applied (skipped to avoid creating an application in shared demo data)
