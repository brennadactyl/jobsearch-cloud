# Pausing a search

A search can be paused: it stops running, and everything it found stays where
it is. Un-pausing brings it back as it was.

This changes `server/` (a column, the config and prompt routes),
`scripts/setup-scheduler.ps1` and `client/` (the tab and the Overview). The
tables are in [schema.md](schema.md).

## Context

The only way to stop a search today is to retire it: take it out of the
config and purge it, which deletes its leads, screened rows and sweeps.
Disabling its scheduled task by hand stops it too, but only until the next full
scheduler run registers the task again from the config. A person whose search
has served its purpose wants neither: the leads and applications are their
record, and they may want the search back.

## The switch

`tracks.paused_since` (ISO instant, empty when running), set on a feed group's
root. A tab filled by that search (`fed_by`) is paused with it.

- **A person pauses their own search in the panel**, through `POST /api/settings`
  under `searches`, beside the fields that section already saves. `POST
  /api/config` still carries it for an operator. A migration adds the column.
- **The server stamps the instant**, not the page: a save says paused or
  running, and the server writes the time it happened or clears it.
- **Pausing keeps everything:** leads, applications, screened rows, sweeps, the
  track doc and the config are untouched. The shared company list keeps the
  search's place in its rotation, so it resumes where it stopped.

## What stops, deterministically

- **The run stops itself, and nothing else stops it.** A paused search keeps its
  scheduled task; the task fires on its slot, the run asks the server, and the
  run ends. Pausing is enforced in one place, so there is no registry to
  disagree with the tracker: the check holds on any machine whatever tasks it
  has. Nothing unregisters a task - not the scheduler script, not a run.
- **A paused search runs a task that does nothing**, every night, and its log
  line is the only trace. That is the design, not a fault.
- **`GET /api/prompt/<key>` refuses a paused search** with a sentence naming
  when it was paused, so a task left over on some machine can't run it. The
  refusal carries a stable code beside the sentence, and the runner branches on
  the code, never on the English.
- **A refused run records nothing.** A paused search writes no run row and no
  error: an error every night would talk over the tab's Paused state and read as
  a search that broke. The runner says it is paused and exits without failing.
- **Nothing marks it stale.** A paused search is not a search that stopped
  reporting.

## What the person sees

- The tab stays, with all its leads, and its run stamp reads **Paused** with the
  date, in place of the last run. No amber "hasn't run" dot.
- The Overview's searches table keeps its row, marked Paused, and the "reporting
  on schedule" line counts only running searches.
- **Pausing and resuming is the person's own action**, in the account panel's
  Searches section: each search says Running or Paused since a date, and the
  control switches it, inside the panel's one Save. Pausing asks first, naming
  what stops and saying the leads stay. Nobody's search is paused for them.
- **A paused search's other fields stay editable.** Pausing is not archiving.
- **The pause holds from the save**, because the run itself refuses. Nothing on
  any machine has to be told, so the panel says nothing about tasks.

## Order of work

1. **Server** (Backend Buddy): migration, config, prompt refusal, the data the
   page reads, verify-local.
2. **Scheduler** (Fullstack Friend): skip and unregister, reported.
3. **Page** (Client Comrade): the Paused stamp, the Overview row and line.
4. **Pause Brenna's CPM** through config (Prompt Bro, on her go), then run the
   scheduler once and confirm CPM has no task. Its task is disabled by hand
   until then.
