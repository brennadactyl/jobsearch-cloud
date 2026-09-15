# Export the job lists

A person can download both of their job lists as CSV files and open them in
Excel, Google Sheets or Numbers:

- **Positions found**: the postings the nightly searches turned up, from any
  track's leads tab or the pooled "All leads" tab.
- **Positions applied for**: the Applications tab, where a lead goes once its
  status is set to Applied, along with applications added by hand.

Each list is exported on its own tab, as its own file, because the two have
different columns (a found posting has a fit note and a date it was confirmed
live; an application has a date for each stage it reached).

This changes the tracker page in `client/` only. No route, column or migration
changes: `GET /api/data` already delivers every lead and application to the
page, and the export is built from that in the browser.

## Context

The tracker is the only place a person's search results live. Today the way
to get them into a spreadsheet, send them to a career coach or a friend who's
referring you, or keep a copy after the search ends is to copy rows off the
page one at a time. The Grid view is shortest, and it's built for a fast scan
rather than a complete record: referral, team, work setup and notes are only
in Detail view.

## What the person sees

An **Export** button in the toolbar of every leads tab (each track and the
pooled "All leads" tab) and of the Applications tab. Its label carries the
count, `Export 12`, and its tooltip says "Download these 12 rows as a CSV
file".

- **It exports the rows the list is showing**, in the order it shows them:
  the status chip, the text filter, a drill from an Overview tile and the sort
  all apply. The count is the same `rows.length` the "12 of 40 shown" note
  already prints, so the button and the note can't disagree. To export
  everything, clear the filters, the same as seeing everything.
- **It exports every field, not the visible columns.** The file has the same
  columns in Grid and Detail view.
- **When the list is empty the button is disabled.** An empty file is never
  downloaded.
- **Filename:** `<tab label>-<YYYY-MM-DD>.csv`, for example
  `Applications-2026-09-15.csv`. The date is today's local date, since the
  person and the nightly runs are in the same timezone. Characters that aren't
  allowed in filenames become `-`.
- A click downloads the file directly: no dialog, and nothing to confirm.
  Nothing is written to the server, so the save indicator stays silent.

## Columns

Headers are the labels the page already uses, taken from `domain/constants.ts`.
A label renamed there gets renamed in the file too. Dates are written as the
API sends them, per the tracker's rule that date-only fields print verbatim.

**Leads**

| Column | Source |
|---|---|
| Search | the track's label (`tracks[l.search].label`), on every leads tab, not only the pooled one, so files from two tabs can be combined |
| Company | `company` |
| Role | `title` |
| Location | `location` |
| Location tier | `geo(location, priority_locations).label`, empty when no rule matches |
| Status | `status` |
| Found | `found` |
| Confirmed live | `verified` |
| Fit | `fit` |
| Referral, Comp range, Team / product, Work setup | `ROLE_FIELDS` |
| Posting URL | `url` |
| Notes | `notes` |

**Applications**

| Column | Source |
|---|---|
| Company | `company` |
| Role | `title` |
| Location | `location` |
| Location tier | as for leads |
| Status | `status` |
| Applied, Recruiter Screen, Tech Screen, Onsite / Loop, Offer, Rejected, Withdrawn | `STAGE_HISTORY_FIELDS`, the dates each stage was first reached |
| Referral, Comp range, Team / product, Work setup, Link | `APP_ROLE_FIELDS` |
| Notes | `notes` |

Left out on purpose: row ids, `leadId`, `source`, `resume`, `delistedOn`,
`autofill` and `autofill_note`. They're either bookkeeping or fields the page
itself doesn't show, and a column the person has never seen on the page is one
they can't interpret in the file.

## The file format

- **RFC 4180 CSV.** Every field is quoted, `"` inside a field is doubled, and
  lines end with CRLF. Notes and fit text contain commas and line breaks; this
  keeps each one in its own cell.
- **UTF-8 with a byte-order mark.** Without the BOM, Excel on Windows opens
  UTF-8 as the system codepage and garbles accented company and city names.
- **Formula injection is neutralised.** Any cell that starts with `=`, `+`,
  `-`, `@`, a tab or a carriage return gets a leading `'`. Company, role and
  location text is copied from scraped career pages, so a posting can plant a
  formula that runs when the file is opened in a spreadsheet.

## How it's built

- `client/src/domain/export.ts`: pure functions with no React. It has one
  column list per kind (header, value getter), `toCsv(columns, rows)` and
  `exportFilename(label, date)`. The column lists are the single definition of
  what a file contains.
- The download is a `Blob` plus a temporary object URL on an `<a download>`,
  revoked straight after the click. This is the page's first file download.
- The list a tab renders and the list the button exports must be the same
  array. `LeadsTab` and `ApplicationsTab` already compute `rows`, filtered and
  sorted, and they pass that same array to the button. The button never
  filters again on its own.

## Tests

- `toCsv`: quotes, commas, embedded newlines, empty strings, the BOM, CRLF,
  and every formula-leading character, including a value that is only `-`.
- **Parity:** with a filter, a text query and a drill applied to the fixture,
  the exported rows equal the rendered rows, in the same order. This extends the
  drill invariant the page already enforces, so an export can never quietly
  include a row the list hid.
- Every header comes from `constants.ts`, not from a literal in `export.ts`.
- The button is disabled on an empty list, and its count matches the "N of M
  shown" note.

Before deploy, check it live on the demo account: export from a track tab, All
leads and Applications, and open each file in Excel and in Google Sheets.

## Not in this change

- Excel `.xlsx` output: CSV opens in every spreadsheet app without a library.
- The screened-out list. It isn't a tab on the page today.
- A server export endpoint, or scheduled or emailed exports.
- **A full "download my data" export** (config, documents, run history). The
  hosted service with sign-up needs one for account deletion and data
  portability, and it belongs to the server, not to this button.
