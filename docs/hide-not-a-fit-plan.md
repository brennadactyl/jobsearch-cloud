# Leads tabs open on what's still open

A leads tab first shows the postings still waiting on you, `New` and
`Reviewing`. Postings marked `Not a fit` are one chip away rather than mixed
into the default list.

This changes the tracker page in `client/` only. Nothing is deleted or moved:
a `Not a fit` lead keeps its row, notes and status, and still blocks the
nightly search from re-adding it.

## Context

Across the deployment, 130 of 694 leads are `Not a fit`. The default "All"
view lists them beside the ones that need a decision. The default sort puts
them last, but they still pad every list and every count.

## What the person sees

The status chips on every leads tab (each track and All leads) become:

`Open` · `New` · `Reviewing` · `Not a fit` · `All`

- **`Open` is the default** and is selected when the URL has no `filter`. It
  shows `New` and `Reviewing`.
- **`All` is explicit**, `?filter=All`, and shows every status the tab holds,
  `Not a fit` included.
- The note under the list keeps `N of M shown`. M still counts every row the
  tab holds, so the difference makes the hidden rows visible.
- **Marking a lead `Not a fit` while in `Open`** takes it out of the list
  straight away, and selection moves to the next row. The save indicator reads
  `Marked Not a fit — hidden from Open`.
- **When `Open` is empty but the tab isn't**, the empty state says `Nothing
  open` and names the count, e.g. `12 marked Not a fit`, linking to that chip.
  It replaces "Nothing matches · Try a different filter", which suggests the
  person filtered something out.

## The rule, in one place

The default lives in `domain/drills.ts`, not in `LeadsTab`:

- `drillRows` treats a leads target with no `filter` as `filter: "Open"`.
  `LeadsTab` reads the same resolved filter, so an Overview figure and the list
  it opens can't disagree.
- `Open` is a named predicate (`New` or `Reviewing`), exported for other code to
  reuse. The Overview charts' `open` column (see
  [overview-charts-plan.md](overview-charts-plan.md)) uses it.
- A target that means every status says `filter: "All"`.

Existing Overview links:

| Link | Change |
|---|---|
| Tile "Tracked leads" | becomes **"Open leads"** with no filter. Its count drops to New + Reviewing, matching the list it opens |
| Tile "Untriaged" (`filter: New`) | none |
| Tile for the top location tier (`top-geo-open`) | none; the drill already excludes `Not a fit` |
| Overview charts `found-week:<monday>` | the target carries `filter: "All"`, since a week's finds include postings since marked Not a fit |

The tab badge counts (`New` only) don't change.

## Tests

- No `filter` param renders `Open`, and `filter=All` renders every status.
- Parity: for each Overview target in the table above, the figure equals the
  rows the tab renders when opened.
- Changing a lead to `Not a fit` under `Open` removes it from the list and
  selects the next row.
- The empty state's count and link when every row is `Not a fit`.
- CSV export from `Open` leaves out `Not a fit`, and from `All` includes it.
  The export already follows the rendered rows; this pins it.

Check it live on the demo account, which has leads in every status.
