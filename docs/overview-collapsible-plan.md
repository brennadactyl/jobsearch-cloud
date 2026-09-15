# Collapsible Overview

The Overview puts the sections a person acts on first, and lets them fold away
any section or chart they don't read. What they fold stays folded in that
browser.

This changes `client/src/components/Overview.tsx`, `charts.tsx` and
`ui/prefs.ts`. No server change. The charts themselves are as described in
[overview-charts-plan.md](overview-charts-plan.md).

## Order

The tiles stay at the top and don't collapse. Below them:

1. Daily searches
2. Application pipeline
3. Momentum
4. The footer note, which doesn't collapse

## What collapses

Every section and every chart inside one has its own control.

| Id | Section or subsection | Heading |
|---|---|---|
| `searches` | section | Daily searches |
| `searches.payoff` | subsection | Which searches pay off |
| `searches.location` | subsection | By location |
| `pipeline` | section | Application pipeline |
| `pipeline.flow` | subsection | Where applications move on or stall |
| `pipeline.reply` | subsection | Time to first reply |
| `pipeline.waiting` | subsection | Waiting longest |
| `momentum` | section | Momentum |
| `momentum.found` | subsection | Positions found |
| `momentum.applied` | subsection | Applications sent |

The ids are what's stored, so a renamed heading doesn't reset anyone's layout.

## How it behaves

- **The heading is the control:** the title and its subline, in one `<button>`
  with a chevron, `aria-expanded` and `aria-controls`. Controls that sit in a
  heading row, like "Show as table", stay outside that button, so using them
  never collapses anything.
- **A collapsed section keeps its heading and subline**, which work as its
  summary. Daily searches and Application pipeline already summarise
  themselves ("All 3 reporting on schedule", "9 applied · 2 in active
  conversation"). Momentum's subline becomes `14 found · 3 applied this week`
  instead of describing the axis.
- **A collapsed subsection keeps its title and sub-heading.** Its table toggle
  is hidden.
- **Collapsed content isn't rendered**, not just hidden, so its tooltips and
  links leave the tab order.
- **Sections and subsections fold independently.** Collapsing a section and
  expanding it again brings back each chart as it was.
- An empty-state card (no searches, no applications) belongs to its section
  and folds with it.
- **Everything starts expanded.**

## Remembering it

`Prefs` gains `overviewCollapsed: Record<string, boolean>`, stored per browser
under the `localStorage` key `bjs.overviewCollapsed` as JSON. It's the first
persisted preference that isn't a plain string. Only `true` entries are kept.
Unknown ids are ignored, and unreadable storage falls back to all expanded,
following the guard `read()` already uses.

The existing `collapsed` pref for Applications' fill-state groups is separate
and stays per session.

## Tests

- The sections render in the order above, with the footer note last.
- Each id toggles its own content and flips `aria-expanded`. The other ids are
  unaffected.
- Collapsing then expanding a section restores its subsections' states.
- "Show as table" switches the view without collapsing the chart.
- State survives a reload through `bjs.overviewCollapsed`. Malformed JSON
  in that key renders everything expanded.
- Momentum's subline counts match its charts' current-week columns.

Check it live on the demo account in light and dark themes, and at 400px.
