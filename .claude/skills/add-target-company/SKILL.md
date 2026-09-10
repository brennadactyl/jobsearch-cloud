---
name: add-target-company
description: Add an employer to a tracked search's target-company list in D1 - checking it is not already there under another name, finding whether its job board has a JSON API worth recording, and writing it through /api/config without flattening the rest of the config. Use when asked to add, track, watch or start searching a company, or to put an employer on the list for a job search.
---

# Adding a company to a track's target list

The list lives in D1, on one track, as **prose** - `target_companies` in that
track's config, reachable at `/api/config`. Three things follow from that, and
each of them is a way to get this wrong:

- **There is no global company list.** Every track has its own. "Add Hasbro"
  has to become "add Hasbro to *which* track", and the answer is usually more
  than one and never all of them.
- **It is not an array.** It is a paragraph the model reads, and it carries
  more than names: how to fetch a given company, which of its boards is
  unreliable, what to record as the lead URL. Appending `", Hasbro"` to it is
  valid and wastes the surface.
- **Writing is a whole-config replace.** See below - this is the one that
  causes damage rather than mess.

## The failure this exists for

`POST /api/config` with a `tracks` array **replaces every track**, and
`replaceTracks` whitelists fields: anything absent from a track object is
stored as `''`, not left alone. So posting

```json
{ "tracks": [ { "key": "SWE", "target_companies": "...new list..." } ] }
```

deletes the other four tracks outright and, on the one it keeps, blanks
`role_search_line`, `resume_line`, `fit_clause`, `fit_filter_step`,
`doc_summary`, `schedule_time` and everything else - silently, with a 200 and
a config object that looks fine at a glance. The tabs vanish from the page and
the next nightly run composes a prompt with no role line.

**Always GET the whole config, modify one string inside it, and POST the whole
thing back.**

## 1. Decide which track(s)

```bash
cd <data dir>/<user-id>
url=$(node -pe "require('./tracker.json').url"); tok=$(node -pe "require('./tracker.json').token")
curl -s "$url/api/config" -H "Authorization: Bearer $tok" > /tmp/config.json
node -e 'require("/tmp/config.json").tracks.forEach(t=>console.log(t.key,"|",t.label,"|",t.schedule_time||"(no schedule)"))'
```

A track with no `schedule_time` has no nightly run - adding a company there
changes nothing until it is scheduled. Say so rather than adding silently.

Match the company to the track's character, not to the person. A games company
belongs on a gaming-led track; putting it on a big-tech track quietly changes
what that track is for.

## 2. Check it is not already there - this is required, not optional

A duplicate is not harmless. The list is prose the model reads, so the same
employer twice pulls the run toward it, and a second entry under a different
name gets its own fetch guidance that can contradict the first.

Check **case-insensitively, across every track, and for the names the company
is actually written under**:

```bash
node -e '
const c = require("/tmp/config.json");
const needles = process.argv.slice(1).map(s => s.toLowerCase());
let found = false;
for (const t of c.tracks) {
  const hay = (t.target_companies || "").toLowerCase();
  for (const n of needles) if (hay.includes(n)) { console.log("PRESENT on " + t.key + ": matched \"" + n + "\""); found = true; }
}
if (!found) console.log("not present on any track");
' hasbro "wizards of the coast" wotc
```

Pass every alias you can think of, because the list already contains
`Blizzard/Activision`, `Microsoft Xbox/Xbox Game Studios` and
`Sony PlayStation/SIE` - parent, division and brand all appear, sometimes in
one entry. Before adding, ask specifically:

- Is it a **subsidiary of something already listed**? Hasbro owns Wizards of
  the Coast; ZeniMax and Activision are inside Microsoft.
- Is it already covered by a **broader sweep** the list describes - the "AI
  (core)" group, or the non-tech-industry group? Those are lists inside the
  prose, not separate fields.
- Is it named differently in the **track doc** than in the config?

If it is already present, stop and say where. Do not add a second mention.

## 3. Find out how the company's jobs are actually fetched

This is the part worth spending time on, because it is what the entry is
*for*. A company whose board has a JSON API costs one fetch for discovery and
verification together; a company without one costs a search plus a fetch per
posting, and its careers page may not render for the runner at all. The list
already records this distinction - read the Roblox sentence in the `SWE`
track before writing yours.

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

**Verify it returns real postings and a non-empty JD before writing it down.**
An endpoint recorded from memory that 404s at 03:00 is worse than no endpoint,
because the run will trust it.

Record in the entry: the listing endpoint, the single-job endpoint, that the
JSON carries the description (so one fetch verifies), and **which URL to store
as the lead** - Greenhouse's `absolute_url` is the board URL, not the careers
page, and the tracker dedups by exact string.

## 4. Write it

Edit `target_companies` as prose. Put the company where it belongs in the
sentence - a games company goes in the gaming clause, not appended after a
paragraph about AI labs.

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

Post the object you read back, whole. The `last_run` field GET returns is not
writable and is ignored on the way in, so round-tripping it is safe.

## 5. Verify against what came back, not against what you sent

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
there - that is the check that catches a flattened config in the form a person
would notice.

## 6. The track doc is the other half

`<data dir>/<user-id>/docs/tracked_<key>_postings.md` holds the target list
too, with the reasoning the config has no room for and the accumulated
fetch-reliability notes. The nightly run edits it. Adding to D1 and not to the
doc leaves the two disagreeing, and the doc is what the run reads first.

Add the company there with *why it is on the list* - which is the thing that
cannot be reconstructed later. See `change-search-prompt` for the reconciling
rule when a change is cross-cutting rather than one company.

No deploy is needed for any of this: config is read per run.
