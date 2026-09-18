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

- **Set through the tracker's own config**, `POST /api/config`, like the rest of
  a track's settings. A migration adds the column.
- **Pausing keeps everything:** leads, applications, screened rows, sweeps, the
  track doc and the config are untouched. The shared company list keeps the
  search's place in its rotation, so it resumes where it stopped.

## What stops, deterministically

- **`setup-scheduler.ps1` registers no task for a paused search**, and
  unregisters one that exists, reporting it by name - the same way it skips a
  track that isn't written up.
- **`GET /api/prompt/<key>` refuses a paused search** with a sentence naming
  when it was paused, so a task left over on some machine can't run it.
- **Nothing marks it stale.** A paused search is not a search that stopped
  reporting.

## What the person sees

- The tab stays, with all its leads, and its run stamp reads **Paused** with the
  date, in place of the last run. No amber "hasn't run" dot.
- The Overview's searches table keeps its row, marked Paused, and the "reporting
  on schedule" line counts only running searches.
- Pausing and resuming from the page belong to account settings; until then it
  is a config change made for the person.

## Order of work

1. **Server** (Backend Buddy): migration, config, prompt refusal, the data the
   page reads, verify-local.
2. **Scheduler** (Fullstack Friend): skip and unregister, reported.
3. **Page** (Client Comrade): the Paused stamp, the Overview row and line.
4. **Pause Brenna's CPM** through config (Prompt Bro, on her go), then run the
   scheduler once and confirm CPM has no task. Its task is disabled by hand
   until then.
