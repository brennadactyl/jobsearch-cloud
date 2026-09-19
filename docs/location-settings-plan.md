# Where a person can work is a setting

Every place that matters to a search - where the person would most like to work,
where else they'd accept, and anything ruled out - is structured data in their
settings. The nightly prompt is composed from it every run, the person edits it
in their account panel, and code, not a model's reading, decides whether a
posting's location is acceptable.

This changes `server/` (settings, the prompt, a location check on reported
leads), `client/` (the setup form, the account panel, one shared matcher) and
the track docs (the tier table leaves them). The settings today are in
[schema.md](schema.md); the account panel is
[account-settings-plan.md](account-settings-plan.md).

## Context

Only the preferred places are data today: `priority_locations`, rules the page
computes from a typed list. Everywhere else a person could work is prose - the
setup form's "Where can you work?" answer, turned overnight into
`geo_scope_line`, `scope_clause` and `scope_disqualifier`, which the prompt
reads and the model interprets each night. Each track doc also restates the
preferred tiers as a table, a copy that can drift from the settings. An
exclusion read as the scope once pointed a whole search at the one state its
person had ruled out; that class of mistake exists because scope is prose.

## The three lists

All three use the format `priority_locations` already has - `{label, allOf?,
anyOf?}` rules, computed by the page's matcher from a typed list and validated by
the server - and live in the account's settings:

| Setting | Asked as | Order |
|---|---|---|
| `priority_locations` | Which places would you most like? | ranked; the index is the tier |
| `acceptable_locations` | Where else would you take a job? | unranked; one tier below the last preferred place |
| `excluded_locations` | Anywhere you can't take a job? | unranked; a rule-out inside the other two |

- **The scope is computed, never written:** the preferred places, plus the
  acceptable places minus the excluded ones. **When answers conflict, including
  wins:** a preferred place is always in scope, even if an exclusion or a narrower
  answer would rule it out, because naming a place as a favourite is the
  stronger statement. The conflict is shown to the person, not refused.
- **The matcher knows broad places too:** a country ("US"), a state ("Colorado"),
  "Remote" with a country, and a city with its state when the name is shared. It
  never reduces an entry to a bare token of three letters or fewer.
- **An optional note** keeps what a list can't say - "open to relocating for the
  right team" - and reaches the prompt as context, never as scope.

## One matcher

The rules and the check that a location matches them are one module, used by
the page (to build rules, read them back and rank leads) and by the server (to
check reported leads). It has one copy. Where it lives so both builds import it
is Backend Buddy's and Client Comrade's call, and a test proves the page and the
server classify the same location strings the same way.

## The prompt reads the database

`prompt.js` composes the location step from the three settings every run: the
preferred places in order, the acceptable places, the rule-outs and the note, by
label. It stops reading `geo_scope_line`, `scope_clause` and
`scope_disqualifier`, and the write-up stops writing them. The tier table leaves
every track doc; the prompt carries the tiers from the settings instead. A
change to a person's places takes effect on their next run, with nothing to
rewrite.

## Code checks the location

When a run reports a lead, the server classifies its location with the matcher:

- **Inside the scope:** stored, with its tier.
- **Outside the scope or in a rule-out:** refused, naming the reason, and the run
  files it as screened out.
- **No location the matcher can read** (blank, "Multiple locations", a remote
  posting with no country): stored and marked "location unclear", so a person
  sees it rather than it being lost or guessed at.

## What the person sees

- **The setup form** asks the three lists in the order of the table, each with
  the read-back the preferred list already has, and the optional note. "Where
  can you work?" as free text goes.
- **The account panel gains a Locations section** with the same three lists and
  the note. A change saves through the header's save indicator, takes effect on
  the next run, and the section says so.
- **Leads** keep their tier badges; acceptable places get their own tier.

## Existing searches

Each built search has scope prose and no acceptable list. For each account, a
draft of its three lists is made from its current prose and shown to the
account's operator before it is written - it's a person's search geography, and
a wrong conversion would silently narrow or widen it. Then the prose fields are
cleared and the tier tables removed from the docs.

## Order of work

1. **Mockup** of the setup form's location questions and the panel's Locations
   section, for approval before anything is built.
2. **Matcher and settings** (Backend Buddy with Client Comrade): the shared
   module, the two new settings, their validation, verify-local.
3. **Prompt** (Prompt Bro): the location step from settings, the doc tier
   tables removed, the write-up no longer writing scope prose.
4. **Page** (Client Comrade): the setup form and the Locations section.
5. **Lead check** (Backend Buddy): classify, refuse, or mark unclear.
6. **Existing searches** converted, each draft approved first.
