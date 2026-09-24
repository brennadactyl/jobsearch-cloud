# One clock, read from the config

The machine asks the tracker what to run instead of holding a copy of the
schedule. This changes `server/` (one endpoint) and the runners
(`scripts/setup-scheduler.ps1` shrinks; a dispatcher replaces the per-search
tasks). Nothing is built.

## Context

A search runs because a Windows task exists for it on Brenna's PC, registered
by `scripts/setup-scheduler.ps1` from the config as it stood when someone last
ran that script. The schedule is therefore a copy, and the copy drifts: a track
added in the tracker has no task until someone remembers, a paused search keeps
its task until someone re-runs the script, and a task disabled by hand stays
disabled with nothing in the tracker saying so. Pausing CPM on 2026-09-24
showed all three: the server refused its prompt immediately, while its task sat
disabled on the machine, and the tidying step is still outstanding.

The searches are also meant to leave that PC. A hosted runner has no task
registry to keep in step, so any work that makes the registry more reliable is
work that is thrown away at the move.

## The change

**One recurring task, not one per search.** The machine runs a dispatcher: it
wakes on a fixed interval, asks the server which searches are due, and runs
those. No task names a search, so nothing on the machine has to change when a
search is added, renamed, paused or resumed.

`setup-scheduler.ps1` shrinks to registering that one task and the nightly
backup. The per-search registration, the skip for a fed tab, the skip for a
paused search and the unregister-and-report all go: the dispatcher asks, and
the answer already accounts for them.

## What the server answers

A new endpoint, `GET /api/due` (name to settle), returns the searches whose
slot has come and which should run: not paused, not filled by another search,
written up, and not already run today. The caller passes the instant it is
asking about.

**It answers with a claim, not a list.** A search returned to one caller is not
returned to another until that run finishes or the claim ages out. Two things
need this, and neither is hypothetical: the transition, where a cloud
dispatcher and the PC are both live for a while, and retries, where a run that
died halfway must be safe to re-offer without risking two runs of the same
search on the same night. The run record each search already writes is what a
claim is built on.

The endpoint is the whole of the server's part. `schedule_time`, `paused_since`,
`fed_by` and `role_search_line` are already stored and already read; this
composes them into an answer instead of leaving each caller to derive it.

## What it costs

- **A single point of failure.** One dispatcher that doesn't fire means no
  search runs, where today a broken task costs one search. The mitigation is
  the run-health reporting that already exists: a night with no runs at all is
  the signal, and it has to be watched.
- **A schedule that is no longer visible in Task Scheduler.** Today "what runs
  tonight" can be read from the machine. Afterwards it is the tracker's answer,
  and the dispatcher's log. That is the point of the change, but it is a
  habit to relearn.
- **Claim semantics are the fiddly part**: how long a claim holds, what happens
  to a run that dies without reporting, and what a second caller sees. This is
  where the design attention goes.

## What it replaces

The nightly "make the tasks match the config" sync, which was the other way to
stop the drift. That sync keeps the registry and keeps every rule that reads it
- register, skip, unregister, report - and none of it survives the move off the
PC. The dispatcher removes the registry instead.

## Order

1. The endpoint and its claim, with verify-local covering a paused search, a
   fed tab, a search not yet written up, one already run today, and two callers
   racing for the same search (Backend Buddy).
2. The dispatcher, replacing the per-search tasks, with `setup-scheduler.ps1`
   reduced to registering it (Fullstack Friend, with Prompt Bro on what a run
   needs at its start).
3. The PC's existing per-search tasks removed once the dispatcher has run a
   full night correctly, with the old ones disabled rather than deleted for a
   night first.

## Not in this change

Moving the searches off the PC. This is what makes that move small, not the
move itself.
