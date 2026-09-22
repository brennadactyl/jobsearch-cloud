# Editing what a search looks for

Each search matches on a few stored fields: the roles it looks for, what makes
a posting worth keeping, and what rules one out. They are set once at setup,
and only an operator can change them after. This puts them in the account
panel, per search, inside the page's one Save.

This changes `client/` (the Searches section, which already edits each search's
name) and `server/` (the settings route, which gains the fields). No run is
involved and nothing is regenerated: the prompt is composed fresh from the
config every night, so what a person saves is what that search's next run
reads.

## What the panel edits

One block per search, under the name it already edits.

| Asked as | Field | What a night does with it |
|---|---|---|
| What roles should this search look for? | `role_search_line` | Names the roles both searching steps look for, at the known companies and in the discovery sweep. Empty falls back to "roles matching the resume" - a real search, but a vague one. |
| What makes a posting worth keeping? | `fit_clause` | Joins what a finding must be, beside "genuinely new", "verified live" and the location rule. A test applied to a posting already found, not a search. |
| What rules a posting out? | `fit_disqualifier` | Joins the reasons a posting is screened out, beside dead-on-arrival, wrong level and duplicate. What it matches is recorded as screened with a reason, so a wrong edit shows on the Screened tab the next morning. |
| The lowest pay worth showing | `pay_floor` | An amount. The prompt composes a clause into each side of step 7 from it: a posting is a find when the top of its stated range reaches the floor or it states no range, and is disqualified when the top is below it. |

**The pay floor is a number, and the rule lives in the prompt.** A floor stated
loosely is decided differently on different nights, and a floor written into
prose at save time freezes that day's rule in every row: a later refinement
would reach new saves only, and every search set up before it would keep the
old sentence with nothing failing. So the page stores what the person said -
the amount, in one canonical form - and `prompt.js` composes the wording every
run, the way the location step is composed from the lists.

**It joins step 7's two lists, not a step of its own.** Step 7 is where a
posting is sorted into a find or a disqualification, and it carries its own
reasons; a floor placed earlier would be a second screening authority that step
7 doesn't mention. It also matters for what a person sees: what step 7
disqualifies is recorded with a reason, so a floor there reads on the Screened
tab as "range tops out below the floor", while a rule in its own step is
recorded only if its prose remembers to say so.

**What is stored.** `pay_floor`, the amount in digits, `''` when unset; and
`pay_floor_unit`, `year` or `hour`, `year` by default - two values rather than
free text, so the prompt composes from a known set. **Currency is assumed to be
USD**, since every account is US today; a column nobody sets is worse than this
sentence, and one is added when someone needs it.

The page takes what a person types - "180k", "180,000", "$180,000" - and stores
the digits, then shows the amount back as it will be read: "$180,000 a year".
A panel that stores something a person doesn't recognise is where the first bug
report comes from.

That costs the two columns and their migration, the clauses' wording in
`prompt.js`, and `verify-local` checks for the two composed shapes and for a
search with no floor composing nothing.

**Accounts with a pay rule already typed** keep it. `fit_filter_step` stays a
field a person writes freehand, for a search whose screening needs a paragraph
of its own, and nothing stored changes until someone sets a floor in the panel.

**An hourly floor is stated, not converted.** The composed clauses say the
floor and its unit and leave the judgement to the run, rather than turning
hours into a year inside the prompt - no run multiplies by 2,080 to decide. A
posting stating only an annual range against an hourly floor is not comparable,
and is not disqualified, the same as a posting with no range at all. Both
clauses say so, since a run reading only the disqualifier list would otherwise
have to infer it.

**An empty floor composes nothing** - not "no floor", not an empty clause. A
search without one reads exactly as it does today.

**The clauses join lists, so their wording is constrained.** The finding list
is joined with "and" and the disqualified list with commas, so a floor sentence
carrying its own commas reads as extra list items. The composed clauses go last
in each list and stay comma-light. This is why a hand-written floor reads
awkwardly in that list today.

**The fit fields show the whole sentence.** A floor is an extra condition on
the same posting, not a replacement, so what the run reads is the person's own
clause and the composed one as one list. The page shows both together under the
field, so nobody writes a rule that contradicts the floor without seeing it.

**What the panel doesn't edit.** The rest of a search's fields are machinery
written in the register a run follows - `doc_summary`, `report_line`,
`screened_examples`, `leads_note`, `intro_note`, `search_note` - or are owned
elsewhere: `fed_by` by the tab structure, `documents` by the resume chooser,
`schedule_time` by the scheduler, and `resume_line` by the rule that a run is
handed its resume as a file and never by name. `target_companies` is not edited
because nothing reads it: a search covers a slice of the one shared company
list and finds new employers in its discovery step.

## Where they are written

**`POST /api/settings`, under `searches`, beside `label`**:
`searches: { <key>: { label?, role_search_line?, fit_clause?,
fit_disqualifier?, pay_floor? } }`. Every field is optional, only what changed
is sent, and a key this account doesn't have is a 404 naming it. Refusals stay
`{ error, search, field }`, so a message lands beside the field it is about.

**Not `POST /api/config`.** Its `tracks` replaces the whole track list, so a
save carrying only the search someone edited would delete their other tabs and
those tabs' run rows. Config stays what it is - the tab structure, written by
setup and by an operator - and the settings route keeps the guarantee the
rename was built on: it can write a search's fields but can never add or remove
a search.

## What the person sees

- **Each search's block** holds its name, then the questions, in the Searches
  section the panel already has.
- **The panel's one Save** carries them with everything else it owns, and the
  sidebar marks a section holding unsaved changes.
- **Stored at once, read tonight.** The section says which it is: the value is
  saved immediately, and that search's next run is where it shows. Every one of
  these is prose a model reads, not a filter the server applies, so the effect
  is visible the next morning in what the search found and what it screened.
- **Four warnings, shown beside the field and never blocking a save**, since
  each is a way of writing that quietly costs a person leads:
  - A preference in either fit field ("prefer companies with a strong design
    culture") screens out almost everything and reports a quiet night. Each
    entry must be something a posting either is or isn't.
  - A fit clause that reads like a search ("look for Staff roles at AI labs"):
    it is a test, not a search.
  - An empty role line, which widens the search to "roles matching the resume".
  - A place typed into a fit field when the location lists already say where to
    look. Two copies of one rule drift; the location lists are its home.
  - Pay typed into a fit field when the floor above already says it, for the
    same reason.
- Works at phone width and in both themes.

## Worth knowing

**These fields are also ones the onboarding run writes.** Nightly runs never
touch them, so an edit is safe day to day. A setup that is re-run would
overwrite a person's own words, which today happens only for a setup still
pending or failed.

**Nothing here touches the candidate profile.** That is written from the resume
and rewritten only when the resume changes, so editing a fit clause never
changes it.

## Existing searches

**A floor already written by hand has to come out of the prose as the number
goes in.** Some searches carry their pay rule inside `fit_clause` and
`fit_disqualifier` today. Setting `pay_floor` on one of those makes step 7 say
it twice, in two wordings. So the conversion is one change per affected search:
set the floor, and strip the floor sentence from the two prose fields in the
same write. It is a live write on a real person's search, drafted by Prompt Bro
and approved by the account's person before it is sent, and it is a step of
this work rather than something assumed.

Until a search is converted, the panel showing a search's own clause and the
composed one together is what makes the duplicate visible.

## If this should be smaller

The pay floor is the only part that needs a column, a migration and a prompt
change. Dropping it leaves the other three questions, which need nothing new
stored. What it doesn't leave is a page-composed sentence: a rule frozen into
each row at save time is worse than a field not built yet.

## Not in this change

Adding or removing a search, editing the prose a run wrote (the candidate
profile, a doc's summary), the shared company list, and the schedule.
