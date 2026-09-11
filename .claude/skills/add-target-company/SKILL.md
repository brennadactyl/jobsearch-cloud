---
name: add-target-company
description: Add an employer to a tracked search in D1 - writing it into the company rotation a run actually draws from, checking it is not already there under another name in either the rotation or the config prose, finding whether its job board has a JSON API worth recording, and updating /api/config without flattening the rest of it. Use when asked to add, track, watch or start searching a company, or to put an employer on the list for a job search.
---

# Adding a company to a tracked search

**The run searches the rotation, not `target_companies`.** Every search
rotates: prompt step 1c hands a run its slice of the shared company list
(`company_fetch` - one list for every search and every user, served by
`server/src/routes/coverage.js`), and step 3 searches those companies. A name
added only to config prose is never drawn, swept or searched.

An addition has up to three writes:

1. **The rotation** (`POST /api/coverage`) - always. This is what gets
   searched.
2. **`target_companies`** in `/api/config` - per-track prose carrying the
   track's strategy and fetch guidance, interpolated into step 3. Update it
   when the addition changes either. Edit it as a sentence; never append
   `", Name"`.
3. **The track's baseline doc** in the tracker - why the company is on the
   list.

No deploy is needed for any of this: config, coverage and docs are read per
run.

## 1. Load the config and pick the track(s)

```bash
cd <data dir>/<user-id>
url=$(node -pe "require('./tracker.json').url"); tok=$(node -pe "require('./tracker.json').token")
curl -s "$url/api/config" -H "Authorization: Bearer $tok" > /tmp/config.json
node -e 'require("/tmp/config.json").tracks.forEach(t=>console.log(t.key,"|",t.label,"|",t.schedule_time||"(no schedule)"))'
```

A track with no `schedule_time` has no nightly run - say so rather than adding
silently.

The rotation is shared, so once the company is on it every search's rotation
reaches it. The track choice decides whose prose and doc mention it: match the
company to the track's character, not to the person. A games company belongs
on a gaming-led track.

## 2. Check it is not already there - required

A duplicate pulls the run toward the employer, and a second entry under a
different name gets fetch guidance that can contradict the first.

Check **case-insensitively, in both the rotation and every track's prose, under
every name the company is written as**. The two disagree: a company a run
discovered is on the rotation and never in the prose.

```bash
# the whole shared list - the same for any <key>
curl -s "$url/api/coverage/<key>?all=1" -H "Authorization: Bearer $tok" > /tmp/coverage.json
node -e '
const c = require("/tmp/config.json"), r = require("/tmp/coverage.json");
const needles = process.argv.slice(1).map(s => s.toLowerCase());
let found = false;
for (const t of c.tracks) {
  const hay = (t.target_companies || "").toLowerCase();
  for (const n of needles) if (hay.includes(n)) { console.log("PROSE on " + t.key + ": matched \"" + n + "\""); found = true; }
}
for (const e of r.companies) {
  const hay = e.company.toLowerCase();
  for (const n of needles) if (hay.includes(n)) { console.log("ROTATION: \"" + e.company + "\" matched \"" + n + "\""); found = true; }
}
if (!found) console.log("not present in the rotation or on any track");
' hasbro "wizards of the coast" wotc
```

Pass every alias: parent, division and brand all appear, sometimes in one
entry (`Blizzard/Activision`, `Sony PlayStation/SIE`). Before adding, ask:

- Is it a **subsidiary of something already listed**? Hasbro owns Wizards of
  the Coast; ZeniMax and Activision are inside Microsoft.
- Is it already covered by a **broader group the prose describes**? Those are
  lists inside the prose, not separate fields.
- Is it named differently in the **track doc** than in the config?

If it is already present, stop and say where. Do not add a second mention.

## 3. Find out how the company's jobs are fetched

A company whose board has a JSON API costs one fetch for discovery and
verification together; without one it costs a search plus a fetch per
posting, and its careers page may not render for the runner. Record it the
way existing entries do (the Roblox sentence on `SWE` is one).

Greenhouse boards, given a board URL like
`https://job-boards.greenhouse.io/<token>`:

```bash
curl -s "https://boards-api.greenhouse.io/v1/boards/<token>/jobs" | node -pe '
const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
"jobs: " + j.jobs.length + "\nurl form: " + j.jobs[0].absolute_url'
curl -s "https://boards-api.greenhouse.io/v1/boards/<token>/jobs/<id>" | node -pe '
"full JD: " + (JSON.parse(require("fs").readFileSync(0,"utf8")).content || "").length + " chars"'
```

Ashby is `https://api.ashbyhq.com/posting-api/job-board/<token>?includeCompensation=true`;
Workable is `https://apply.workable.com/api/v3/accounts/<token>/jobs`.

**Verify it returns real postings and a non-empty JD before writing it down** -
the run trusts a recorded endpoint.

Record in the entry: the listing endpoint, the single-job endpoint, that the
JSON carries the description (so one fetch verifies), and **which URL to store
as the lead** - Greenhouse's `absolute_url` is the board URL, not the careers
page, and the tracker dedups by exact string.

## 4. Register it in the rotation

```bash
# "on": "" registers the company without stamping a sweep date; it appends
# after the last position
curl -s -X POST "$url/api/coverage" -H "Authorization: Bearer $tok" \
  -H "Content-Type: application/json" \
  -d '{"search":"<key>","on":"","swept":[{"company":"NFL","board":"greenhouse","note":"..."}]}'
```

Read the response:

- `added: 1` - it joined the list. `added: 0` means the server matched it to a
  company already listed under a normalized spelling; go back to step 2.
- `excluded` above 0 - it is on the person's exclusion list and was not added.
  Stop and report that.
- A 403 means a demo account; demo accounts cannot write the shared list.

A seed (`"on": ""`) adds membership only. `board`, `endpoint` and `url_shape`
reach the shared fetch facts only when a run reports a real sweep, so record
the endpoint from step 3 in the prose or doc.

## 5. Update `target_companies`, if it changes

**Always GET the whole config, change one string inside it, and POST the whole
thing back.** `POST /api/config` with a `tracks` array replaces the track list:
every track missing from the array is deleted along with its run record, and
its leads lose their tab. A field sent as `""` is cleared.

Put the company where it belongs in the sentence - a games company goes in the
gaming clause, not after a paragraph about AI labs.

```bash
node -e '
const fs = require("fs"), c = require("/tmp/config.json");
const t = c.tracks.find(x => x.key === "SWE");
if (!t) throw new Error("no such track");
if (/hasbro/i.test(t.target_companies)) throw new Error("already present - re-run step 2");
t.target_companies = t.target_companies.replace("<anchor text>", "<anchor text>, Hasbro");
fs.writeFileSync("/tmp/config-new.json", JSON.stringify(c));
'
curl -s -X POST "$url/api/config" -H "Authorization: Bearer $tok" \
  -H "Content-Type: application/json" --data-binary @/tmp/config-new.json > /tmp/config-after.json
```

The `last_run` field GET returns is not writable and is ignored on the way in,
so round-tripping it is safe.

## 6. Verify against what came back, not against what you sent

The POST returns the stored config. Diff it:

```bash
node -e '
const a = require("/tmp/config.json"), b = require("/tmp/config-after.json");
console.log("tracks before/after:", a.tracks.length, b.tracks.length);
for (const t of a.tracks) {
  const u = b.tracks.find(x => x.key === t.key);
  if (!u) { console.log("LOST TRACK: " + t.key); continue; }
  for (const k of Object.keys(t))
    if (k !== "last_run" && (t[k] || "") !== (u[k] || "") && k !== "target_companies")
      console.log("CHANGED unexpectedly on " + t.key + ": " + k);
}
'
```

Track count equal, no unexpected field changes, and the new company present
exactly once. Then reload the tracker page and confirm the tabs are all still
there.

## 7. Update the track's baseline doc

The baseline doc lives in the tracker at `docs/tracked_<key>_postings.md` (or
the track's `doc_file`). It holds the reasoning the config has no room for and
the fetch-reliability notes; the run reads it first and edits it. Add the
company there with *why it is on the list*:

```bash
doc="docs/tracked_<key>_postings.md"
curl -s -D /tmp/doc.headers "$url/api/documents/$doc" -H "Authorization: Bearer $tok" > /tmp/doc.md
grep -i '^etag:' /tmp/doc.headers
# edit /tmp/doc.md, then PUT it back with that etag
curl -s -X PUT "$url/api/documents/$doc" -H "Authorization: Bearer $tok" \
  -H "Content-Type: text/markdown" -H "If-Match: <etag>" --data-binary @/tmp/doc.md
```

A 412 means a run wrote the doc since you read it: re-fetch and redo the edit
on top. For a cross-cutting change rather than one company, follow
`change-search-prompt`.
