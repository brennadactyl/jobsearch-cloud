# Where a person can work is a setting

Every place that matters to a search - where the person would most like to work,
where else they'd accept, and anything ruled out - is structured data in their
settings. The nightly prompt is composed from it every run, the person edits it
in their account panel. The server passes the places to the prompt, and the
nightly search decides whether a posting's location fits them.

This changes `server/` (settings and the prompt), `client/` (the setup form and the account panel) and
the track docs (the tier table leaves them). The settings today are in
[schema.md](schema.md); the account panel is
[account-settings-plan.md](account-settings-plan.md).

Screens: [Location Settings mockup](https://claude.ai/artifact/Ko7iqbtZFdaghteN8e5nrw),
approved.

## Context

Only the preferred places are data today: `priority_locations`, rules the page
computes from a typed list. Everywhere else a person could work is prose - the
setup form's "What locations should be searched?" answer, turned overnight into
`geo_scope_line`, `scope_clause` and `scope_disqualifier`, which the prompt
reads and the model interprets each night. Each track doc also restates the
preferred tiers as a table, a copy that can drift from the settings. An
exclusion read as the scope once pointed a whole search at the one state its
person had ruled out; that class of mistake exists because scope is prose.

## The three lists

All three are typed as comma-separated lists and each is stored as one setting - one `meta`
value per list, holding the list as the person typed it. The two new keys need
no migration (`meta` is key/value); converting the stored `priority_locations`
rule arrays does - see Existing searches.

| Setting | Asked as | Stored as |
|---|---|---|
| `search_locations` | What locations should be searched? | the comma-separated list, e.g. "US, Greater Seattle area, Australia" |
| `excluded_locations` | Anywhere you can't take a job? | the comma-separated list, e.g. "Portland OR, Texas" |
| `priority_locations` | Which locations should come first? | the comma-separated list, in order, e.g. "Seattle, Portland OR, Raleigh NC" |

- **The page builds the ranking rules when it loads**, from `priority_locations`
  with the matcher it already has, to sort leads into tiers and colour their
  badges. Rules are never stored, so there is one copy of each list: the one the
  person typed.
- **Existing accounts convert deterministically:** each stored rule set becomes
  the comma-separated list of its labels, in order. The server, the prompt, the
  onboarding run and the demo data stop reading or writing rule arrays.
- **The prompt prints them as stored**, and the nightly search decides whether a
  posting's location fits. No code turns the first two into rules.
- **Preferred places are always searched,** even if the other two lists leave
  them out. The prompt says so, naming each preferred place.
- **Nothing is flagged or refused.** Each list is stored as typed, trimmed at
  the ends, and the prompt interprets it - including "Portland, OR", "WA" or
  "Greater Seattle area". The page's read-back only shows how the commas split
  each list, and the ranked list's order and tier colour.
- **One split rule, everywhere:** a list's entries are its text split on commas,
  each trimmed, empties dropped; an area matches an entry ignoring case, and is
  stored as the ranked entry is spelled ("portland or" is stored as "Portland OR").
  "Portland, OR" is two entries, "Portland" and "OR", and the read-back shows
  it that way. The server, `tracker.ps1`, the page and the one-time fill use this
  rule and no other.
- **Tier colours come from each lead's area** (below), not from matching text.
- **An optional note, `location_note`,** keeps what a list can't say - "open to relocating for
  the right team" - and reaches the prompt as context.

## Each lead carries its area

The person types areas - "Seattle area, Portland OR, Raleigh NC, Remote US" - and
the nightly search decides which one a posting belongs to. A lead keeps its real
location ("Kirkland, WA") and gains an **area**: the ranked entry it falls in,
exactly as typed ("Seattle area"), or empty.

- **The search picks it** when it files the lead, since it already judges
  whether the location fits. The prompt hands it the ranked list and asks for
  one entry or none.
- **Code checks it.** The tracker helper and the leads route accept an area only
  when it matches an entry in the person's ranked list, ignoring case, store it
  as that entry is spelled, and store it empty otherwise, so a near-miss like
  "Seattle" can't pass for "Seattle area".
- **The page tiers by the lead's area**, its rank being that entry's position
  in the list. No town matching. A lead with no area has no tier.
- **Applications** made from a lead carry its area. One added by hand gets an
  area from the overnight fill run, checked the same way, or none.
- **Renaming or removing a ranked entry** leaves the leads filed under the old
  name without a tier until a run re-files them; the page shows those as
  untiered, not wrongly coloured.
- A new field a run reports crosses three layers in one change: the column and
  route, `tracker.ps1`'s forwarding, and the prompt step.

## Restoring the tiers the migration lost

Accounts whose ranked places were set up by hand stored hand-picked terms under
each label, and converting to labels lost them, so most of their leads lost
their tier colour. Two steps put it right:

1. **Now:** each affected account's original rules are restored from the
   pre-migration backup as `priority_rules`, and the page tiers by those when
   present.
2. **Then:** once leads carry areas, a one-time fill gives every existing lead
   and application its area by running the page's matcher with those restored
   rules, checked so every location lands in the same tier before and after.
   Then `priority_rules` is cleared, account by account, and the page tiers
   only by area.

## The matcher retires

Once the page tiers by area and `priority_rules` is cleared, no code matches
location text to a tier. The matcher (`matchLocationTier` in
`client/src/domain/geo.ts`), its test, the rule-array reading and the area-fill
route are deleted then, together. `location-forms.json` stays, reduced to the
forms `verify-local` checks the prompt teaches; its tier expectations go with
the matcher. The server stores and validates text only.

## Rules the prompt states for every search

Fixed in `prompt.js`, the same for every account, so no night's model decides
them:

- **How a lead's location is written:** "City, ST" for a US city and "City,
  Country" elsewhere, as the posting gives it; "Remote (US)" or "Remote
  (<country>)" for a remote role; several locations joined with "; ". The forms
  live in one file, `client/src/domain/location-forms.json`, owned by Client
  Comrade. `verify-local` reads it by path and fails if the prompt doesn't
  teach every form in it. `location_guidance`
  is retired with the scope prose.
- **Remote:** a remote role is in scope when it is open to someone in a searched
  place; one restricted to a region or time zone outside the searched places is
  out.
- **Precedence:** a preferred place always qualifies; otherwise an excluded
  place is out; otherwise a searched place qualifies. A posting with several
  locations qualifies when any one of them does.
- **General rules every search shares** - hybrid or on-site in a place not
  searched is out, and no relocation is assumed - are stated here once. The
  person's note carries only what is personal to them.

## Where they are written

- **The account panel** through `POST /api/settings`, **setup** through the
  intake, and **an operator** through `POST /api/config`. `POST /api/writeup`
  never writes them: the overnight run doesn't own them.
- **Limits:** each list at most 50 entries of up to 80 characters, the note at
  most 1,000 characters, since the prompt carries them verbatim. The short-token
  warning is the page's alone, so the list of known state and country codes has
  one copy.

## The prompt reads the database

`prompt.js` composes the location step from the three settings every run: the
preferred places in order, the acceptable places, the rule-outs and the note, by
label. It stops reading `geo_scope_line`, `scope_clause` and
`scope_disqualifier`, and the write-up stops writing them. The tier table leaves
every track doc; the prompt carries the tiers from the settings instead. A
change to a person's places takes effect on their next run, with nothing to
rewrite.

## What the person sees

- **The setup form** keeps its live questions and wording. Its two free-text
  location answers become comma-separated lists with the same plain read-back,
  and it gains the optional note. It no longer holds the send over a ranked
  entry it can't match ("too short", "several places are called Portland").
- **The account panel gains a Locations section** with the same three lists and
  the note. Changes save through the account
  page's one Save and Discard, shared with every other section, and take effect on
  the next run, and the section says so.
- **Leads** keep their tier badges, from the ranked places as today.

## Existing searches

**The ranked places convert by migration:** one pass turning each stored rule
array into its labels in order, verified against a copy of real data first.
The other two lists come from drafts the operator approves, written through the
API.

Each draft also lists anything in that account's current prose that neither its
lists nor the fixed rules cover, so nothing is dropped silently.


Each built search has scope prose and no acceptable list. For each account, a
draft of its three lists is made from its current prose and shown to the
account's operator before it is written - it's a person's search geography, and
a wrong conversion would silently narrow or widen it. Then the prose fields are
cleared and the tier tables removed from the docs.

### The stand-in rules

A label alone doesn't rebuild the rule it named. An account whose rules were
set by hand or by the setup skill matched more than its labels - "Seattle area"
stood for Seattle, Bellevue, Redmond and Kirkland - so after the migration most
of its leads lost their tier. Those accounts keep their old rules, as they were,
in one more setting:

- **`priority_rules`**, the account's old `[{label, allOf?, anyOf?}]` array, or
  `[]`. The page ranks by it while it is set, and builds from
  `priority_locations` when it is empty. It is restored from the backup taken
  before the migration, and only for accounts whose tiers the migration changed.
- **Only an operator writes it,** through `POST /api/config`, checked for the
  rules' shape. `POST /api/settings` refuses it.
- **The person's own list replaces it.** The first time `priority_locations`
  is saved with a different value, `priority_rules` is dropped in the same
  write, so a stand-in can never contradict a list the person typed. Saving the
  same list again, as a save of another field does, keeps it. An operator write
  of a different `priority_locations` drops it too, unless it also sets
  `priority_rules`.
- **What the person loses on that first edit** is whatever their labels didn't
  say: "Seattle area" then matches only its own words unless they list Bellevue
  and Redmond themselves. The page says so beside the list.

## Releasing

The page ships first, reading `priority_locations` either as typed or as the
old rule array, so it keeps working whichever the server serves. Then the
server switches format and the migration runs. No same-sitting deploy is
needed, and the page drops the old format once the migration has run.

## Order of work

1. **Mockup** of the account panel's Locations section, for approval before
   anything is built. The setup form keeps its live questions and wording; only
   its two free-text location answers become place lists with the same read-back
   the ranked list already has, so it needs no new design.
2. **Settings** (Backend Buddy): the two new settings, their validation,
   verify-local.
3. **Prompt** (Prompt Bro): the location step from settings, the doc tier
   tables removed, the write-up no longer writing scope prose.
4. **Page** (Client Comrade): the setup form and the Locations section.
5. **Existing searches** converted, each draft approved first.
