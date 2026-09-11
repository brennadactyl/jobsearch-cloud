# Make the company rotation unconditional

Every search rotates. There is no track that does not, and no state in which the
rotation steps are withheld.

> **Status.** §1 is implemented: `prompt.js` emits 1c, 9d and 9e for every
> search, and `db.countCoverage` is gone. §2 and §3 were overtaken by
> [one-company-list-plan.md](one-company-list-plan.md) - there is one company
> list for every search and every user, so no track can be without a rotation.
> An empty list happens only on a deployment that has never added a company, and
> `GET /api/coverage` answers it with an empty slice rather than an error, so
> 9d can start the list. The rest of this document describes the per-track
> `company_sweeps` design as it stood before that change.

## Context

`prompt.js` gates steps 1c, 9d and 9e on whether the track already has
`company_sweeps` rows:

```js
const rotates = Number(coverage) > 0;
```

Step 9d is the only thing that creates those rows. A track with none never
receives it, so it can never acquire one — the gate holds itself shut. Nothing
errors; the track sweeps its whole list every night for as long as it exists.

That is what happened to `CPM`. It had zero rows, so its prompt carried neither
1c nor 9d, and with 9d went `./tracker swept` — the documented way to register a
company. The run tried to register T-Mobile and Nordstrom by hand and reported
back: *"rejected every payload shape I tried — 13 variations now across two runs
— that endpoint's schema isn't documented anywhere I could find."* It was right.
For its prompt, it wasn't.

`coverage.js` already states the principle the gate breaks. `GET /api/coverage`
404s on an unknown key rather than return an empty list, because "an empty list
from a mistyped key would read as 'nothing to sweep', and a run would quietly
search nothing at all". Deleting the steps produces the same silence.

There is no list size at which rotating is wrong. A batch is
`Math.min(COVERAGE_BATCH, eligible.length)`, so a five-company rotation returns
all five every night and wraps — identical to not rotating, plus sweep records
and shared `company_fetch` intel.

The switch is gated on data, not on config, so a track's prompt changes the
moment rows exist and no deploy is involved. Seeding `CPM`'s 64 rows on
2026-09-10 took its prompt from 17,499 to 20,544 characters that evening.
Anything measuring prompt size or run output has to treat a seeding as an event.

All four searching tracks rotate today (48, 59, 64, 64). This governs the next
track added.

## The approach

### 1. Delete the switch

`rotates` and its three `: ""` branches go. Steps 1c, 9d and 9e emit for every
track.

Step 3 stops restating the company list. It currently reads "Step 1c is the list
for today, drawn from: `<target_companies>`", which names a smaller and older
set than 1c just handed over — 12 companies behind for `engineering-management`,
17 for `product`. Step 3 refers to the step-1c companies and nothing else.

### 2. A track cannot exist without a rotation

`db.replaceTracks` already provisions a new track's dependent row:

```sql
INSERT OR IGNORE INTO search_runs (user_id, track_key) VALUES (?, ?)
```

The rotation gets the same treatment on the line below, seeded from the company
list supplied with the track. Registration only — no sweep date, so the first
run starts at the front of the list.

### 3. An empty rotation is an error

`GET /api/coverage/<key>` currently answers a track with no rows `200` and
`total: 0`. Under this plan that state is a misconfiguration, and the route says
so the way it already does for an unknown key.

Ships after §2, never with it or before it — a track created between the two
deploys would be unreachable rather than merely un-rotating.

### 4. Remove the optionality at its source

`job-search-setup` introduces the switch in prose:

> **Seed the track's company coverage** *if* its company list is long enough that
> one run can't verify all of it properly — roughly a dozen companies and up.

Seeding becomes part of creating a track, not a judgment about list length.
`add-target-company` writes the company to the rotation, since the rotation is
the list.

## Where target_companies goes

`${companies}` appears once in `prompt.js`, in step 3. Step 3 is the only path
by which `target_companies` reaches a run, so step 3 dropping it and the field
keeping its contents cannot both hold — emptying the step empties the field of
any effect. Each of the three things it currently carries needs a destination
before that step changes.

**The list.** For `engineering-management` and `product` it is a plain list of
37 and 43 names, 36 and 42 of which are already rotation rows — a frozen subset
that discovery has overtaken. Goes to the company list, which is global — see
`one-company-list-plan.md`.

**How to reach each company.** Most of `SWE`'s and `CPM`'s ~2,800 characters:
which ATS endpoint to hit, that Twitch's Greenhouse JSON API works where its
HTML mirror does not, why to enumerate Hasbro's Greenhouse board rather than
`company.wizards.com`. These are facts about a careers site, true for anyone
who fetches it, which is what `company_fetch` is for —
`0010_company_fetch.sql`: "a row here describes a *website*, never a *search*."
The delivery path already exists: `handleGetCoverage` attaches the shared row to
each company it hands a run, and `./tracker companies` writes the whole response
to `companies.json`. Per company, on the night that company comes round, instead
of a wall of prose every night.

The move is a write, not a pointer. As of 2026-09-11 the table is broad and
shallow — 63 companies reachable through the rotations, 58 of those rows written
by last night's runs, and only 5 carrying an `endpoint` at all. The prose holds
per-company detail that is not in there yet: Twitch's Greenhouse JSON API, Epic's
and Scopely's board ids, the Workday CXS paths. Transcribe it into
`company_fetch` rows and confirm it is there before step 3 stops carrying it.

**Which verticals to prioritise, and why.** Gaming before creator platforms
before the expanded net. This is the person's own strategy, it is small, and it
stays in `target_companies` — which is what `prompt-size-plan.md` keeps under
"what stays".

Step 3 changes only after the first two have somewhere to be.

One name needs reconciling before the list half is redundant:
`Hasbro/Wizards of the Coast` in `target_companies` against
`Wizards of the Coast` in the rotation. Reconcile to `Wizards of the Coast` —
the applications fill wrote that spelling onto application 84 from the
Greenhouse board itself, so it is what the postings say and it now reaches the
tracker from two independent sources. `SWE`'s rotation has the same problem
internally, with `Cursor (Anysphere)` and `Cursor Anysphere` as separate rows.

## Files

- `server/src/prompt.js` — remove `rotates`; unconditional 1c, 9d, 9e; step 3
  stops naming `target_companies`
- `server/src/db.js` — `replaceTracks` seeds `company_sweeps`
- `server/src/routes/coverage.js` — refuse a track with no rotation
- `.claude/skills/job-search-setup/SKILL.md` — seeding is not conditional
- `.claude/skills/add-target-company/SKILL.md` — write to the rotation

## Verification

`verify-local.mjs` covers the new cases: a freshly created track has a rotation
without anyone seeding it, a track with no rows is refused rather than answered
empty, and a rotation shorter than `COVERAGE_BATCH` returns all of it every run.

The prompt shrinks for tracks whose `target_companies` is a bare list, and grows
by 1c/9d/9e for any track that was not rotating. No track in the current
deployment is in the second case.

## Not in scope

Retiring `target_companies` as a field. What is left after the list and the
fetch facts move — which verticals to prioritise and why — is the person's own
strategy and stays.

The `board` column duplicated across `company_sweeps` and `company_fetch` —
tracked separately in issue #2.
