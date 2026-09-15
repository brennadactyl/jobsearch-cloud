# Overview charts

The Overview answers three questions over time, not only as of today: whether
the search is gaining or losing momentum, which searches pay off, and where
applications move forward or stall.

This changes `client/src/components/Overview.tsx` and `client/src/domain/`, plus
one small server change for the momentum chart (§4). The six tiles at the top
stay as they are. The page is described in `client/README.md`, and the tables in
[schema.md](schema.md).

## Rules every chart follows

These apply to all three sections and are the acceptance bar for each.

- **Every number opens the rows behind it.** A column, a bar segment or a table
  cell is a link to the tab it counts, filtered by a drill from `drills.ts`.
  The figure is the length of that drill's rows, the same invariant the tiles
  hold. A zero is plain text, not a link.
- **Hover or focus shows the exact figure** in a tooltip: label, count, and
  share where one applies. Hit targets are at least the mark's full column
  height or row width.
- **Colour comes from the theme tokens in `tracker.css`**, in light and dark.
  No new palette. Magnitude uses one hue (`--accent`); `--good`, `--warn` and
  `--crit` keep their status meaning and always sit beside a text label.
- **Plain SVG and HTML, no chart library.**
- **A table view.** Each chart has a "Show as table" toggle that renders the
  same rows as an HTML table, for screen readers and exact reading.
- **Dates are local.** A `YYYY-MM-DD` field is bucketed as that calendar day,
  never through `Date.parse`, which reads it as UTC and moves every date one day
  back in Pacific time. Add a `localDay(d)` helper in `domain/format.ts` and use
  it for every date here.
- **Works at 400px wide.** Charts scale to the card; tables scroll sideways
  inside their own container.

## 1. Momentum

This answers "is my search speeding up or stalling?". It's a new section under
the tiles, before the per-search section.

Two column charts, stacked, sharing one week axis for the last 12 weeks.
Weeks start on Monday, local time.

| Chart | Counts, per week | Opens |
|---|---|---|
| Positions found | leads with `found` in that week, plus removed postings with their original found date (§4) | All leads, drill `found-week:<monday>` |
| Applications sent | applications with `dateApplied` in that week, `To Apply` excluded | Applications, drill `applied-week:<monday>` |

- The current week is drawn at reduced opacity and labelled "so far".
- Each chart is headed with this week's count and last full week's, e.g.
  `Found: 14 this week · 31 last week`. Text only, no delta colour.
- Removed postings don't appear on the leads tab, so the found-week drill opens
  only the leads still on it. The tooltip shows both counts: `31 found · 24
  still on your board`.
- The drills take a parameter, which `drills.ts` doesn't support today. Extend
  it so `found-week:2026-09-08` resolves to one predicate, and the label reads
  `Found week of Sep 8`.
- Fewer than two weeks of data: show the charts anyway, with the empty weeks
  at zero, rather than an empty state.

## 2. Which searches pay off

This answers "which of my searches is worth its nightly run?". It replaces the
per-search status meters in the "Daily searches" card, keeping each search's
run stamp and the subline about runs reporting on schedule.

A table with one row per search, plus a row for applications added by hand
(`leadId` empty), and a total row.

| Column | Counts |
|---|---|
| Search | label, linking to its tab, with its run stamp beneath |
| Found | leads for the search, plus its `screened` rows with `added_by = 'hand'` (postings you removed) |
| Open | leads in `New` or `Reviewing` |
| Not a fit | leads in `Not a fit`, plus the hand-removed rows |
| Applied | applications whose `leadId` is a lead in this search, `To Apply` excluded |
| Responded | of those, applications with any response date (same rule as the pipeline) |
| Apply rate | Applied ÷ Found, with a thin inline meter in `--accent` |
| Response rate | Responded ÷ Applied, blank under 3 applications |

- The `screened` schema in `api/schema.ts` gains `added_by`. `/api/data` already
  returns it.
- Rates show as whole percentages. The tooltip carries the fraction (`4 of 57`).
- Rows are sorted by the configured track order, not by any rate, so a row
  stays where you expect it.

Below the table, the same breakdown by location tier: one horizontal stacked
bar per `priority_locations` rule plus "Other", split into Applied, Open and
Not a fit. The segments use `--accent`, `--accent-soft` and `--line`, with a
2px gap between them and direct labels.

## 3. Pipeline flow and waiting

This answers "where do my applications stall, and what's been waiting
longest?". It replaces the funnel bars in the "Application pipeline" card.

**Flow.** One horizontal stacked bar per stage, for Applied, Recruiter Screen,
Tech Screen and Onsite / Loop. Each bar is 100% of the applications that
reached that stage, split into four parts:

| Segment | Rule | Token |
|---|---|---|
| Moved on | reached the next stage (its date is set) | `--accent` |
| Waiting | current status is this stage | `--accent-soft` |
| Rejected here | status `Rejected`, and this is the furthest stage reached | `--crit` |
| Withdrew here | status `Withdrawn`, and this is the furthest stage reached | `--line` |

"Furthest stage reached" is the last forward stage with a date set, in the
order Applied (`dateApplied`), Recruiter Screen, Tech Screen, Onsite / Loop,
Offer. `dateRejected` and `dateWithdrawn` never count as stages. Put it in `domain/` as one function
the four segments and their drills all call. An Offer row closes the chart: its
count and a link.

**Time to first response.** A histogram of days from `dateApplied` to the
earliest response date, in bins of 0–3, 4–7, 8–14, 15–30 and 31+ days. It's
headed with the median, which replaces the average the card shows today. Each
bin opens Applications, drill `response-days:<bin>`.

**Waiting longest.** The five applications in `Applied` or an active stage that
have gone longest since they last moved. Last movement is the latest of
`dateApplied` and the stage dates. Each row shows company, role, stage and
`N days`, and links to that application. A "See all" link opens Applications
sorted the same way.

The legend line (offers, rejected, withdrawn, % responded) stays under the flow.

## 4. Server: keep a removed posting's found date

Postings you remove, and postings delisted as taken down, leave the `leads`
table and become `screened` rows. Their `found` date is lost, so the momentum
chart would undercount every past week. Hand this to the server session.

- A migration adds `found TEXT NOT NULL DEFAULT ''` to `screened`.
- `POST /api/delete-leads` and the delist path copy the lead's `found` onto the
  screened row they write.
- Rows removed before the migration keep `found = ''` and are left out of the
  momentum chart. There's no backfill; the date no longer exists anywhere.
- `schema.md` is updated in the same change.

The client ships §1 without waiting for this. Until the column exists, the
found chart counts leads only and its tooltip says so.

## Tests

- `localDay` and week bucketing: a date on a Sunday and on a Monday, and the
  week containing a DST change.
- Parity for every new drill: the number the chart or table shows equals the
  length of the rows the drill opens, on the fixture. Parameterised drills
  included.
- Furthest stage reached: a rejection after a tech screen counts as rejected at
  Tech Screen, not at Applied. A withdrawn row with no stage dates counts as
  withdrawn at Applied.
- Each stage's flow segments add up to the number that reached the stage.
- Each chart's table view has the same rows and figures as the chart.

Before deploy, check it live on the demo account in light and dark themes and
at 400px wide. Also re-seed the demo account (`seed-demo-user.ps1 -Force`) so
its dates span enough weeks to fill the momentum chart.

## Not in this change

Nightly run history per search (needs a history table), goal or target lines,
and date-range filters.
