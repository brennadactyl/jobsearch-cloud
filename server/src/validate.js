/**
 * The checks more than one route makes, and the date they all fall back to.
 *
 * Each of these was written out once per handler before it lived here, which
 * is how the same rule drifts into two slightly different rules: a stricter
 * date on one route than another, or a track check on the routes that read by
 * key and none on the two that write by it. Nothing here talks to D1 directly;
 * excluderFor takes the caller's already-scoped `Db` (see ./db.js).
 */

import { json } from "./http.js";
import { excludedCompanyMatcher } from "./exclude.js";

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// A caller-supplied local date, or "" if it isn't one. Every route that takes
// an `on` validates it identically, and the shape was written out ten times
// before this existed - which is nine chances for one of them to drift into
// accepting something the others refuse, on a value that decides what date
// rows are stamped with and, on /api/delist, whether a lead is deleted.
//
// Strict on purpose: no coercion, no "2026-9-1". The callers are LLM runs, and
// a value that isn't a date isn't a report of anything.
export function isoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

// The refusal every route that takes a single track key gives for a key that
// isn't one of the caller's configured tracks - /api/dedup/:key,
// /api/coverage/:key (both verbs), /api/runs, /api/prompt/:key, and the
// `search` move in /api/update. Worded identically on all of them because it
// always means the same thing: the caller's idea of this search and the
// tracker's have drifted apart.
export function unknownTrack(key) {
  return json({ error: `unknown track "${key}" - not in the configured tracks` }, 404);
}

// The guard /api/leads and /api/screened were missing. Every route that reads
// by track key - /api/dedup/:key, /api/coverage/:key (both verbs), /api/runs -
// 404s a key that isn't one of the caller's configured tracks, while those two
// write routes accepted whatever string they were handed. That asymmetry is
// how 145 leads and 185 screened rows came to sit under a retired "TPM" key:
// in the database, invisible on the page (a row's tab comes from the track
// list, and there was no longer a track named TPM), with nothing erroring on
// either side. Nothing said so until someone counted rows.
//
// A fed track passes like any other: `fed_by` marks a tab, not a non-track, so
// it is a row in `tracks` and a branched run legitimately files into it.
//
// @param {{key: string}[]} tracks this user's configured tracks
// @param {{search: string}[]} rows the payload rows, as the caller sent them
// @returns {Response|null} the 404 naming every unknown key, or null if clean
export function unknownTrackResponse(tracks, rows) {
  const configured = new Set(tracks.map((t) => t.key));
  const unknown = [...new Set(rows.map((r) => r.search))].filter((k) => !configured.has(k));
  if (unknown.length === 0) return null;
  // The whole request is refused rather than the drifted rows dropped. Partly
  // for symmetry with /api/runs, which answers the same drift the same way;
  // mostly because a partial insert leaves the run believing it filed rows it
  // did not. It reads `added`, reports that number in its own summary, and
  // treats those postings as ones it never has to go find again.
  const named = unknown.map((k) => `"${k}"`).join(", ");
  return json(
    { error: `unknown track${unknown.length > 1 ? "s" : ""} ${named} - not in the configured tracks` },
    404
  );
}

// The three folders a document can live in, which are also the three values of
// its `kind`. A list rather than "any folder" because the runner materializes
// these paths onto a disk (see scripts/run-search.ps1): an open-ended folder
// name is a directory this run creates on someone's machine, and the set that
// is actually meaningful has been three since private.example/README.md was
// written.
export const DOCUMENT_FOLDERS = ["docs", "resumes", "reference"];

// Whether a caller-supplied document path is one this API will store.
//
// One rule doing two jobs, which is why it is a single regexp rather than a
// classification step and a security step that could disagree. It fixes the
// vocabulary - one known folder, one plain filename, no nesting - so `kind` is
// derivable from the path itself with nothing stored alongside it. And in
// fixing it, it refuses "..", absolute paths, backslashes, empty segments and
// a leading dot, with no separate traversal check to keep correct.
//
// That second job is the load-bearing one. These paths are not only object
// keys: the nightly runner writes each of them to a file under its working
// directory. A path this accepted with a ".." in it would be a write-anywhere
// primitive on the machine running the search, reachable by anyone holding a
// session token.
//
// Deliberately narrow on filenames. Real ones here are `tracked_swe_postings.md`
// and `Someone_Resume.docx`; a name needing anything outside word characters,
// spaces, dots and hyphens is likelier a mistake or an attempt than a document
// somebody meant to store.
const DOCUMENT_PATH = new RegExp(`^(${DOCUMENT_FOLDERS.join("|")})/[\\w][\\w .-]*$`);

/** @param {unknown} path @returns {boolean} */
export function isDocumentPath(path) {
  return typeof path === "string" && DOCUMENT_PATH.test(path);
}

// The refusal every document route gives for a path it will not store. Names
// the rule rather than the offending part: the callers are a PowerShell script
// and an LLM run, and "what am I allowed to send" is the useful answer to both.
export function badDocumentPath(path) {
  return json(
    {
      error:
        `invalid document path "${path}" - must be ` +
        `<${DOCUMENT_FOLDERS.join("|")}>/<filename>, one folder deep, ` +
        "with a filename of word characters, spaces, dots or hyphens",
    },
    400
  );
}

// The exclusion predicate for this user, built from their settings. Every
// write path that can introduce a company needs it (leads, screened, and the
// coverage rotation both ways), and each one was fetching settings and
// building the matcher itself.
export async function excluderFor(db) {
  const { settings } = await db.getTracksAndSettings();
  return excludedCompanyMatcher(settings.excluded_companies);
}
