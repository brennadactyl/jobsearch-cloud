---
name: change-search-prompt
description: Change what a nightly job search does - across the four places its instructions live (scripts/tracker.ps1, server/src/prompt.js, each person's D1 track config, and each track's baseline doc in the tracker) - and reconcile the existing track docs so no track silently keeps following the old convention. Use when editing prompt.js or tracker.ps1, a track's baseline doc, the daily search or application-fill instructions, or any convention a scheduled run follows.
---

# Changing what a nightly run does

A run's instructions come from four surfaces, and picking the wrong one is
how a change reaches one track and not its siblings. Decide which before
editing anything.

| Surface | Holds | Reaches |
|---|---|---|
| `scripts/tracker.ps1` | the mechanics of every API call a run makes - the route, the body, the track key, the date, what a bad row does | every track, every person, on the next run; nothing to deploy |
| `server/src/prompt.js` | which command each numbered step invokes and what only the run can decide - what counts as verified, what to report | every track, every person, on the next server deploy |
| D1 track config (`/api/config`) | one track's stored prose - role line, resume line, fit filter, company list, location guidance | that one track, immediately, no deploy |
| `docs/tracked_<key>_postings.md` in the tracker (`/api/documents`) | knowledge with no DB equivalent - fit reasoning, per-company fetch-reliability notes, scope rules | that one track, immediately, everywhere - a run fetches it fresh |

The first two are one decision made twice: **if the change has a single right
answer, it goes in `tracker.ps1`, not in the prompt.** A rule stated in prose
is a rule the model can have a bad night about; the same rule in the helper
cannot come out wrong. That is why `search`, the local date, url-not-id and
"omit the key rather than sending an empty string" are no longer sentences
anywhere - see `docs/prompt-size-plan.md`. Prose is for what genuinely depends
on judgement: whether a page renders a real job description, whether a posting
is dead or merely unreachable, which tab a finding belongs in.

Posting data is in none of them. Leads, screened rows, coverage and run
history live in D1 and are fetched per run - a doc that keeps its own copy is
a doc that goes stale.

## The failure this skill exists for

**A cross-cutting convention changed in one track's doc silently drifts out of
sync in the others.** Nothing at runtime cross-checks the docs against each
other; each is self-contained. This has actually happened: one track's doc got
updated when the tracker migrated off an old hosting mechanism, its siblings
did not, and a later scheduled run confidently tried to publish through the
retired mechanism. It had no way to know the convention had moved on.

`job-search-setup`'s `templates/tracked-postings.template.md` is the shared
source of truth for a **new** track only. Nothing reconciles existing tracks
against it. That is the job below, and it is on whoever makes the change.

## Changing the calling convention (`scripts/tracker.ps1`)

Adding a route a run has to reach, changing a body, changing what happens to a
row that can't be sent: all of it lives here, as a command the prompt names.
`run-search.ps1` copies the file into each run's working directory alongside
the documents and sets `TRACKER_URL`, `TRACKER_API_TOKEN` and `TRACKER_SEARCH`,
so a change ships on the next run with nothing to deploy and nothing to
re-register.

Two rules the file is built around, both worth keeping:

- **A row it won't send is refused loudly** - named on stdout and counted in
  the summary line. The run writes its own report from that output, so a row
  dropped quietly is a run that reports a success it didn't have.
- **It decides nothing about the search.** It will not invent a lead, drop one
  for looking wrong, or turn an unreadable page into a delisting. Validation
  is limited to what makes a call well-formed.

Test it directly before trusting a run to it - it takes the same environment:

```powershell
$env:TRACKER_URL="..."; $env:TRACKER_API_TOKEN="..."; $env:TRACKER_SEARCH="<key>"
.\scripts\tracker.ps1 dedup
```

## Changing what the run is asked to do (`prompt.js`)

This is the right surface for anything that is the same for everybody and
genuinely needs judgement: what counts as verified, when a posting is dead
rather than unreachable, which tab a finding belongs in, what a run must
report. Those steps moved here precisely because they were byte-identical
across every hand-maintained copy, and a copy that silently lacked step 9c -
the run record - was a real documented failure: it is the only thing that
distinguishes "searched, found nothing" from "stopped running weeks ago".

- **Rationale goes in a comment, not in the emitted text.** Most of what a rule
  needs said about it - the incident that produced it, what the earlier
  approach got wrong - is for whoever might undo it, and that person is reading
  this file, not the prompt. Keep the operative sentence; put the post-mortem
  in the comment beside it. Step 4's verification requirement is the standing
  exception: it is stated at whatever length it takes.
- `server/verify-local.mjs` asserts that the composed prompt still names every
  `./tracker` command a run has to reach, and that step 4 still demands every
  candidate URL be opened. Add to that list when you add a step - a prompt
  that loses one does not error, it just searches more quietly.

- Keep structured what the *app* reads (`key`, `label`, `sort_order`,
  `schedule_time`, `target_companies`). Keep verbatim what only the model
  reads. The live prompts had drifted from the template that generated them
  and the drift was load-bearing - a resume line naming a text fallback the
  machine genuinely depends on, a sentence widening a company list beyond its
  apparent industry. Store a keyword and regenerate the sentence and all of
  that is silently gone.
- The multi-tab pieces are each the empty string when they do not apply. A new
  optional step follows that shape rather than becoming another config flag.
- `buildAutofillPrompt()` takes no arguments - the nightly application fill is
  the same text for everybody. Keep it that way.

**Read the result, do not imagine it.** The composed prompt is a route:

```bash
curl -s "$TRACKER_URL/api/prompt/<track key>" -H "Authorization: Bearer <that person's token>"
```

Do that for a track that has the feature and one that does not, and read both
in full. String interpolation across a 400-line prompt is easy to get subtly
wrong in ways that only show up at 3am in a log.

Deploying the server is what ships it - see `verify-and-deploy`. Nothing has
to be re-registered.

## Changing one track's stored prose

That is `/api/config` - a GET, merge, POST of the whole config. Read the
`job-search-setup` skill's step 6 for the exact procedure; it is the
GET-merge-POST that matters, because posting a partial config replaces what
was there.

If the change is really about *how searches work* rather than *what this
person is looking for*, it belongs in `prompt.js` instead. A convention parked
in one person's config is the drift problem in a different place.

## Changing a track doc, and reconciling the rest

The doc is edited by the run itself as it goes - that is why it is a document
and not config. It holds fit reasoning, the target-company list with why each is
there, the expanded net and what came of each attempt, and the per-company
fetch-reliability notes.

It lives in the tracker, not on a machine. A run fetches every document into a
throwaway directory, and writes back the ones it changed with `If-Match` (see
`scripts/run-search.ps1`). So there is one copy, it is backed up, and editing it
does not require being at the computer that runs the searches.

When the change is cross-cutting - how leads sync, the fetch-efficiency rule,
the fit-filter philosophy, the coverage rotation, anything the template's
numbered list covers:

**Deploy the server before you touch the docs.** The two halves do not ship
together: a `prompt.js` change reaches runs only once `server/` is deployed,
while a document change takes effect on the very next run with no deploy at
all. Change the docs first and every run reads instructions its prompt has
never heard of, for as long as the deploy is outstanding. The other order is
harmless - the docs briefly describe the old mechanism, and the prompt is what
the run is actually following.

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
   paste the template over it: the parts that are that track's own knowledge -
   reliability notes, expanded net, target companies - are the reason the
   document exists, and they are not recoverable.
4. **Send `If-Match` with the etag the GET returned.** A nightly run holds a
   document for the length of its turn and writes it back at the end; without
   the precondition, whichever of you finishes last silently erases the other.
   A 412 means a run landed while you were editing - re-fetch and redo the
   edit on top.
5. Say in your report which docs you changed, so any you could not reach are
   visible as a gap rather than assumed done.

These documents hold personal data. They are never committed - and since the
repo is public, never pasted into it either.

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
