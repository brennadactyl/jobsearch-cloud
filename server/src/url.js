/**
 * What makes two URLs the same job posting.
 *
 * A run can reach one posting by several URLs: a search snippet appends
 * `?gh_src=...`, a board's JSON API hands back the bare path while its HTML
 * page carries a slug, an ATS echoes the req id into a query param the
 * canonical link doesn't have. Compared as raw strings - as
 * `UNIQUE(user_id, search, url)` compares them - those are different postings,
 * so a tracked posting gets re-added, and a delisted lead's screened URL fails
 * to match the variant the next run finds.
 *
 * ---- The rule, and why it isn't "strip the query string".
 * A req id is the identity, wherever it appears. So if the path or query holds
 * any run of 5+ digits, the key is the host plus those ids and nothing else,
 * which makes these one posting:
 *
 *   https://careers.roblox.com/jobs/7997105
 *   https://careers.roblox.com/jobs/7997105?gh_jid=7997105
 *
 * Never strip the query blindly. These share one path, and the query *is* the
 * identity - stripping it would merge an entire careers site into one row:
 *
 *   https://www.mongodb.com/careers/job/?gh_jid=7555398
 *   https://www.mongodb.com/careers/job/?gh_jid=7993419
 *
 * The digit rule reads both cases correctly because it never looks at which
 * component the id came from.
 *
 * Only when there is no id at all does this fall back to comparing the path and
 * the surviving query, the best available answer for a board that addresses
 * postings by slug alone.
 *
 * Re-run verify-local.mjs's URL checks after any change: a normalization that
 * is too aggressive doesn't announce itself, it silently eats real postings.
 */

// Params that are provenance, not identity: which search or campaign sent you
// to the posting. Anything not listed here is kept, because on some boards an
// unrecognized param is the id - see the MongoDB case above.
const TRACKING_PARAMS = new Set([
  "gh_src",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ref",
  "src",
  "source",
]);

// 5+ digits, not 4: a 4-digit run matches a year ("careers-2026"), and job
// boards don't number reqs that low.
const REQ_ID = /\d{5,}/g;

/**
 * The identity of the posting a URL points at. Two URLs for the same posting
 * return the same string; two postings never do.
 *
 * Total by design - a URL that doesn't parse returns its own lowercased text
 * rather than throwing. The callers are insert paths, and a malformed URL from
 * a run is a bad row to store, not a reason to lose the rest of the batch.
 *
 * @param {string} url
 * @returns {string} an opaque comparison key - meaningful only against another
 *   key from this same function, never parsed or displayed
 */
export function canonicalUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase();
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  for (const p of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
  }

  // Deduped and sorted, so the same id in both the path and the query counts
  // once and the order it appeared in doesn't matter.
  const ids = [...new Set(`${u.pathname} ${u.searchParams.toString()}`.match(REQ_ID) || [])].sort();
  if (ids.length) return `${host}#${ids.join(",")}`;

  const path = u.pathname.replace(/\/+$/, "").toLowerCase();
  const query = [...u.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${host}${path}${query ? `?${query}` : ""}`;
}
