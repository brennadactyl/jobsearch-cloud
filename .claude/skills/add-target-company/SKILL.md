---
name: add-target-company
description: Put an employer on the shared company list every nightly search draws from, or record how its jobs are fetched - checking it is not already on the list under another name, verifying its job board or listing endpoint, and writing the fetch facts to the shared list through /api/coverage without moving any search's place in the rotation. Use when asked to add, track, watch or start searching a company, to put an employer on the list, or to record a company's board, endpoint or URL shape.
---

# Adding a company to the shared list

**There is one company list, and every search on the deployment reads it** -
every track, every account. Step 1c of each nightly run hands that search its
next slice of the list, and step 3 searches those companies. A company added
here reaches Brenna's, Brady's and Jeff's searches alike; there is no choosing a
track, and no way to add a company to one search only. Each search's own fit
rules (role, level, location) decide what it keeps from a company.

Two kinds of thing get written:

| What | Where it lands | Visible to |
|---|---|---|
| Membership - the company is on the list | `company_fetch` row, appended after the last position | every search |
| Fetch facts - `board`, `endpoint`, `url_shape` | the same `company_fetch` row | every search, in `companies.json` |

**Company facts do not go in `target_companies` or a track doc.** Not the board,
not the endpoint, not "the JD is in the JSON". A fact written into one search's
prose or doc reaches that search only, and disagrees with the list the day
either changes. The per-search `note` a sweep carries is private to that search
too, and is never shared.

## Before you start: the credential and the date

Use a real account's `tracker.json`. A demo account gets `403` on every write to
the list.

```bash
cd <data dir>/<user-id>
url=$(node -pe "require('./tracker.json').url"); tok=$(node -pe "require('./tracker.json').token")
today=$(date +%F)   # local date; in PowerShell: Get-Date -Format yyyy-MM-dd
curl -s "$url/api/config" -H "Authorization: Bearer $tok" > /tmp/config.json
node -e 'require("/tmp/config.json").tracks.filter(t=>!t.fed_by).forEach(t=>console.log(t.key))'
```

`POST /api/coverage` requires a `search` - one of this account's track keys.
It does not choose who gets the company; step 4 says how to pick one safely.

## 1. Check it is not already on the list - required

```bash
curl -s "$url/api/coverage/<any key>?all=1" -H "Authorization: Bearer $tok" > /tmp/list.json
node -e '
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const l = require("/tmp/list.json");
const needles = process.argv.slice(1).map(norm);
console.log("list total:", l.total);
for (const c of l.companies) {
  const k = norm(c.company);
  if (needles.some(n => k.includes(n) || n.includes(k)))
    console.log("possible match at position " + c.position + ": " + c.company + " | shared facts: " + JSON.stringify(c.known || "none"));
}
' "fetch" "fetch rewards"
```

It matches on substrings, so it over-reports - `nfl` also turns up `Confluent`.
Read the names; don't count the lines.

`?all=1` returns the same list for every key. Pass every name the company goes
by. The server matches through `normalize()` (lowercase, punctuation collapsed),
so `Cursor Anysphere` and `Cursor (Anysphere)` are one company - but a parent
and its brand are not: check the parent (Hasbro for Wizards of the Coast,
Microsoft for Activision) and decide whether the brand needs its own row.

The list hides companies this account has excluded. Check
`settings.excluded_companies` in `/tmp/config.json` too: an excluded company is
refused and counted in `excluded`, and it stays hidden from this account's
searches whatever is written.

A company already on the list with `known` facts needs nothing unless those
facts are wrong. One on the list with no `known` facts is the case step 3 is
for.

## 2. Find out how its jobs are actually fetched

This is what makes a company cheap for every search. A JSON board costs one
fetch to list and verify; a company without one costs a web search plus a fetch
per posting, and may not render for the runner at all.

Greenhouse, given `https://job-boards.greenhouse.io/<token>`:

```bash
curl -s "https://boards-api.greenhouse.io/v1/boards/<token>/jobs" | node -pe '
const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
"jobs: " + j.jobs.length + "\nurl form: " + j.jobs[0].absolute_url'
curl -s "https://boards-api.greenhouse.io/v1/boards/<token>/jobs/<id>" | node -pe '
"full JD: " + (JSON.parse(require("fs").readFileSync(0,"utf8")).content || "").length + " chars"'
```

Ashby is `https://api.ashbyhq.com/posting-api/job-board/<token>?includeCompensation=true`;
Workable is `https://apply.workable.com/api/v3/accounts/<token>/jobs`; Workday
is `https://<tenant>.wd<N>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs`
(POST).

**Verify it returns real postings and a non-empty description before writing it
down.** An endpoint that 404s at 03:00 is worse than none, because every search
trusts it.

Map what you verified onto the three shared fields, in the form the list
already uses:

| Field | Holds | Example already on the list |
|---|---|---|
| `board` | the kind of board | `greenhouse`, `ashby`, `workday cxs` |
| `endpoint` | the listing route, no scheme | `boards-api.greenhouse.io/v1/boards/scopely/jobs` |
| `url_shape` | how one posting's page URL is built | `quickenloans.wd5.myworkdayjobs.com/en-US/rocket_careers/job/<externalPath>` |

A company with no board still gets an `endpoint` when a plain page lists its
jobs: `fetch.com/careers/jobs`.

**Never write a `wall`.** A wall is a run's report that no route worked on a
given night; the server serves one only after two separate dates within seven
days. A row carrying a `wall` beside a `board` or `endpoint` contradicts itself
and shares nothing at all (`withheld: 1`). If no route works for you, add the
company with no facts (step 4) and let the runs establish it.

## 3. Pick the search key to write under

A dated report has two side effects on the search you write it under:

- It stamps that search's `last_swept` for the company, so its record says it
  swept the company today when no run did. Selection never reads dates, so the
  cost is a misleading record, nothing more. Say which key you used when you
  report back.
- It **moves that search's cursor if the company is inside the slice it is
  currently being served**. The cursor jumps past every company before it in
  that slice, and those are skipped for the rest of the cycle - not recorded as
  covered, just never served.

Pick a key whose current slice does not contain the company:

```bash
for k in $(node -e 'require("/tmp/config.json").tracks.filter(t=>!t.fed_by).forEach(t=>console.log(t.key))'); do
  curl -s "$url/api/coverage/$k" -H "Authorization: Bearer $tok" | node -e '
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const s = JSON.parse(require("fs").readFileSync(0,"utf8"));
    const hit = (s.companies||[]).some(c => norm(c.company) === norm(process.argv[2]));
    console.log(process.argv[1], "cursor", s.cursor, hit ? "IN CURRENT SLICE - do not use" : "safe");
  ' "$k" "<company>"
done
```

If every key says "do not use", wait for tonight's runs to move past it.

## 4. Write it

With verified facts - adds the company if it is new, and shares the facts:

```bash
curl -s -X POST "$url/api/coverage" -H "Authorization: Bearer $tok" \
  -H "Content-Type: application/json" \
  -d "{\"search\":\"<safe key>\",\"on\":\"$today\",\"swept\":[{\"company\":\"Fetch\",\"endpoint\":\"fetch.com/careers/jobs\"}]}"
```

With no verified facts - membership only, no date stamped, no cursor touched:

```bash
curl -s -X POST "$url/api/coverage" -H "Authorization: Bearer $tok" \
  -H "Content-Type: application/json" \
  -d '{"search":"<key>","on":"","swept":[{"company":"<company>"}]}'
```

`on: ""` writes **no** facts: a `board` or `endpoint` sent with it is dropped
from the shared row. Facts need a date.

Read the response: `{recorded, added, excluded, on, cursor, shared, withheld}`.

| Field | Want |
|---|---|
| `added` | `1` for a new company, `0` for one already on the list |
| `shared` | `1` when facts were sent with a date |
| `withheld` | `0` - anything else means a `wall` went in beside a route |
| `excluded` | `0` - anything else means this account excludes it |
| `cursor` | the same number step 3 printed for that key |

## 5. Verify against the list, not the response

Re-run step 1's check. The company appears exactly once, `known` shows the
fields you sent, and the total rose by `added`.

## When `target_companies` does change

`target_companies` is a search's strategy prose - which kinds of employer to
favour, and why. Edit it only when an addition changes that strategy, never to
record the company itself.

`POST /api/config` with a `tracks` array **replaces every track**, and any
field missing from a track object is stored as `''`. Posting one track with
only `target_companies` deletes the other tracks and blanks the kept one's role
line, resume line and schedule, with a `200`. **GET the whole config, change
one string, POST the whole object back**, then diff what came back:

```bash
node -e '
const a = require("/tmp/config.json"), b = require("/tmp/config-after.json");
console.log("tracks before/after:", a.tracks.length, b.tracks.length);
for (const t of a.tracks) {
  const u = b.tracks.find(x => x.key === t.key);
  if (!u) { console.log("LOST TRACK: " + t.key); continue; }
  for (const k of Object.keys(t))
    if (k !== "last_run" && k !== "target_companies" && (t[k] || "") !== (u[k] || ""))
      console.log("CHANGED unexpectedly on " + t.key + ": " + k);
}'
```

No deploy is needed for any of this: the list and the config are read per run.
