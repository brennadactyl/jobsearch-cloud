# Cut the nightly prompt down

> Status: **built, not yet run against a live search** (2026-09-09). Originally
> measured against the live deployment at commit `372ac4e`. What landed, and
> what it actually saved, is at the bottom.

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

## What landed

All three levers, plus a fourth surface nobody had counted: the per-track
baseline docs, whose numbered process named the same endpoints the prompt did.
Those are reconciled through
`.claude/skills/job-search-setup/templates/tracked-postings.template.md` and the
`change-search-prompt` skill, which now describes four surfaces rather than
three.

`scripts/tracker.ps1` is the helper. `run-search.ps1` copies it into the run
directory beside the documents, writes a `tracker` shim next to it (the run's
shell is POSIX and cannot execute a `.ps1`), and sets `TRACKER_SEARCH` alongside
the two variables it already set. Eight commands cover every call a run makes:
`dedup`, `companies`, `leads`, `screened`, `verified`, `delist`, `swept`, `run`.
Beyond building the request it decides four things the prose used to ask for and
could not enforce - the track key, today's **local** date, url-not-id, and
omitting an unstated optional field rather than sending `""` - and refuses a
malformed row loudly, naming it, rather than dropping it. `./tracker dedup`
also asks the config which tabs this search feeds and merges them, so a
branched run no longer needs to be told its own tab list.

Measured on a fixture track with a deliberately tiny config, so the whole
difference is text this repo writes:

| | before | after |
|---|---|---|
| single tab, no rotation | 16,021 | 11,035 |
| branched + rotation | 22,470 | 15,765 |

The eight API steps went from 14,972 characters to 8,392; a 618-character
paragraph naming the helper once replaces what five steps each repeated about
checking a response, the environment variables being set, and when to skip a
call. That is about 6,400 characters off the fixed text, not the 15,000 the
steps used to occupy - because a good share of those steps was never calling
convention. "Only delist a posting you actually confirmed dead", "record the
run every single night without exception", "record what you swept or the
rotation starves" are judgements a helper cannot make, and they stayed at close
to full length.

Step 4 is untouched apart from one clause: the Google Careers case history
behind the truncated-vs-blocked rule moved into a comment in `prompt.js`. The
rule itself, and the verification requirement above it, are unchanged, and
`verify-local.mjs` now asserts both survive an edit - along with every
`./tracker` command the prompt has to name.

Still outstanding: the same-evening behavioural comparison above. It has not
been run.
