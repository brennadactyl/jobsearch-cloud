/**
 * The company rotation: the one company list every search reads from, when
 * each search last attempted each company, and the slice a given run is told
 * to cover tonight.
 *
 * The rotation's whole job is to stop a run starting at the top of the list
 * every night - a list too long to verify in one go gets covered a batch at a
 * time, read forward from this search's cursor.
 */

import { normalize } from "../exclude.js";
import { json, readJson } from "../http.js";
import { excluderFor, isoDate, today, unknownTrack } from "../validate.js";

// How many companies one run covers. A whole list is more than a run can
// verify properly, and the failure isn't that a company gets missed - it's
// that all of them get skimmed. The list's length divided by this is how many
// nights a full cycle takes.
//
// Before changing it, read run lengths and sweep counts, and step 9e of the
// prompt, whose replacement loop adds to this number on a bad night.
//
// A constant, not config: a setting nobody sets is a setting that goes stale.
export const COVERAGE_BATCH = 24;

// The slice a search is served from `cursor`: eligible companies at or after it
// in position order, then round from the front, capped at the batch. Both
// routes go through this one function - GET to serve the slice, POST to bound
// how far a report can move the cursor - so the two cannot come to disagree
// about what a run was given.
function sliceAt(eligible, cursor) {
  return eligible
    .filter((c) => c.position >= cursor)
    .concat(eligible.filter((c) => c.position < cursor))
    .slice(0, COVERAGE_BATCH);
}

/**
 * GET /api/coverage/:key[?all=1] - requires a Bearer token ->
 * `{ companies: [{company, position, last_swept, board, note, known?}], total,
 * batch, cursor }`; 404 for an unknown track.
 *
 * The server picks tonight's slice - the next COVERAGE_BATCH along the shared
 * list from this search's cursor - because a cap stated in prose is one a run
 * can talk itself out of when the list looks short. `?all=1` returns the whole
 * list instead.
 *
 * 404 rather than an empty list for an unknown key: empty would read as
 * "nothing to sweep", and the run would search nothing.
 */
export async function handleGetCoverage({ db, params, url }) {
  const key = params[0];
  const all = url.searchParams.get("all") === "1";
  if (!(await db.trackExists(key))) return unknownTrack(key);
  // Excluded companies are filtered on read as well as on write: recordSweeps
  // refuses to add one, but a company is usually already in the rotation by the
  // time someone excludes it. Filtered rather than deleted, because the row
  // records when the company was last looked at and the exclusion list is
  // editable.
  const [log, cursor] = await Promise.all([db.getCoverage(key), db.getSweepCursor(key)]);
  const isExcluded = await excluderFor(db);
  const eligible = log.filter((c) => !isExcluded(c.company));
  if (all) {
    // `known` here too, so a person reading the whole table sees the shared
    // facts rather than concluding there are none.
    const allIntel = await db.getCompanyFetch(eligible.map((c) => c.company));
    return json({
      companies: eligible.map((c) => {
        const known = allIntel.get(normalize(c.company));
        return known ? { ...c, known } : c;
      }),
      total: eligible.length,
      // The whole table's size, not the nightly slice (that is COVERAGE_BATCH).
      batch: eligible.length,
      cursor,
    });
  }

  // Read forward from the cursor, wrapping at the end. Only position decides
  // the slice; `last_swept` records when a company was attempted and takes no
  // part in choosing. Excluded companies are filtered out before slicing, so
  // they don't use up slots.
  //
  // The cursor is compared against `position`, never used as an array index:
  // once any company is excluded, eligible[i] is no longer position i, and
  // indexing would skip a company silently.
  const companies = sliceAt(eligible, cursor);

  // What is known about reaching each company, pooled across the deployment
  // (migrations/0010_company_fetch.sql). Attached here rather than served by a
  // route of its own, because a run skips a second call on a busy night. Keyed
  // by company, so nothing about anyone's rotation travels with it.
  const intel = await db.getCompanyFetch(companies.map((c) => c.company));
  const withIntel = companies.map((c) => {
    const known = intel.get(normalize(c.company));
    return known ? { ...c, known } : c;
  });

  return json({
    companies: withIntel,
    total: eligible.length,
    batch: companies.length,
    cursor,
  });
}

/**
 * POST /api/coverage - requires a Bearer token. Body
 * `{ search, on?, swept: [{company, board?, endpoint?, url_shape?,
 * dead_signal?, wall?, note?}] }` -> `{ recorded, added, excluded, on, cursor,
 * shared, withheld }`, or `{ recorded: 0, excluded, on }` when every company is
 * excluded; 400 for a missing search or no companies, 403 for a demo account,
 * 404 for an unknown track.
 *
 * Records what a run attempted, not what it found: a company whose board was
 * blocked still gets stamped, or the rotation retries it every run and the rest
 * of the list starves. A company not yet on the shared list joins it, so it is
 * in every search's rotation from then on.
 */
export async function handleRecordSweeps({ request, db, user }) {
  // A demo account's companies are invented, and this route writes the list
  // every account's searches are served from (membership via addCompanies,
  // facts via upsertCompanyFetch; migrations/0012_demo_account.sql). Refused
  // whole rather than filtered, so the caller hears that nothing was written.
  // Reading the list is unaffected.
  if (user.demo) {
    return json(
      { error: "a demo account cannot write to the company list - every account shares it, and a demo's companies are invented" },
      403
    );
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const key = typeof body.search === "string" ? body.search : "";
  if (!key) return json({ error: "missing search (track key)" }, 400);
  if (!(await db.trackExists(key))) return unknownTrack(key);

  const incoming = Array.isArray(body.swept) ? body.swept : [];
  const valid = incoming
    .filter((i) => i && typeof i.company === "string" && i.company.trim())
    .map((i) => ({ ...i, company: i.company.trim() }));
  if (valid.length === 0) return json({ error: "no companies provided" }, 400);

  // The run's own date: the worker only knows UTC, and a 01:00 local run is
  // already the next UTC day. An explicit "" means "register these companies,
  // I haven't swept them" - seeding, which stamps nothing (see
  // db.recordSweeps).
  const on = body.on === "" ? "" : isoDate(body.on) || today();

  // This route adds any company it's handed to the rotation, so an excluded
  // company reported once would otherwise be served every cycle.
  const isExcluded = await excluderFor(db);
  const allowed = valid.filter((i) => !isExcluded(i.company));
  const excluded = valid.length - allowed.length;
  if (allowed.length === 0) return json({ recorded: 0, excluded, on });

  // The list is shared (0011_one_company_list.sql): `log` is every company on
  // it, with this search's own record of each. Matched through normalize(), so
  // a run that writes "Cursor Anysphere" finds the company listed as
  // "Cursor (Anysphere)" instead of adding it a second time.
  const log = await db.getCoverage(key);
  const onList = new Map(log.map((c) => [normalize(c.company), c]));

  // A new company appends past the highest position, so it neither jumps the
  // queue nor lands behind a cursor and waits a full cycle. Positions go only
  // to companies that are actually new: counting the batch, or starting from
  // the list's length, leaves gaps and eventually two companies with one
  // position.
  let nextPos = log.length ? Math.max(...log.map((c) => c.position)) + 1 : 0;

  // New companies are positioned in shuffled order: a written list is usually
  // alphabetical or grouped by theme, and arrival order would carry that bias
  // into the rotation. A batch naming one company in two spellings adds it
  // once, under the first.
  const fresh = [];
  const seenFresh = new Set();
  for (const i of allowed) {
    const k = normalize(i.company);
    if (onList.has(k) || seenFresh.has(k)) continue;
    seenFresh.add(k);
    fresh.push(i);
  }
  for (let i = fresh.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
  }
  const joining = new Map(
    fresh.map((i) => [normalize(i.company), { company: i.company, position: nextPos++ }])
  );
  const added = await db.addCompanies([...joining.values()]);

  // A row reporting a `wall` beside a `board` or `endpoint` contradicts itself:
  // a wall means no route to the listings worked, a board or endpoint is one
  // that did. Trusting the board lets a failed fetch erase a true wall for
  // every search (upsertCompanyFetch clears a wall when a route is reported);
  // trusting the wall makes a reachable company one every search skips until
  // the wall expires. So the row shares nothing - no wall, board, endpoint or
  // url_shape, and no board on this search's record either. The sweep is still
  // recorded, and `withheld` counts these rows.
  //
  // `url_shape` is not a route: it builds one posting's URL, and a posting can
  // load while its listing is walled, so that row shares as normal.
  //
  // Enforced here, not only in scripts/tracker.ps1, so every caller meets it.
  const contradicts = (i) =>
    typeof i.wall === "string" && i.wall !== "" &&
    ((typeof i.board === "string" && i.board !== "") || (typeof i.endpoint === "string" && i.endpoint !== ""));

  // Every report lands on the company as the list names it, so two spellings of
  // one company are one row in this search's record.
  const positioned = allowed.map((i) => {
    const k = normalize(i.company);
    const listed = onList.get(k) || joining.get(k);
    const row = { ...i, company: listed.company, position: listed.position };
    return contradicts(i) ? { ...row, board: "" } : row;
  });
  const recorded = await db.recordSweeps(key, positioned, on);

  // The same report, pooled: the fields that describe a website. `last_swept`,
  // the cursor and `note` stay in this search's own record.
  //
  // Seeding (`on: ""`) writes no shared fact: a typed list isn't something a
  // run confirmed. It still adds companies to the list, via addCompanies above.
  const withheld = on ? allowed.filter(contradicts).length : 0;
  const shared = on
    ? await db.upsertCompanyFetch(
        allowed.filter((i) => !contradicts(i)).map((i) => ({
          company: i.company,
          board: typeof i.board === "string" ? i.board : "",
          endpoint: typeof i.endpoint === "string" ? i.endpoint : "",
          url_shape: typeof i.url_shape === "string" ? i.url_shape : "",
          dead_signal: typeof i.dead_signal === "string" ? i.dead_signal : "",
          wall: typeof i.wall === "string" ? i.wall : "",
          // `note` stays out: it is prose, and prose carries a search's own
          // reasoning ("skipped, nothing at my level here"). A shared note
          // needs its own field, not this private one.
        })),
        on
      )
    : { written: 0 };

  // Advance the cursor past the last company reported from the slice this
  // search was served, so the next read - including a replacements read in the
  // same run - starts after it.
  //
  // Committed only after the sweep is recorded, so a run that dies before
  // reporting leaves the cursor where it was. Seeding (`on: ""`) claims no
  // coverage, so it doesn't move the cursor.
  //
  // The served slice is rebuilt with sliceAt, as GET built it. Companies outside
  // it are recorded but don't move the cursor: one already on the list can sit
  // anywhere along it, a re-sent one sits behind the cursor, and a newly joined
  // one is past every cursor, so advancing to any of them would move the cursor
  // further than the run read. The slice is in rotation order, wrap included,
  // so the last one reported is the furthest along - not the highest position,
  // which is wrong for a slice that wraps.
  //
  // Reading never moves the cursor, so the rebuild matches what the run was
  // served. If the list changes between read and report, the worst case is the
  // cursor stopping short and a company being served twice; the cursor only
  // passes companies this report named.
  let cursor = await db.getSweepCursor(key);
  if (on !== "") {
    const reported = new Set(allowed.map((i) => normalize(i.company)));
    const served = sliceAt(log.filter((c) => !isExcluded(c.company)), cursor);
    const lastServed = served.findLast((c) => reported.has(normalize(c.company)));
    if (lastServed) cursor = await db.setSweepCursor(key, lastServed.position + 1);
  }

  return json({ recorded, added, excluded, on, cursor, shared: shared.written, withheld });
}
