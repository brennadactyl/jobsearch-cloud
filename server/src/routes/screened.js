/**
 * Screened postings: the ones a search looked at and decided NOT to file as a
 * lead, plus the read a run makes before searching to know what it has already
 * found or already ruled out.
 *
 * The two halves are the same table from opposite ends - one writes the memo,
 * the other is tomorrow's run reading it back.
 */

import { DELISTED_REASON } from "../db.js";
import { excludedCompanyMatcher, normalize } from "../exclude.js";
import { json, readJson } from "../http.js";
import { isoDate, unknownTrack, unknownTrackResponse } from "../validate.js";
import { COVERAGE_BATCH, upcomingCompanies } from "./coverage.js";

// How far back a scoped dedup read keeps a screened URL at a company outside the
// window. The window covers what the run will be served; this covers what it is
// likeliest to meet anyway - a candidate its web search or step 3b turned up on
// one of the last few nights. Short on purpose: most screened rows are recent,
// so a window of a couple of weeks keeps nearly every list whole and the scope
// stops trimming anything. A URL this drops is at worst verified again, because
// POST /api/screened and /api/leads refuse duplicates on the way in.
export const DEDUP_RECENT_DAYS = 3;

/**
 * GET /api/dedup/:key[?scope=batch] - requires a Bearer token ->
 * `{ leads: [{id, url, status}], screened: [url] }`, plus `scope` when scoped;
 * 404 for an unknown track.
 *
 * What a scheduled run fetches before searching. Narrow on purpose - see
 * db.getDedupData. 404 rather than empty arrays, because empty is what a
 * mistyped key would produce, and a run that believes it has seen nothing
 * re-adds every posting it already screened.
 *
 * `?scope=batch` trims `screened` to what the run can meet tonight: URLs at a
 * company in the next 2 x COVERAGE_BATCH companies along the rotation, plus any
 * URL screened in the last DEDUP_RECENT_DAYS. Two batches, because step 9e reads
 * a second slice once 9d has moved the cursor, and a replacement company that
 * arrived with no history would be verified again. A fed tab takes the window
 * from the track whose search fills it, since that is the cursor its run reads;
 * its rows are still its own, because a delisted lead leaves its screened row
 * under the lead's tab. `leads` is never trimmed: step 8 re-checks every one.
 *
 * The cutoff is the server's date, compared with dates runs stamp in their own
 * local time, so it can keep a day more than it says - the safe direction.
 *
 * `scope` is `{cursor, companies, since, kept, of}`, so a run's log can say what
 * it was given. Without the parameter the response is exactly the unscoped one.
 */
export async function handleGetDedup({ db, params, url }) {
  const key = params[0];
  const track = await db.getTrack(key);
  if (!track) return unknownTrack(key);
  if (url.searchParams.get("scope") !== "batch") return json(await db.getDedupData(key));

  const upcoming = await upcomingCompanies(db, track.fed_by || key, 2 * COVERAGE_BATCH);
  const inWindow = new Set(upcoming.companies.map((c) => normalize(c.company)));
  const since = new Date(Date.now() - DEDUP_RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const { leads, screened: rows } = await db.getDedupRows(key);
  const kept = rows.filter((r) => inWindow.has(normalize(r.company)) || r.date >= since);
  return json({
    leads,
    screened: kept.map((r) => r.url),
    scope: { cursor: upcoming.cursor, companies: upcoming.companies.length, since, kept: kept.length, of: rows.length },
  });
}

/**
 * POST /api/screened - requires a Bearer token. Body `{ on?, screened: [...] }`
 * -> `{ added, duplicates, excluded }`; 400 for no valid items, 404 naming any
 * unknown track (nothing inserted).
 *
 * Records postings the search looked at and decided NOT to add as a lead (see
 * migrations/0001_schema.sql). Deduped like handleAddLeads, but no
 * touchUpdated(): the page doesn't show screened rows, so they shouldn't bump
 * its "last updated" banner.
 *
 * `on` matters: it is the date these rows carry, and /api/runs counts a day's
 * screened rows by it.
 */
export async function handleAddScreened({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const incoming = Array.isArray(body.screened) ? body.screened : [];
  if (incoming.length === 0) return json({ error: "no screened items provided" }, 400);

  const valid = incoming.filter((item) => item.search && item.url);
  if (valid.length === 0) return json({ error: "no valid screened items in payload" }, 400);

  const on = isoDate(body.on);

  // A screened row belongs to the search that did the screening, not to the
  // tab the posting would have been filed under. For a branched search
  // (`fed_by`, migrations/0003_branched_tracks.sql) nothing displays screened
  // rows per tab and step 1b reads them back as one set, so they are filed
  // under the feeding track below, whatever key the run sent.
  const { tracks, settings } = await db.getTracksAndSettings();

  // Validated against what the caller sent, before the `fed_by` rewrite far
  // below. The rewrite maps a fed key to the track that owns its search, so
  // checking afterwards would report the root's name for a mistake made in
  // the fed tab's name - and the string that drifts is the one in the prompt,
  // which is the one the caller sent. Same all-or-nothing refusal as
  // /api/leads; see unknownTrackResponse for why nothing is inserted.
  const drift = unknownTrackResponse(tracks, valid);
  if (drift) return drift;

  // An excluded company is dropped outright rather than becoming a screened
  // row like other rejected candidates: a screened row says "considered and
  // ruled out", an excluded company is never considered, and the row would only
  // grow a table a run reads back every night. Enforced here because the
  // prompt's instruction alone doesn't hold.
  const isExcluded = excludedCompanyMatcher(settings.excluded_companies);
  const allowed = valid.filter((item) => !isExcluded(item.company));
  const excluded = valid.length - allowed.length;
  if (allowed.length === 0) return json({ added: 0, duplicates: 0, excluded });

  // DELISTED_REASON is reserved for delistings, and a run could reasonably
  // describe a dead-on-arrival candidate in those words - see server/README.md,
  // "One shared trap".
  for (const item of allowed) {
    if (typeof item.reason === "string" && item.reason.trim().toLowerCase() === DELISTED_REASON) {
      item.reason = "dead on arrival";
    }
  }

  // One hop, not a walk to a root: a fed track is a tab, and the track that
  // fills it runs its own search, so `fed_by` chains have no meaning in the
  // model (see migrations/0003_branched_tracks.sql) and none exist. Resolving
  // repeatedly would only be guessing at what a chain ought to mean.
  const fedBy = new Map(tracks.map((t) => [t.key, t.fed_by || ""]));
  const filed = allowed.map((item) => ({ ...item, search: fedBy.get(item.search) || item.search }));

  const { added, duplicates } = await db.addScreened(filed, on);
  return json({ added, duplicates, excluded });
}

/**
 * POST /api/unscreen - requires a Bearer token. Body
 * `{ search, urls: [...] }` -> `{ removed, urls, unmatched }`; 400 for a
 * missing search or urls, 404 for an unknown track.
 *
 * Undoes a screening - the only way to make a posting findable again, since
 * dropKnownUrls treats a screened row (including the one a delisting leaves)
 * as a posting already met.
 *
 * No prompt mentions it. Rediscovery is the next run's job once the row is
 * gone, and a run able to clear its own screened rows could undo yesterday's
 * correct rejections and re-add them every night.
 */
export async function handleUnscreen({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const key = typeof body.search === "string" ? body.search.trim() : "";
  if (!key) return json({ error: "missing search (track key)" }, 400);
  if (!(await db.trackExists(key))) return unknownTrack(key);

  const urls = Array.isArray(body.urls) ? body.urls.filter((u) => typeof u === "string" && u) : [];
  if (urls.length === 0) return json({ error: "missing urls" }, 400);

  // The whole feed group, not just the key given or its feeder: a run's
  // rejections sit under the feeder (handleAddScreened rewrites them), a
  // delisted lead's under the tab it was filed in (delistLead doesn't), so
  // either key alone misses half. See db.unscreenUrls.
  const { tracks } = await db.getTracksAndSettings();
  const rootOf = new Map(tracks.map((t) => [t.key, t.fed_by || t.key]));
  const root = rootOf.get(key) || key;
  const group = [root, ...tracks.filter((t) => t.fed_by === root).map((t) => t.key)];

  const result = await db.unscreenUrls(group, urls);
  return json(result);
}
