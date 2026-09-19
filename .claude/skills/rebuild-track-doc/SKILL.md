---
name: rebuild-track-doc
description: Rebuild one search's baseline doc and its config to the current ruleset - screening rules moved into config, fetch notes onto the shared company list, history and stale summaries removed - drafted locally, checked, shown to the user, then written back with byte-level checks and watched through the next night's run. Use when a search's doc or config has drifted from the ruleset, or a refused doc edit's notes need rescuing.
---

# Rebuilding a search's doc

A search reads its baseline doc (R2, `docs/tracked_<key>_postings.md` unless
`doc_file` says otherwise) and its config (D1) every night. Over time a doc
collects what belongs elsewhere: screening rules that belong in config, fetch
notes that belong on the shared company list, dated history. This rebuilds both
to the ruleset in `role-prompt-bro`, without changing what the search looks for.

The template is
`.claude/skills/job-search-setup/templates/tracked-postings.template.md`.
Everything is drafted locally first; nothing live changes before step 7.

## 1. Save what is live

Save locally, outside the repo:

- the live doc;
- the track's config, with the tabs it feeds and the account's settings
  (`GET /api/config`);
- the shared company list (`GET /api/coverage/<key>?all=1`).

## 2. Draft section by section

- **`## Candidate Profile`** - resume content only, plus a best-fit sentence.
  It names no file.
- **What this search is looking for** - preferences, appetite for level, kinds
  of employer. Never a company list.
- **How to weigh fit** - verbatim from the template.
- **Fed tabs** - their keys and labels and the rule for filing between them,
  with no default tab.
- **Company notes** - only:
  - guards that stop a wrong delisting;
  - observations about a company's roles;
  - companies tried.
- **Screening rules found in the doc** move into `fit_clause`,
  `fit_disqualifier` or `fit_filter_step`. List every contradiction between doc
  and config, and which side won.
- **Fetch notes** are dropped when the shared list already has the route.
  Otherwise report them as "routes the list lacks"; never keep them in the doc.
- **Settings** (scope, locations, exclusions) are never changed here. Report
  any gap between them and the doc instead.

## 3. Draft the config change

Only the fields that change. Usually `doc_update_line` becomes `""` - a line
inviting the run to edit fit rules in the doc is what caused the drift - and
`doc_summary` is updated to match the new doc. `resume_line` never names a
file.

## 4. Check the draft

- no `{{`;
- no ISO dates, and no history words ("used to", "as of", "corrected",
  "retracted");
- exactly one line starting `## Candidate Profile`, and it is exactly that;
- no resume filename;
- no screening wording outside "How to weigh fit";
- nothing about where the search looks: no location table, no place rules -
  step 5 of the prompt prints the person's own lists.

## 5. Read the composed prompt

Compose the prompt from the current config and from the new one with
`tools/proof/prompt-snapshot.mjs --configs <dir>` (the directory stays outside
the repo), and read the diff for doubled clauses or contradictions.

## 6. Show the user

The draft doc, the config changes, and every decision from step 2. For someone
else's search, the user decides whether its owner sees it first.

## 7. Apply, on the user's go in this session

1. Fetch the live doc again and check it is byte-equal to the saved copy; stop
   if it changed.
2. Run `scripts/backup-tracker.ps1`.
3. `PUT /api/documents/<doc path>` with `If-Match` set to the saved etag, then
   `GET` it back and check it is byte-identical to the draft.
4. `POST /api/writeup` with only the changed fields.
5. `GET /api/config` and diff the whole track against the saved copy: only the
   intended fields changed.
6. `GET /api/prompt/<key>` and grep it for the old wording.

Stay outside the nightly window (00:00 to about 03:15 PT).

## 8. Add the routes the list lacks

Verify each and add it with `add-target-company`. Skip a company no search has
roles at.

## 9. Check the next night's run

Its log and last run note, that no doc edit was refused, and that nothing you
removed - a doc rule, a company name - came back.

## Drafting with subagents

A subagent can't write report files; have it return its report in its final
message.
