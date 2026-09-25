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
import { feedGroupKeys, searchRootKey, searchRootOf } from "../tracks.js";
import { dateDaysAgo, isoDate, storedKind, unknownTrack, unknownTrackResponse } from "../validate.js";
import { COVERAGE_BATCH, upcomingCompanies } from "./coverage.js";

// How far back a scoped dedup read keeps a screened URL at a company outside the
// window. The window covers what the run will be served; this covers what it is
// likeliest to meet anyway - a candidate its web search or step 3b ("NOW LOOK
// OUTSIDE THAT LIST") turned up on one of the last few nights. Short on purpose:
// most screened rows are recent, so a window of a couple of weeks keeps nearly
// every list whole and the scope stops trimming anything. A URL this drops is at
// worst verified again, because POST /api/screened and /api/leads refuse
// duplicates on the way in.
export const DEDUP_RECENT_DAYS = 3;

// Which tracked leads a run re-checks tonight (the prompt's step 8, "RE-CHECK
// THE LEADS DUE TONIGHT"). A feed group re-checks
// an even share of its open leads each night, so every one comes round within
// RECHECK_CYCLE_NIGHTS. RECHECK_MAX_PER_RUN caps what that costs a run: past it,
// the cycle stretches instead of the run growing. A lead confirmed live within
// RECHECK_AFTER_DAYS is not due, which is what keeps a small feed group from
// re-checking the same few leads every night.
//
// Open means New or Reviewing. A re-check of anything else changes nothing
// anyone uses: delisting keeps an Applied lead, or one with an application,
// whatever the check finds, and a Not a fit lead is one the person has already
// dismissed.
export const RECHECK_CYCLE_NIGHTS = 14;
export const RECHECK_MAX_PER_RUN = 20;
export const RECHECK_AFTER_DAYS = 7;
const RECHECK_STATUSES = ["New", "Reviewing"];

/**
 * Tonight's re-checks for one feed group: open leads not confirmed within
 * RECHECK_AFTER_DAYS, longest-unconfirmed first and then by id, at most the
 * group's budget. The same leads in give the same choice out, which is what
 * lets each tab's own read flag its share of one group-wide choice.
 * @param {Array<{id: number, status: string, verified: string}>} groupLeads
 * @returns {{eligible: number, budget: number, ids: Set<number>}}
 */
function chooseRechecks(groupLeads) {
  const open = groupLeads.filter((l) => RECHECK_STATUSES.includes(l.status));
  const budget = Math.min(RECHECK_MAX_PER_RUN, Math.ceil(open.length / RECHECK_CYCLE_NIGHTS));
  const dueBy = dateDaysAgo(RECHECK_AFTER_DAYS);
  const chosen = open
    .filter((l) => !l.verified || l.verified <= dueBy)
    .sort((a, b) => (a.verified || "").localeCompare(b.verified || "") || a.id - b.id)
    .slice(0, budget);
  return { eligible: open.length, budget, ids: new Set(chosen.map((l) => l.id)) };
}

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
 * URL screened in the last DEDUP_RECENT_DAYS. Two batches, because step 9e
 * ("REPLACE THE COMPANIES YOU COULDN'T READ") reads a second slice once step 9d
 * ("RECORD WHAT YOU COVERED") has moved the cursor, and a replacement company
 * that arrived with no history would be verified again. A fed tab takes the
 * window from the track whose search fills it, since that is the cursor its run
 * reads; its rows are still its own, because a delisted lead leaves its screened
 * row under the lead's tab. `leads` is never trimmed, since dedup needs every
 * URL a search tracks; a scoped read marks the ones due a re-check tonight with
 * `recheck: true`, chosen group-wide by chooseRechecks.
 *
 * The cutoff is the server's date, compared with dates runs stamp in their own
 * local time, so it can keep a day more than it says - the safe direction.
 *
 * `scope` is `{cursor, companies, since, kept, of, recheck}`, so a run's log can
 * say what it was given. `recheck` is `{eligible, budget, flagged, after_days}`:
 * `eligible` and `budget` for the whole feed group, `flagged` for this tab. Without
 * the parameter the response is exactly the unscoped one, with no flags.
 */
export async function handleGetDedup({ db, params, url }) {
  const key = params[0];
  const track = await db.getTrack(key);
  if (!track) return unknownTrack(key);
  if (url.searchParams.get("scope") !== "batch") return json(await db.getDedupData(key));

  const rootKey = searchRootOf(track);
  const upcoming = await upcomingCompanies(db, rootKey, 2 * COVERAGE_BATCH);
  const inWindow = new Set(upcoming.companies.map((c) => normalize(c.company)));
  const since = dateDaysAgo(DEDUP_RECENT_DAYS);
  const [{ leads, screened: rows }, groupLeads] = await Promise.all([
    db.getDedupRows(key),
    db.getFeedGroupLeadsForRecheck(rootKey),
  ]);
  const kept = rows.filter((r) => inWindow.has(normalize(r.company)) || r.date >= since);
  const recheck = chooseRechecks(groupLeads);
  const marked = leads.map((l) => (recheck.ids.has(l.id) ? { ...l, recheck: true } : l));
  return json({
    leads: marked,
    screened: kept.map((r) => r.url),
    scope: {
      cursor: upcoming.cursor,
      companies: upcoming.companies.length,
      since,
      kept: kept.length,
      of: rows.length,
      recheck: {
        eligible: recheck.eligible,
        budget: recheck.budget,
        flagged: marked.filter((l) => l.recheck).length,
        after_days: RECHECK_AFTER_DAYS,
      },
    },
  });
}

/**
 * POST /api/screened - requires a Bearer token. Body `{ search?, on?, screened:
 * [...] }` -> `{ added, duplicates, excluded, kinds_coerced?,
 * tabs_filed_at_root? }`; 400 for no valid items, 404 naming any unknown track
 * (nothing inserted).
 *
 * Each item's `search` is the tab the rejection was judged for, which for a
 * search filling several tabs is not always the one that ran: a row filed under
 * the root reads on the page as though a games search rejected a hospital. It
 * is kept when it names a track in the running search's own group - the body's
 * `search`, or the item's own for a caller that sends none - and falls back to
 * that group's root otherwise, counted in `tabs_filed_at_root`
 * (`{ <sent key>: <times> }`). A key no track has is still a 404 for the whole
 * batch; a key in another group is filed at the root rather than refused,
 * because a misfiled row is worth more than a lost one.
 *
 * Each item may carry a `kind` from validate.js SCREENED_KINDS, the part a page
 * groups and counts by; `reason` stays the sentence about that one posting. A
 * kind that isn't on the list is stored as the catch-all and named back in
 * `kinds_coerced` (`{ <sent value>: <times> }`, absent when nothing was
 * coerced), rather than refusing the row: the row is the only thing stopping
 * the next night re-finding this posting, so no grouping word is worth losing
 * one. An item with no kind stores "", which means nobody has said - a state
 * the operator backfill can still fill, unlike the catch-all.
 *
 * Records postings the search looked at and decided NOT to add as a lead (see
 * docs/glossary.md#postings). Deduped like handleAddLeads, but no
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
  // (`fed_by`, docs/glossary.md#searches-and-tracks) nothing displays screened
  // rows per tab and step 1b (`./tracker dedup`) reads them back as one set,
  // so they are filed under the feeding track below, whatever key the run sent.
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

  // A kind that isn't one of the list is stored as the catch-all rather than
  // refusing the row: the row is what stops the next night re-finding a posting
  // this one rejected, and no grouping word is worth losing that. What was
  // coerced is named back, so a run inventing a synonym is visible rather than
  // quietly filed (validate.js storedKind).
  const coerced = {};
  for (const item of allowed) {
    const { kind, coercedFrom } = storedKind(item.kind);
    item.kind = kind;
    if (coercedFrom) coerced[coercedFrom] = (coerced[coercedFrom] || 0) + 1;
  }

  // A rejection is filed under the tab it was judged for, when the run says
  // which: one search fills several tabs, and a row filed under the root reads
  // on the page as though a games search rejected a hospital. The run's own key
  // - the batch's `search`, or each item's own for a caller that sends none -
  // decides which group that may be, so a run can never file a rejection into
  // another search's tab. A key outside that group falls back to the root
  // rather than being refused: the row is what stops the next night re-finding
  // the posting, and a misfiled row is worth more than no row. Fallbacks are
  // named back, so a prompt that stops sending tabs is visible.
  //
  // One hop, not a walk to a root: a fed track is a tab, and the track that
  // fills it runs its own search, so `fed_by` chains have no meaning in the
  // model (see docs/glossary.md#searches-and-tracks) and none exist.
  const batchKey = typeof body.search === "string" && body.search.trim() ? body.search.trim() : "";
  const groupOf = (key) => new Set(feedGroupKeys(tracks, searchRootKey(tracks, key)));
  const batchGroup = batchKey ? groupOf(batchKey) : null;
  const tabsFallback = {};
  let namedATab = 0;
  const filed = allowed.map((item) => {
    const group = batchGroup || groupOf(item.search);
    const root = searchRootKey(tracks, batchKey || item.search);
    if (group.has(item.search)) {
      // Counted only when the tab is one this search fills: a key from another
      // group is a fallback, already counted as one, and counting it here too
      // would read as the run naming tabs correctly.
      if (item.search !== root) namedATab++;
      return { ...item, search: item.search };
    }
    tabsFallback[item.search] = (tabsFallback[item.search] || 0) + 1;
    return { ...item, search: root };
  });

  const { added, duplicates } = await db.addScreened(filed, on);
  const reply = { added, duplicates, excluded };
  if (Object.keys(coerced).length) reply.kinds_coerced = coerced;
  if (Object.keys(tabsFallback).length) reply.tabs_filed_at_root = tabsFallback;
  // How many rows said which tab they were judged for. A fallback count alone
  // can't show the failure worth seeing: a run that stopped naming tabs reports
  // no fallbacks, exactly like a night where every row named its own tab. Only
  // for a search that fills more than one tab - naming nothing is the whole
  // truth for a search with a single tab.
  if (batchGroup && batchGroup.size > 1) {
    reply.tabs_named = namedATab;
    reply.tabs_of = filed.length;
  }
  return json(reply);
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
  const group = feedGroupKeys(tracks, searchRootKey(tracks, key));

  const result = await db.unscreenUrls(group, urls);
  return json(result);
}
