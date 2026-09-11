/**
 * The company rotation: which companies a search tracks, when each was last
 * attempted, and the slice a given run is told to cover tonight.
 *
 * The rotation's whole job is to stop a run starting at the top of the list
 * every night - a list too long to verify in one go gets covered a batch at a
 * time, least-recently-swept first.
 */

import { normalize } from "../exclude.js";
import { json, readJson } from "../http.js";
import { excluderFor, isoDate, today, unknownTrack } from "../validate.js";

// How many companies one run covers. A whole list is more than a run can
// verify properly, and the failure isn't that a company gets missed - it's
// that all of them get skimmed.
//
// 24 since 0011 made the list global. Twelve kept a list the size each search
// used to hold (35-80) inside a week; the merged list is 139, which at twelve
// is a twelve-day cycle, so the batch doubled to hold it near six. That is
// roughly twice the work a run was doing in a night. Read run lengths and sweep
// counts before moving it again - and read step 9e first, since its
// replacement loop compounds on top of this number on a bad night.
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
 * GET /api/coverage/:key[?on=YYYY-MM-DD] - requires a Bearer token ->
 * `{ companies: [{company, last_swept, board, note}], total, batch }`.
 *
 * Which companies this run covers, chosen by the server. Least-recently-swept
 * first, capped - the run is told what to sweep rather than how to choose,
 * because a cap in prose is a cap a run can talk itself out of on a night when
 * the list looks short. `?all=1` returns the whole table instead, for seeding
 * and for looking at it.
 *
 * Same 404-on-unknown-track reasoning as the dedup route (see ./screened.js):
 * an empty list from a mistyped key would read as "nothing to sweep", and a
 * run would quietly search nothing at all.
 */
export async function handleGetCoverage({ db, params, url }) {
  const key = params[0];
  const all = url.searchParams.get("all") === "1";
  if (!(await db.trackExists(key))) return unknownTrack(key);
  // Filtered on the way out as well as on the way in, because the two catch
  // different things. recordSweeps refuses to *add* an excluded company; this
  // refuses to hand back one that is already in the table - which is the
  // ordinary case, not the exotic one. An exclusion usually gets added because
  // the person saw a posting and decided never again, so the company is
  // already in the rotation by the time it lands on the list. Guarding only
  // the write would leave it being served as a company to cover, every cycle,
  // for as long as the row exists.
  //
  // Filtered rather than deleted: the row is the rotation's memory of when
  // that company was last looked at, the exclusion list is editable, and
  // reading is the wrong moment to destroy data.
  const [log, cursor] = await Promise.all([db.getCoverage(key), db.getSweepCursor(key)]);
  const isExcluded = await excluderFor(db);
  const eligible = log.filter((c) => !isExcluded(c.company));
  if (all) {
    // Intel here too. This branch is what a person reads when they want to see
    // the table, and a view that silently omits the shared facts is one that
    // makes them look absent - which is how someone concludes the pooling
    // isn't working and goes back to writing endpoints into a doc.
    const allIntel = await db.getCompanyFetch(eligible.map((c) => c.company));
    return json({
      companies: eligible.map((c) => {
        const known = allIntel.get(normalize(c.company));
        return known ? { ...c, known } : c;
      }),
      total: eligible.length,
      // Reports the whole table, because that is what this branch returns. Not
      // the per-run cap - that is COVERAGE_BATCH, and reading `batch` from this
      // branch as the nightly slice is a mistake that has already been made.
      batch: eligible.length,
      cursor,
    });
  }

  // Read forward from the cursor, wrapping at the end - the whole selection
  // rule, with no date in it.
  //
  // Dates used to decide this (`ORDER BY last_swept, company`), which made the
  // same column record when a company was attempted and choose who went next.
  // Both rotation bugs came from the second job: a run asking for replacements
  // got back companies it had just covered, and the alphabetical tiebreak put
  // the same 31 companies last every cycle. Reading further along a fixed log
  // is inherently fresh, so neither is expressible any more.
  //
  // Excluded companies are stepped over without consuming a slot. Filtering
  // before the window rather than after is what stops a run being handed nine
  // companies because three in its stretch of the log are excluded.
  //
  // The cursor is compared against `position`, never used as an array index. Those are not
  // the same number the moment any company is excluded: with the company at
  // position 0 excluded, eligible[4] is position 5, so treating the cursor as
  // an index skipped position 4 entirely and silently. Positions are the unit
  // the cursor is stored in, so they have to be the unit it is read in.
  //
  // Wrapping falls out of the concatenation: once the cursor passes the last
  // position, nothing is at or after it and the whole slice comes from the
  // front of the log.
  const companies = sliceAt(eligible, cursor);

  // What is already known about reaching each of these, pooled across the
  // whole deployment (migrations/0010_company_fetch.sql). Attached to the
  // companies a run is already being handed rather than served from a route of
  // its own: a run that has to remember a second call is a run that will skip
  // it on a busy night, and this is exactly the knowledge whose absence made
  // three separate searches independently conclude that a live domain was
  // walled. Per company, so nothing about anyone's rotation travels with it.
  const intel = await db.getCompanyFetch(companies.map((c) => c.company));
  const withIntel = companies.map((c) => {
    const known = intel.get(normalize(c.company));
    return known ? { ...c, known } : c;
  });

  return json({
    companies: withIntel,
    total: eligible.length,
    batch: companies.length,
    // Where this search has read up to, as a position rather than an index.
    // Progress through the rotation is a number now rather than something
    // inferred from dates - "24 of 55" is answerable, and so is "when does a
    // given company come round".
    cursor,
  });
}

/**
 * POST /api/coverage - requires a Bearer token. Body
 * `{ search, on?, swept: [{company, board?, note?}] }`.
 *
 * Records what a run actually attempted. Attempted, not found: a company whose
 * board was blocked today still gets stamped, or the rotation retries it every
 * run forever and the rest of the list starves. Creates rows it hasn't seen,
 * so a company broader discovery turned up joins the rotation by being swept
 * once.
 */
export async function handleRecordSweeps({ request, db }) {
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

  // Same reasoning as /api/runs: the worker only knows UTC, and a 01:00 local
  // run is already the next UTC day - a date derived here would stamp tomorrow.
  // An explicit "" is not a malformed date, it's "register these companies,
  // I haven't swept them" - the seeding case, which must not stamp anything
  // (see db.recordSweeps).
  const on = body.on === "" ? "" : isoDate(body.on) || today();

  // The rotation is the surface where an exclusion would become permanent.
  // This route creates a row for any company it is handed - that is how a
  // company broader discovery turned up joins the rotation - so an excluded
  // company swept once would be stored, then handed back by
  // GET /api/coverage as a company to cover, every cycle, forever. Every other
  // exclusion leak is one row; this one is self-renewing.
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

  // A company not on the list appends after the highest position, so discovery
  // adds to the end rather than jumping the queue or landing behind a cursor
  // where it would wait a full cycle.
  //
  // A position is assigned once, when a company joins, and only to companies
  // that are actually new. Counting the batch instead - or seeding from the
  // list's length rather than its highest position - leaves gaps where a known
  // company was re-swept, and eventually two companies with one position.
  let nextPos = log.length ? Math.max(...log.map((c) => c.position)) + 1 : 0;

  // New companies take their places in a shuffled order, not the order they
  // arrived in - a written list is almost always alphabetical or grouped by
  // theme, and assigning in arrival order would rebuild the bias 0008 removed.
  // One entry per company: a batch naming one company in two spellings adds it
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

  // Every report lands on the company as the list names it, so two spellings of
  // one company are one row in this search's record.
  const positioned = allowed.map((i) => {
    const k = normalize(i.company);
    const listed = onList.get(k) || joining.get(k);
    return { ...i, company: listed.company, position: listed.position };
  });
  const recorded = await db.recordSweeps(key, positioned, on);

  // The same report, pooled: the fields that describe a website. `last_swept`,
  // the cursor and `note` stay in this search's own record.
  //
  // Seeding (`on: ""`) writes no fact here. A seed is a list somebody typed, not
  // something a run confirmed. It still puts companies on the list - that is
  // addCompanies above, and it is membership, not knowledge.
  const shared = on
    ? await db.upsertCompanyFetch(
        allowed.map((i) => ({
          company: i.company,
          board: typeof i.board === "string" ? i.board : "",
          endpoint: typeof i.endpoint === "string" ? i.endpoint : "",
          url_shape: typeof i.url_shape === "string" ? i.url_shape : "",
          dead_signal: typeof i.dead_signal === "string" ? i.dead_signal : "",
          wall: typeof i.wall === "string" ? i.wall : "",
          // `note` stays out. It is the one field a run writes in prose, and
          // prose is where a search's own reasoning leaks ("skipped, nothing
          // at Brenna's level here"). A shared note needs its own field a run
          // fills deliberately, not a repurposed private one.
        })),
        on
      )
    : { written: 0 };

  // Advance the cursor past the last company reported from the slice this
  // search was served, so the next read starts after it - including within the
  // same run, which is what lets a run come back for replacements without a
  // date filter.
  //
  // Committed only now, after the sweep is recorded. A run that dies before
  // reporting leaves the cursor where it was and tomorrow re-reads the same
  // stretch; it never advances past work nobody recorded.
  //
  // Seeding (`on: ""`) registers companies without claiming to have covered
  // them, so it must not move the cursor.
  //
  // Only the served slice counts, rebuilt here by the function GET served it
  // with. A report routinely names companies outside it, and each of those is
  // recorded, but none of them moves the cursor:
  //  - a company discovery turned up that is already on the list. On one shared
  //    list that is the ordinary case - another search's run added it - and it
  //    can sit anywhere along the log. Counting it moved the cursor past it,
  //    and everything between the slice and that company went unswept for the
  //    rest of the cycle.
  //  - a company re-sent after it was already recorded, which sits behind the
  //    cursor. Measured along the rotation that is nearly a whole lap, so it
  //    outranked the replacements reported beside it.
  //  - a company that joined in this call, appended past every cursor.
  // The slice is in rotation order, wrap included, so the last one reported is
  // the furthest along. That also settles the slice that runs off the end of
  // the log and back round to the front: the highest position in it is not the
  // last one served, and advancing past the highest re-served the front of that
  // slice early - 12 companies a cycle at a batch of 24.
  //
  // The rebuild matches what the run was served because reading never moves the
  // cursor, so a run cannot be handed a second slice without reporting the
  // first. The list can still change between the read and the report - another
  // run appending while a slice wraps, an exclusion edited mid-run - and the
  // worst either does is stop the cursor short, so a company is served twice.
  // A company is never skipped: the cursor only passes companies this report
  // named.
  let cursor = await db.getSweepCursor(key);
  if (on !== "") {
    const reported = new Set(allowed.map((i) => normalize(i.company)));
    const served = sliceAt(log.filter((c) => !isExcluded(c.company)), cursor);
    const lastServed = served.findLast((c) => reported.has(normalize(c.company)));
    if (lastServed) cursor = await db.setSweepCursor(key, lastServed.position + 1);
  }

  return json({ recorded, added, excluded, on, cursor, shared: shared.written });
}
