/**
 * The two reports a nightly run makes about the postings it already tracks:
 * which are still live (/api/verified) and which have come down (/api/delist),
 * plus the delisting rule itself, which /api/update's `delistedOn` also uses.
 * The run reports what it saw; the server decides what that means.
 *
 * URLs are matched by posting identity (canonicalUrl, ../url.js), never by raw
 * string: a run reaches a posting by whatever link its search gave it, and a
 * `?gh_jid=`, a slug or a tracking param would make a raw match miss and leave
 * a dead posting on the board.
 *
 * Several leads can share one canonical key. They are the same posting, so
 * every match is returned. The reported list is deduped by key, so two
 * spellings of one posting in a payload count once in `removed` and `stamped`.
 */

import { DELISTED_REASON } from "../db.js";
import { json, readJson } from "../http.js";
import { canonicalUrl } from "../url.js";
import { isoDate, today, unknownTrack } from "../validate.js";

// Two people can track the same posting (UNIQUE is on user_id, search, url), so
// a URL, unlike a row id, says nothing about whose lead it is. The candidate set
// is db.getLeadsForUrlMatch's, scoped to the caller like every Db read, so a URL
// can only resolve to the caller's own rows.
//
// An unmatched URL is reported, raw, rather than ignored: the run believes it
// tracks something the tracker has no row for, and a count alone can't be
// acted on.
/**
 * @param {Array<{id: number, url: string}>} leads every lead this user tracks
 * @param {string[]} urls the URLs the run reported
 * @returns {{matched: Array<Object>, unmatched: string[]}}
 */
function matchLeadsByUrl(leads, urls) {
  const byKey = new Map();
  for (const lead of leads) {
    const key = canonicalUrl(lead.url);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(lead);
    else byKey.set(key, [lead]);
  }

  const matched = [];
  const unmatched = [];
  const seen = new Set();
  for (const raw of urls) {
    const key = canonicalUrl(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const hit = byKey.get(key);
    if (hit) matched.push(...hit);
    else unmatched.push(raw);
  }
  return { matched, unmatched };
}

// Parses the { search, urls } both URL-set routes take: `{ error }` holding a
// Response to hand straight back, or `{ body, key, urls }`.
//
// Neither route uses the key beyond this check (the match spans every tab - see
// db.getLeadsForUrlMatch), but an unknown key means the run and the tracker
// disagree about the search, which is worth failing loudly over.
async function parseUrlReport(request, db) {
  const body = await readJson(request);
  if (body instanceof Response) return { error: body };

  const key = typeof body.search === "string" ? body.search : "";
  if (!key) return { error: json({ error: "missing search (track key)" }, 400) };
  if (!(await db.trackExists(key))) return { error: unknownTrack(key) };

  const urls = (Array.isArray(body.urls) ? body.urls : [])
    .filter((u) => typeof u === "string" && u.trim())
    .map((u) => u.trim());
  if (urls.length === 0) return { error: json({ error: "no urls provided" }, 400) };
  return { body, key, urls };
}

/**
 * POST /api/verified - requires a Bearer token. Body `{ search, on?,
 * urls: [...] }` -> `{ stamped, unmatched, unmatchedUrls, on }`; 400 for a
 * missing search or urls, 404 for an unknown search.
 *
 * Stamps `verified` on the leads a run re-checked and found still live. A lead
 * still in a tab is presumed live, and this date is the only measure of how
 * stale that presumption is.
 *
 * An `on` that isn't YYYY-MM-DD falls back to the worker's UTC date rather than
 * refusing the report, unlike /api/delist: a wrong date here only moves a
 * re-check, while there it permanently deletes a posting.
 */
export async function handleMarkVerified({ request, db }) {
  const parsed = await parseUrlReport(request, db);
  if (parsed.error) return parsed.error;

  const on = isoDate(parsed.body.on) || today();

  const { matched, unmatched } = matchLeadsByUrl(await db.getLeadsForUrlMatch(), parsed.urls);
  const stamped = await db.markVerified(matched.map((l) => l.id), on);
  // The page shows this date on every lead, so a stamp is a visible change and
  // bumps "last updated".
  if (stamped > 0) await db.touchUpdated();

  return json({ stamped, unmatched: unmatched.length, unmatchedUrls: unmatched, on });
}

/**
 * What the tracker does when a run reports that a posting it tracks has been
 * taken down:
 *
 *   - a lead with status "Applied", or with an application row pointing at it,
 *     is kept, untouched;
 *   - any other lead is deleted and its URL recorded as screened, in one
 *     transaction (db.deleteLeadAndScreen).
 *
 * A dead posting can't be applied to, so its lead goes; the screened row stops
 * tomorrow's run rediscovering the URL and adding it straight back. An
 * applied-to lead stays because what's tracked from then on is the
 * application. The application row counts as well as the status because a
 * lead can carry one in any status, and deleting it would strand that row.
 *
 * The rule lives in code, not in the run's prompt, so it can be tested and
 * applies to every search once deployed. Both entry points (removeDelistedLead
 * by id, handleDelistUrls by URL) call this and only fetch leads and shape
 * JSON; keep the rule here rather than copying it into either.
 *
 * @param {import("../db.js").Db} db
 * @param {Object} lead - the already-fetched lead row, so this doesn't re-read it
 * @param {string} on - the date the run confirmed it dead (its own local date, already validated as YYYY-MM-DD by the caller)
 * @returns {Promise<{kept: boolean, removed: boolean}>} `kept` is the applied-to
 *   exception; `removed` is what the DELETE actually matched
 */
async function delistLead(db, lead, on) {
  if (lead.status === "Applied" || (await db.getApplicationByLeadId(lead.id))) {
    return { kept: true, removed: false };
  }

  // `on` is the run's local date (see /api/runs), and once the lead is gone the
  // screened row is the only record of when the posting died.
  //
  // `removed` is what the DELETE actually matched: two concurrent reports of
  // one lead both pass the check above, and the second deletes nothing.
  const removed = await db.deleteLeadAndScreen(lead, DELISTED_REASON, on, "run");
  return { kept: false, removed };
}

/**
 * The by-id entry point: POST /api/update's `delistedOn`, called from
 * ./update.js -> `{ ok, removed, id, screened }`, or `{ ok, lead, removed:
 * false, reason }` when kept; 404 for an unknown lead.
 */
export async function removeDelistedLead(db, id, on) {
  const lead = await db.getLead(id);
  if (!lead) return json({ error: "lead not found" }, 404);

  const { kept, removed } = await delistLead(db, lead, on);
  if (kept) return json({ ok: true, lead, removed: false, reason: "applied to - kept" });

  await db.touchUpdated();
  return json({ ok: true, removed, id: lead.id, screened: lead.url });
}

/**
 * POST /api/delist - requires a Bearer token. Body `{ search, on, urls: [...] }`
 * -> `{ removed, kept, unmatched, unmatchedUrls, on }`; 400 for a missing
 * search or urls or an `on` that isn't YYYY-MM-DD, 404 for an unknown search.
 *
 * The by-URL entry point: every posting a run confirmed dead tonight in one
 * call, so the server does the lookup and the tally, which a model only
 * approximates.
 *
 * `on` is required because this deletes permanently and the caller is an LLM.
 * A date that isn't a date means the run doesn't know what day it is, so the
 * whole batch is refused rather than applied in part.
 *
 * Leads are delisted one at a time, not in parallel: each is already a
 * transaction, and nobody is waiting on this scheduled call.
 */
export async function handleDelistUrls({ request, db }) {
  const parsed = await parseUrlReport(request, db);
  if (parsed.error) return parsed.error;

  const on = isoDate(typeof parsed.body.on === "string" ? parsed.body.on.trim() : "");
  if (!on) return json({ error: "on must be YYYY-MM-DD" }, 400);

  const { matched, unmatched } = matchLeadsByUrl(await db.getLeadsForUrlMatch(), parsed.urls);

  let removed = 0;
  let kept = 0;
  for (const lead of matched) {
    const verdict = await delistLead(db, lead, on);
    if (verdict.kept) kept++;
    else if (verdict.removed) removed++;
    // Neither when the DELETE matched nothing (the concurrent-report race in
    // delistLead): the lead is gone, but this call didn't remove it.
  }
  if (removed > 0) await db.touchUpdated();

  return json({ removed, kept, unmatched: unmatched.length, unmatchedUrls: unmatched, on });
}
