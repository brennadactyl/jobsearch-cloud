---
name: change-search-prompt
description: Change what a nightly job search does - across the four places its instructions live (scripts/tracker.ps1, server/src/prompt.js, each person's D1 track config, and each track's baseline doc in the tracker) - and reconcile the existing track docs so no track silently keeps following the old convention. Use when editing prompt.js or tracker.ps1, a track's baseline doc, the daily search or application-fill instructions, or any convention a scheduled run follows.
---

# Changing what a nightly run does

A run's instructions come from four surfaces. Decide which one a change
belongs in before editing anything - the wrong one reaches one track and not
its siblings.

| Surface | Holds | Reaches |
|---|---|---|
| `scripts/tracker.ps1` | the mechanics of every API call a run makes - the route, the body, the track key, the date, what a bad row does | every track, every person, on the next run; nothing to deploy |
| `server/src/prompt.js` | which command each numbered step invokes and what only the run can decide - what counts as verified, what to report | every track, every person, on the next server deploy |
| D1 track config (`/api/config`) | one track's stored prose - role line, resume line, fit filter, company list, location guidance | that one track, immediately, no deploy |
| `docs/tracked_<key>_postings.md` in the tracker (`/api/documents`) | knowledge with no DB equivalent - fit reasoning, per-company fetch-reliability notes, scope rules | that one track, immediately, everywhere - a run fetches it fresh |

**If the change has a single right answer, it goes in `tracker.ps1`, not in
the prompt** - the helper cannot get it wrong; prose can. The helper already
owns the track key, the local date, identifying leads by url, and each
payload's shape. Prose is for what depends on judgement: whether a page
renders a real job description, whether a posting is dead or merely
unreachable, which tab a finding belongs in.

Posting data is in none of them. Leads, screened rows, coverage and run
history live in D1 and are fetched per run; never copy them into a doc.

## Cross-track drift

**A cross-cutting convention changed in one track's doc does not reach the
others** - nothing at runtime cross-checks the docs. `job-search-setup`'s
`templates/tracked-postings.template.md` covers new tracks only; reconciling
every existing doc is on whoever makes the change (procedure below).

## Changing the calling convention (`scripts/tracker.ps1`)

Adding a route a run has to reach, changing a body, changing what happens to a
row that can't be sent: all of it lives here, as a command the prompt names.
`run-search.ps1` copies the file into each run's working directory alongside
the documents and sets `TRACKER_URL`, `TRACKER_API_TOKEN` and `TRACKER_SEARCH`,
so a change ships on the next run with nothing to deploy or re-register.

Keep the file's two rules:

- **A row it won't send is refused loudly** - named on stdout and counted in
  the summary line. The run writes its report from that output, so a quietly
  dropped row becomes a reported success.
- **It decides nothing about the search.** It will not invent a lead, drop one
  for looking wrong, or turn an unreadable page into a delisting. Validation
  is limited to what makes a call well-formed.

Test it directly before trusting a run to it - it takes the same environment:

```powershell
$env:TRACKER_URL="..."; $env:TRACKER_API_TOKEN="..."; $env:TRACKER_SEARCH="<key>"
.\scripts\tracker.ps1 dedup
```

## Changing what the run is asked to do (`prompt.js`)

This is the surface for anything that is the same for everybody and needs
judgement: what counts as verified, when a posting is dead rather than
unreachable, which tab a finding belongs in, what a run must report.

- **Rationale goes in a comment beside the rule, not in the emitted text.**
  Keep the operative sentence in the prompt. Step 4's verification requirement
  is the exception: it is stated at whatever length it takes.
- `server/verify-local.mjs` asserts that the composed prompt still names every
  `./tracker` command a run has to reach, and that step 4 still demands every
  candidate URL be opened. Add to that list when you add a step - a prompt
  that loses one does not error.
- Structure only what the *app* reads (`key`, `label`, `sort_order`,
  `schedule_time`, `target_companies`); store what the model reads verbatim,
  never as a keyword the prompt regenerates into a sentence.
- The multi-tab pieces are each the empty string when they do not apply. A new
  optional step follows that shape rather than becoming another config flag.
- `buildAutofillPrompt()` takes no arguments - the nightly application fill is
  the same text for everybody. Keep it that way.

**Read the result, do not imagine it.** The composed prompt is a route:

```bash
curl -s "$TRACKER_URL/api/prompt/<track key>" -H "Authorization: Bearer <that person's token>"
```

Do that for a track that has the feature and one that does not, and read both
in full - interpolation mistakes don't error.

Deploying the server is what ships it - see `verify-and-deploy`. Nothing has
to be re-registered.

## Changing one track's stored prose

That is `/api/config` - GET the whole config, change it, POST the whole thing
back; a `tracks` array missing a track deletes that track. The
`job-search-setup` skill's step 6 has the exact procedure.

If the change is about *how searches work* rather than *what this person is
looking for*, it belongs in `prompt.js` instead.

## Changing a track doc, and reconciling the rest

The run edits the doc as it goes. It holds fit reasoning, the target-company
list with why each is there, the expanded net and what came of each attempt,
and the per-company fetch-reliability notes. It lives in the tracker: a run
fetches every document into a throwaway directory and writes back the ones it
changed with `If-Match` (see `scripts/run-search.ps1`).

When the change is cross-cutting - how leads sync, the fetch-efficiency rule,
the fit-filter philosophy, the coverage rotation, anything the template's
numbered list covers:

**Deploy the server before you touch the docs.** A doc change takes effect on
the next run; a `prompt.js` change only once `server/` is deployed. Docs first
means runs read instructions their prompt doesn't know.

1. Make the change in
   `.claude/skills/job-search-setup/templates/tracked-postings.template.md`
   first, so new tracks are born correct.
2. **Then bring every existing doc into line.** List one account's, with the
   session token from their `tracker.json`:

   ```bash
   curl -s "$TRACKER_URL/api/documents" -H "Authorization: Bearer $TOKEN"
   ```

   Every person, every track - not just the one you were iterating on. Each
   account has its own token, so this is once per account.
3. For each, `GET /api/documents/docs/<file>`, edit, and `PUT` it back. Do not
   paste the template over it: the track's own knowledge - reliability notes,
   expanded net, target companies - is not recoverable.
4. **Send `If-Match` with the etag the GET returned**, or a run finishing
   after you silently erases your edit (or you erase its). A 412 means a run
   landed while you were editing - re-fetch and redo the edit on top.
5. Say in your report which docs you changed, so any you could not reach are
   visible as a gap rather than assumed done.

These documents hold personal data. Never commit them or paste them into the
repo - it is public.

## If a run needs a capability it does not have

Headless runs use a scoped tool allowlist in `scripts/run-search.ps1`
(`Read Write Edit Glob Grep WebSearch WebFetch Bash`), not full permission
bypass. If a prompt change needs something outside it, add it there
deliberately and say why in the comment. Never reach for
`--dangerously-skip-permissions`.

## Testing a prompt change

Run it end to end before trusting the schedule:

```powershell
.\scripts\run-search.ps1 -Task <track key> -User <user id>
```

**Run it against a test account, not the primary one.** A live run writes
leads, screened rows, coverage sweeps and a run record, and a delist report
cannot be undone. Read `private/<user-id>/logs/<track>.log` afterwards, then
reload the tracker page and check the tab's run stamp - what the run *says* it
did and what landed in D1 are two different claims.
