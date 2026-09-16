# The tracker exists the moment setup is sent

Sending the setup form builds the person's search. They land on their own
tracker straight away - their title, their tabs, their location tiers - empty
and waiting for the night. The overnight run then writes only the parts that
need judgement.

This changes `server/` (POST /api/intake writes config), `client/` (the form
hands over to the tracker, and becomes a settings screen), and `scripts/`
(run-onboarding does the judgement half only). It builds on
[onboarding-plan.md](onboarding-plan.md), which describes the form and the
routes as they are today.

## Context

Everything the form collects is either a value or prose. Values need no model:
the page title, pronouns, the ranked locations the page already computes, the
excluded companies, and one track per role block. Today all of it waits for an
overnight run, so a person who signs up sees a form and a promise until
morning.

What genuinely needs the run is the prose the daily prompt reads verbatim,
written from the resume, plus the machine-side work - a token, a folder, the
scheduled tasks.

## Who owns which field

This split is the whole design, and nothing may cross it.

| Written on send, by code | Written by the overnight run |
|---|---|
| `display_title`, `pronouns`, `excluded_companies` | `role_search_line`, `full_description` |
| `priority_locations` (the page's computed rules) | `geo_scope_line`, `scope_clause`, `scope_disqualifier` |
| One track per role: `key`, `label`, `sort_order` | `fit_clause`, `fit_disqualifier`, `fit_filter_step` |
| `schedule_time` left empty | the track doc, and `schedule_time` when the tasks are registered |

- **The form owns its half.** Every send overwrites those fields from the
  answers.
- **The run owns its half.** A send never overwrites the run's fields, and the
  run never writes the form's.
- A track `key` is a slug of the role name, unique in the account, and fixed at
  creation. Renaming a role later changes `label` only, so no lead is orphaned.

## Two states, not one flag

`intake.status` stops meaning "setup finished" and means "written up":

- **`pending`** - the tracks exist and the tracker renders. A banner says
  tonight's run fills in the rest.
- **`done`** - the run has written the prose and registered the tasks.
- **`failed`** - the run couldn't, with its note. The tracker still renders.

The answers are write-once. POST /api/intake accepts one intake per account and
refuses a replacement, so no state returns to `pending` by a person's hand.

## A half-built search must not run

Deterministic refusals, not instructions:

- `GET /api/prompt/<key>` refuses a track with an empty `role_search_line`,
  naming it, rather than composing a prompt around a default.
- `setup-scheduler.ps1` registers no task for such a track. It currently invents
  a time when `schedule_time` is empty; that stays for tracks that are written
  up, and a track that isn't is skipped and reported.
- The scope check from [onboarding-plan.md](onboarding-plan.md) runs on send,
  in the server, not overnight: an empty `work_scope`, or no preferred location
  inside it, is a 400 with the field named. The person fixes it while they are
  still on the form.

## What the person sees

- **On send:** the tracker, with their tabs and title, and a banner that
  tonight's run fills in the rest. No waiting screen, and no way back to the
  form: the first send is the only send, and the button says "Start my search".
- **On failure:** the tracker with the run's note. The run retries on the
  following nights with the same answers, up to three nights, then stops and
  the note says to ask whoever invited them. Nothing a person could retype
  reaches the search, so a retry loop is the only thing worth offering.
- **Changing the search afterwards** is what it is today: the tracker's own
  config and the job-search-setup skill, not this form.

## The two write paths

`POST /api/intake` writes the form's half once, in one transaction with the
intake row, and returns success only; the page then re-reads `/api/data`.
`POST /api/writeup` takes a track key and only the fields the run owns, and
refuses any other key by name. Neither path can write the other's fields,
whatever it is sent.

**The scope check** counts a preferred location as inside the scope when the
scope text contains its label or one of its terms, and refuses only when none
of them match. Loose on purpose: this one blocks a person mid-form, so a false
refusal costs more than a scope the run has to interpret.

**Bounding the retries** without a schema change: `GET /api/intake/pending`
stops listing a `failed` intake more than three days after `sent_at`. An
`attempts` column counting nights is the better shape and is a separate change,
with its own migration.

## Order of work

1. **Server** (Backend Buddy): POST /api/intake writes the form's half through
   the existing config path, the scope check moves to the route, `GET
   /api/prompt` refuses an unwritten track, `verify-local` covers the ownership
   split both ways.
2. **Client** (Client Comrade): hand over to the tracker on send, the banner,
   the settings screen, and drop the polling change.
3. **Run** (Prompt Bro): write the prose half and the machine-side work only,
   and never the form's fields.
4. **Scheduler** (Fullstack Friend): skip and report tracks that aren't written
   up.
5. **End to end** (Fullstack Friend, with Brenna): sign up, send, land on the
   tracker, then confirm the night fills it in.

## Not in this change

Deleting a role block, `fed_by` pairs from the form, and editing the prose the
run wrote.
