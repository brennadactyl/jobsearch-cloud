# A person decides how their tabs are split

A search fills one tab or several. Which tabs it fills is a person's decision,
made in their account panel, and it takes effect on that search's next run.

This changes `client/` (a control per tab and one confirm step), `server/`
(accepting a grouping change and re-checking what it invalidates), and the
track docs (the split leaves them). The settings today are in
[schema.md](schema.md); the panel is
[account-settings-plan.md](account-settings-plan.md).

## Context

`tracks.fed_by` already splits a search across tabs: a track whose `fed_by`
names another track is a tab that search fills, with no search of its own. The
prompt composes the whole split from config every night - the tab list, the
merged duplicate check, the filing step with each tab's description, the
tie-break, and a run record per tab - so a re-split reaches the run that night
with nothing regenerated.

Two things stand in the way of a person changing it:

- **Each multi-tab doc restates the split** in a table of tab keys, labels and
  descriptions, and the filing step tells the run the doc holds any finer rule
  for it. A re-split leaves that table describing a split that no longer
  exists, and the run is told to follow it. The same fact stored twice, with one
  copy nobody updates.
- **Grouping is only reachable through the route that replaces the whole track
  list**, where a stale page silently deletes a search added since.

## What a person sees

- **Each search's block gains "Where do this tab's finds come from?"** with two
  states: "Runs its own search", or "Filled by <search>", listing the account's
  other running searches. It maps one-to-one onto `fed_by`. No dragging: the
  page has none today, and this is a setting most people touch once.
- **Folding a search into another's group asks first**, naming what stops being
  read and quoting the search's own roles line back: "Data Science stops
  looking for 'Senior data scientist, experimentation or product analytics'.
  The Engineering search's rules fill this tab instead." It is the only thing in
  the panel that changes what another search does.
- **The confirm step says leads stay where they are.** A re-split changes what
  future runs write into a tab and not one existing row.
- **Promoting a tab to its own search is not in this change.** A new search
  needs a doc and a resume list before it can run, and only the overnight setup
  makes those, so the page would be offering a state it can't complete. It
  becomes nearly free once the doc split (below) has happened.

## What belongs in a tab is the tab's own words

`full_description` becomes the field that says what belongs in a tab, and the
finer filing rule with it - "software and digital-product companies that aren't
games or AI; file by the company, not the job title". The prompt already reads
it verbatim as the filing rule in step 7b.

- It is editable in the panel, a textarea beside the fit rules, with a hint
  saying the run reads it as this tab's filing rule.
- Nothing else reads it: no page renders it today, and tab names come from
  `label`. So a paragraph costs nothing on screen.
- The tab table leaves the doc template and the three docs that have one, and
  step 7b stops pointing at the doc for a finer rule. A rule about a tab lives
  with the tab a person edits, or it goes stale the moment they re-split.
- `doc_summary` on those searches mentions tabs, and is rewritten with them.

## How a grouping change is saved

**`fed_by` in `POST /api/settings`' `searches` entry**, beside the fields that
panel already saves, so one Save carries a person's whole change as one
transaction.

It must not go through `POST /api/config`: that route's `tracks` array replaces
the whole list, so a stale page deletes a search added since, and the delete
takes that track's run record with it.

Whichever route carries it, these checks are the route's, not the page's:

- a track can't feed itself, and `fed_by` must name another track on the
  account;
- a track that feeds others can't itself be fed, or the group has no root;
- **the readable-resume check on `documents` runs after the grouping changes,
  not before.** A tab is exempt because its root reads for it, so the exemption
  moves with `fed_by`: promoting a tab, or demoting a root, can otherwise leave
  a search with nothing to read.

**The alternative, rejected:** a narrow route taking only the grouping
(`{ groups: { <root>: [<tab>, ...] } }`), which cannot delete a search by
construction.

Two facts weigh against it. The settings route already cannot add or remove a
search - it writes a track's fields and never touches the track list, which is
why it isn't `POST /api/config` - so the guarantee is one this change already
has. And a second route costs the panel its single Save: a re-split becomes a
request that can land while the rest of the save fails, or the reverse.

What it would still buy is a smaller blast radius if the settings route grew
careless later. That is real, and it is not worth a second way in nor a save a
person can half-land: the guarantee is held by a test on the settings route, so
losing it is a failing check rather than a quiet regression.

## What a tab keeps while it is a tab

A tab's own `role_search_line`, `fit_clause`, `fit_disqualifier` and
`fit_filter_step` stay stored and stop being read: dormant, not deleted, so
undoing a fold restores exactly what the search looked for. The confirm step
says "aren't used while this is a tab", never "will be deleted".

Dormant prose ages badly - a year later it describes a search nobody remembers
agreeing to - so **un-folding shows those fields for review rather than
resuming them silently.**

## Its slot and its task

`schedule_time` is stored prose the scheduler reads; the server assigns nothing
and checks nothing. The panel asks for a slot when a search needs one,
defaulting to one free of the account's other searches.

Between the save and the scheduler being re-run, a search has a slot and no
task, and a search with no task simply never runs. The page says that rather
than implying tonight. Registering it is the scheduler's job.

## Order of work

1. **Docs** (Prompt Bro): the tab table out of the template, the doc pointer
   out of step 7b, the three existing docs reconciled as a live write on each
   person's go.
2. **Server** (Backend Buddy): the grouping field on the chosen route, its
   checks, and the `documents` re-check after a change.
3. **Page** (Client Comrade): the control per tab, the confirm step, the
   `full_description` field, and the slot question.
4. **Promoting a tab to a search**, after the track-doc split, which is what
   makes a new search's doc almost nothing to create.

## Not in this change

Splitting the track doc into its generated and accumulated halves is the
backlog item this leans on; it is what makes step 4 cheap. Re-filing existing
leads into another tab isn't here either: rows keep their tab, and moving one is
a per-lead action the page already has.
