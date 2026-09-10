# Cut the nightly prompt down

> Status: **proposed, not started** (2026-09-09). Measured against the live
> deployment at commit `372ac4e`.

## Context

The SWE track's composed prompt is 30,824 characters; CPM's is 21,584. Four
searches run nightly, each paying that before it does any work, and a long
prompt is not only cost - it is attention spent on procedure rather than on the
search.

Measured against the live config, the weight is not where it looks:

| | chars | share |
|---|---|---|
| Fixed instruction text in `prompt.js` | ~23,700 | 77% |
| Per-track config in D1 (8 fields) | 5,019 | 16% |
| Per-user prose in `meta` (5 keys) | 2,079 | 7% |

So this is not a case of anyone's config having grown. **Three quarters of it is
text this repo writes**, and the single largest block is procedural: the steps
that teach the model to call the API - 1b, 1c, 8, 9, 9b, 9c, 9d, 9e - total
**15,393 characters, half the prompt**, spent every night explaining six HTTP
calls that never change.

The largest per-track item is `target_companies` at 2,793 characters, which is
9% of the total and is the search's actual subject matter.

## The approach

### 1. Replace the API prose with a command the run invokes (~10-12k)

The run already gets a working directory materialized from the tracker
(`scripts/run-search.ps1`). Ship a small `tracker` helper into it the same way,
and the prompt stops describing calls and starts naming them:

```
9. Sync new postings:  ./tracker leads leads.json
9b. Record screened:   ./tracker screened screened.json
9c. Record the run:    ./tracker run --status ok --leads 8 --screened 5
```

in place of the curl invocation, the JSON shape, the field semantics and the
"don't do X" warnings around each. The prompt keeps *what* to send and *when*;
the helper owns *how*. It also removes a class of failure the prose can only ask
about - a malformed body, a missing `search` key, an id sent where a url was
wanted - because the helper constructs the call rather than the model.

Steps 1b and 1c become `./tracker dedup` and `./tracker companies`, writing
their results to files the run reads.

### 2. Move the rationale out of the emitted text (~4-6k)

A large share of the fixed text explains *why* a rule exists: what went wrong on
a particular date, why an earlier approach was wrong, what a failure looked like.
That is maintenance context for whoever edits `prompt.js` - which already keeps
plenty of it in comments - and it does not need to reach the model nightly. Keep
the operative sentence, drop the post-mortem around it.

### 3. Collapse the repeated warnings (~1-2k)

"Never delete or move anything yourself", "report by url, not id", and "`search`
is this run's own key" each appear in several steps. State each once, in the
step that first needs it.

## What stays

- `target_companies`, the fit clauses, `geo_scope_line` - the per-track judgment
  the search is actually made of.
- Step 4's verification requirement. It is the premise of the whole exercise and
  the thing a shortened prompt would be most tempting to soften.
- The headless preamble in `run-search.ps1`, which exists because a run once
  backgrounded itself and synced nothing.

## Files

- `server/src/prompt.js` - all three changes land here.
- `scripts/tracker.ps1` (new) - the helper, materialized into the run directory
  alongside the documents.
- `scripts/run-search.ps1` - copy the helper in beside the documents.
- `server/verify-local.mjs` - assert the composed prompt for a fixture track
  still names every endpoint the run has to reach.

## Verification

Size is the easy half:

```bash
curl -s "$TRACKER_URL/api/prompt/SWE" -H "Authorization: Bearer $TOKEN" | wc -c
```

Behaviour is the half that matters, because a prompt that drops a load-bearing
instruction produces a worse search silently rather than an error. Before
merging, run one track against both prompts on the same evening from a **test
account** and compare: leads added, screened added, companies swept, and whether
the run record and the doc write-back both landed. A shorter prompt that finds
fewer postings is a regression, not a saving.
