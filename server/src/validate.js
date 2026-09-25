/**
 * The checks more than one route makes, defined once so no two routes enforce
 * slightly different versions of a rule. excluderFor takes the caller's
 * already-scoped `Db` (see ./db.js).
 */

import { json } from "./http.js";
import { excludedCompanyMatcher } from "./exclude.js";

export const DAY_MS = 86_400_000;

/** Today's UTC date as YYYY-MM-DD. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** The UTC date `days` days before now, as YYYY-MM-DD: the cutoff for "within the last N days". */
export function dateDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

// A caller-supplied local date, or "" if it isn't one. Strict on purpose - no
// coercion, no "2026-9-1": the callers are LLM runs, a value that isn't a date
// isn't a report of anything, and this value decides what date rows are
// stamped with and, on /api/delist, whether a lead is deleted.
export function isoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

// Where a person's search looks, as they typed it (docs/location-settings-plan.md):
// three comma-separated lists and a note, each one `meta` value. Nothing is
// split, matched or flagged here - the prompt reads each list as written, and
// the page builds its ranking from `priority_locations` itself - so the only
// checks are that each is text and fits. The caps keep a list to what a person
// types, since the prompt carries every one of them every night.
export const LOCATION_LIST_MAX_CHARS = 4000;
export const LOCATION_NOTE_MAX_CHARS = 1000;

/**
 * The entries of a location list, the one way everything splits it
 * (docs/location-settings-plan.md, "The three lists"): on commas, each entry
 * trimmed, empty ones dropped. "Portland, OR" is two entries. scripts/tracker.ps1
 * and the page split it the same way, so a value one accepts the other can't
 * refuse.
 * @param {unknown} list a stored location list, such as `priority_locations`
 * @returns {string[]}
 */
export function rankedEntries(list) {
  return typeof list === "string" ? list.split(",").map((e) => e.trim()).filter(Boolean) : [];
}

/**
 * A reported area as it is stored: the ranked entry it names, spelled as the
 * person typed it, or "" when it names none. It names an entry when, trimmed,
 * it equals that entry ignoring case - "portland or" is stored as "Portland
 * OR" - so every lead in one place carries one spelling and the page's tiering
 * is a plain equality. A near-miss - "Seattle" for "Seattle area" - is kept off
 * the lead rather than passing for a tier it doesn't name.
 * @param {unknown} area
 * @param {unknown} list the stored `priority_locations`
 * @returns {string}
 */
export function storedArea(area, list) {
  const value = typeof area === "string" ? area.trim().toLowerCase() : "";
  if (!value) return "";
  return rankedEntries(list).find((entry) => entry.toLowerCase() === value) ?? "";
}

/**
 * The refusal for a search with nowhere to look, or "". An empty searched list
 * means "only the ranked places" (docs/location-settings-plan.md, "Where they
 * are written"), so only both lists empty is refused. Entries are counted by
 * the one split rule, so a list of bare commas is empty.
 * @param {unknown} searched the `search_locations` the write leaves
 * @param {unknown} ranked the `priority_locations` the write leaves
 * @returns {string}
 */
export function nowhereToSearchError(searched, ranked) {
  if (rankedEntries(searched).length || rankedEntries(ranked).length) return "";
  return "say where to search, or rank at least one place first - the search needs somewhere to look";
}

/**
 * What is wrong with one location setting as sent, or "" for nothing. The
 * value is judged after trimming, which is how it is stored.
 * @param {string} key `search_locations`, `excluded_locations`,
 *   `priority_locations` or `location_note` (db.js LOCATION_SETTING_KEYS)
 * @param {unknown} value
 * @returns {string}
 */
export function locationSettingError(key, value) {
  if (typeof value !== "string") return `${key} must be text`;
  const max = key === "location_note" ? LOCATION_NOTE_MAX_CHARS : LOCATION_LIST_MAX_CHARS;
  if (value.trim().length > max) return `${key} is longer than ${max} characters`;
  return "";
}

// What the account panel names: the page's own title and each search's tab
// label (docs/account-settings-plan.md). Both are shown, not read, so the caps
// are what a heading can hold rather than anything the prompt depends on. An
// empty one is refused rather than stored, since a page with no title and a tab
// with no name are nothing a person means to ask for.
export const DISPLAY_TITLE_MAX_CHARS = 120;
export const TRACK_LABEL_MAX_CHARS = 60;

/**
 * What is wrong with a name someone typed for a page or a tab, or "". Judged
 * after trimming, which is how it is stored.
 * @param {string} field the key to name in the refusal
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function nameError(field, value, max) {
  if (typeof value !== "string") return `${field} must be text`;
  const name = value.trim();
  if (!name) return `${field} can't be empty`;
  if (name.length > max) return `${field} is longer than ${max} characters`;
  return "";
}

// What a search looks for, in the person's own words, as the account panel
// edits them (docs/account-settings-plan.md). The prompt carries each one every
// night, so the caps are what a person writes rather than what a column holds:
// a line for the roles, a paragraph for each rule.
export const ROLE_LINE_MAX_CHARS = 300;
export const FIT_PROSE_MAX_CHARS = 2000;

/**
 * What is wrong with one of a search's prose fields, or "". "" is a real value
 * and clears the field - a rule someone no longer wants is one they can delete.
 * `role_search_line` is the exception and is checked with nameError instead:
 * empty is how the database says a search has never been written up
 * (db.js WRITTEN_UP), so clearing it would tell the overnight run this search
 * still has to be built.
 * @param {string} field the key to name in the refusal
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function searchProseError(field, value, max) {
  if (typeof value !== "string") return `${field} must be text`;
  if (value.trim().length > max) return `${field} is longer than ${max} characters`;
  return "";
}

// Which sort of rejection a screened row was (migrations/0027_screened_kind.sql):
// a closed list, because a page groups and counts by it and a value that drifts
// makes a group nobody can read. The row's `reason` stays the sentence about
// that one posting; this is the part that answers "how many, of what".
//
// KIND_WHEN_UNKNOWN is where anything else is filed. A run sending a word that
// isn't here is not refused - the row is what stops the next night re-finding a
// posting this one rejected, and no grouping nicety is worth losing that.
//
// The catch-all should stay near-empty, and that is how this list is judged: it
// was derived from what nights actually write rather than guessed at, so a
// rising count there means the kinds have drifted from the work - either the
// prompt's wording has moved, or searches are rejecting postings for a reason
// none of these describes and one is missing.
// `delisted` is first because it outranks the rest: a posting found already
// gone was never anyone's, while a delisted one was a lead on someone's board
// and then vanished. It is also the kind a purge has to recognise, since that
// row is a person's own decision rather than a run's screening.
export const SCREENED_KINDS = [
  "delisted", "dead", "duplicate", "out-of-scope", "pay-below-floor",
  "wrong-level", "wrong-role", "contract", "other",
];
export const KIND_WHEN_UNKNOWN = "other";

// Which kinds are a person's own settings turning a posting down, rather than a
// fact about the posting. This is the whole of "26 screened out": a night that
// met a dead link and a duplicate did not screen anything out, and counting
// those makes a quiet night read as a busy one. `dead`, `duplicate` and
// `delisted` are facts; a row with no kind is nobody's claim either way.
//
// One list, read by every count and by what GET /api/data serves, so no caller
// re-derives it (routes/data.js, db.countRunActivity). verify-local checks that
// every kind is on exactly one side of this, so a tenth kind fails the checks
// until someone decides which it is rather than inheriting a default.
export const SCREENED_BY_RULES = [
  "out-of-scope", "wrong-level", "wrong-role", "contract", "pay-below-floor",
];
// The rest, named rather than inferred, so the two lists can be checked against
// SCREENED_KINDS. `other` sits here because it is a rejection none of the named
// kinds describes: nobody can say it was a person's settings that caused it,
// and a count that exists to answer "what did my settings turn away" should not
// include a row we cannot attribute.
export const SCREENED_NOT_BY_RULES = ["delisted", "dead", "duplicate", "other"];

/**
 * The kind to store for what a caller sent, and whether it had to be changed.
 * "" stays "" - a row nobody has classified is not the same as one classified
 * as the catch-all, and only the first can be filled in later.
 * @param {unknown} sent
 * @returns {{kind: string, coercedFrom: string}}
 */
export function storedKind(sent) {
  const value = typeof sent === "string" ? sent.trim().toLowerCase() : "";
  if (!value) return { kind: "", coercedFrom: "" };
  if (SCREENED_KINDS.includes(value)) return { kind: value, coercedFrom: "" };
  return { kind: KIND_WHEN_UNKNOWN, coercedFrom: typeof sent === "string" ? sent : String(sent) };
}

/**
 * The refusal for a kind an operator sent that isn't one of the list, or "".
 * It quotes what was sent: the operator is classifying rows in bulk from a
 * file, and "which value was wrong" is the thing they have to go and fix.
 */
export function screenedKindError(field, value) {
  if (typeof value !== "string" || !SCREENED_KINDS.includes(value)) {
    const sent = typeof value === "string" ? `"${value}"` : `${field} of ${typeof value}`;
    return `${sent} is not a kind - one of ${SCREENED_KINDS.join(", ")}`;
  }
  return "";
}

// The lowest pay worth showing (docs/search-fields-plan.md): the amount as the
// person typed it, and the one part that has to be machine-readable beside it.
// The cap is what an amount runs to - "$180,000 base" is already generous -
// rather than anything the column needs; the prompt carries it every night.
export const PAY_FLOOR_MAX_CHARS = 40;
export const PAY_FLOOR_UNITS = ["year", "hour"];

/**
 * What is wrong with a pay floor's amount, or "". "" clears it, and nothing
 * here reads a number out of the text: "180k", "$180,000" and "£140,000" are
 * all a person saying what they mean, and the last says its own currency.
 * @param {string} field the key to name in the refusal
 * @param {unknown} value
 * @returns {string}
 */
export function payFloorError(field, value) {
  if (typeof value !== "string") return `${field} must be text`;
  if (value.trim().length > PAY_FLOOR_MAX_CHARS) {
    return `${field} is longer than ${PAY_FLOOR_MAX_CHARS} characters - it is an amount, not a rule`;
  }
  return "";
}

/**
 * What is wrong with a pay floor's unit, or "". Two values and "", because
 * this is the half the prompt has to state as words ("a year", "an hour")
 * rather than repeat.
 * @param {string} field
 * @param {unknown} value
 * @returns {string}
 */
export function payFloorUnitError(field, value) {
  if (typeof value !== "string" || (value !== "" && !PAY_FLOOR_UNITS.includes(value))) {
    return `${field} must be ${PAY_FLOOR_UNITS.join(" or ")}, or "" for no floor`;
  }
  return "";
}

/**
 * The refusal when a write would leave a pay floor half set, or "". The two
 * are set together and cleared together: a unit with no amount says nothing,
 * and an amount with no unit can't be stated in the prompt. Judged on what the
 * write leaves, so sending one while the other is already stored is fine.
 * @param {string} amount the `pay_floor` the write leaves
 * @param {string} unit the `pay_floor_unit` it leaves
 * @returns {string}
 */
export function halfSetPayFloorError(amount, unit) {
  if (!amount && unit) return "a pay floor needs an amount as well as a unit";
  if (amount && !unit) return `a pay floor needs a unit - ${PAY_FLOOR_UNITS.join(" or ")}`;
  return "";
}

/**
 * What is wrong with a `pronouns` setting, or "". "" is unset; the rest are the
 * pronouns the prompt knows how to write, which the caller passes rather than
 * this importing prompt.js, since prompt.js reads this file.
 * @param {unknown} value
 * @param {string[]} known the keys of prompt.js's PRONOUNS
 * @returns {string}
 */
export function pronounsError(value, known) {
  if (typeof value !== "string" || (value !== "" && !known.includes(value))) {
    return `pronouns must be ${known.join(", ")} or empty`;
  }
  return "";
}

// A cap on what a person can type, not on what the feature supports: every
// lead is matched against this list on every run (exclude.js).
export const EXCLUDED_COMPANIES_MAX = 500;
const COMPANY_NAME_MAX_CHARS = 200;

/**
 * What is wrong with a list of companies to exclude, or "". An empty list is a
 * real instruction ("exclude no one"), so it passes; blank entries are dropped
 * on the way in (db.setSettings) rather than refused, since a trailing chip is
 * a typing artefact, not a mistake worth stopping a save for.
 * @param {unknown} list
 * @returns {string}
 */
export function excludedCompaniesError(list) {
  if (!Array.isArray(list)) return "excluded_companies must be a list";
  if (list.length > EXCLUDED_COMPANIES_MAX) return `at most ${EXCLUDED_COMPANIES_MAX} companies`;
  if (list.some((c) => typeof c !== "string")) return "each excluded company must be text";
  if (list.some((c) => c.length > COMPANY_NAME_MAX_CHARS)) {
    return `an excluded company is longer than ${COMPANY_NAME_MAX_CHARS} characters`;
  }
  return "";
}

// The refusal for a track key that isn't one of the caller's configured tracks.
// Worded identically on every route because it always means the same thing:
// the caller's idea of this search and the tracker's have drifted apart.
export function unknownTrack(key) {
  return json({ error: `unknown track "${key}" - not in the configured tracks` }, 404);
}

// unknownTrack for a batch whose rows each name a track. A row filed under a
// key that isn't a configured track is stored but invisible on the page (a
// row's tab comes from the track list), and nothing errors on either side.
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
  // Refuse the whole request; never drop just the drifted rows. The run reads
  // `added` as filed and treats those postings as ones it never has to find
  // again.
  const named = unknown.map((k) => `"${k}"`).join(", ");
  return json(
    { error: `unknown track${unknown.length > 1 ? "s" : ""} ${named} - not in the configured tracks` },
    404
  );
}

// The folders a document can live in, which are also the values of its `kind`.
// A fixed list because the runner materializes these paths onto a disk (see
// scripts/run-search.ps1), where an open-ended folder name is a directory
// created on someone's machine.
export const DOCUMENT_FOLDERS = ["docs", "resumes", "reference"];

// One known folder and one plain filename, no nesting, so `kind` is derivable
// from the path itself.
//
// This is a security boundary. The nightly runner writes each path to a file
// under its working directory, so this regexp alone is what refuses "..",
// absolute paths, backslashes, empty segments and a leading dot - a path that
// got past it would be a write-anywhere primitive for any session token. Don't
// loosen it, and don't split it into separate classification and traversal
// checks that could disagree. Filenames are narrow on purpose: a name needing
// more than word characters, spaces, dots and hyphens is likelier a mistake or
// an attack than a document.
//
// A filename of word characters, spaces, dots and hyphens that starts and ends
// with a word character. The ends matter because Windows silently strips a
// trailing space or dot when it creates a file: `x.md ` would materialize as
// `x.md`, and the hash-compared write-back would PUT to `x.md`, orphaning the
// original and editing a second copy.
const PLAIN_FILENAME = String.raw`\w(?:[\w .-]*\w)?`;
const DOCUMENT_PATH = new RegExp(`^(${DOCUMENT_FOLDERS.join("|")})/${PLAIN_FILENAME}$`);

// DOS device names are not filenames on Windows whatever extension follows:
// `CON`, `PRN.md` and `aux.txt` all resolve to a device, so the runner's write
// appears to succeed while `Test-Path` reports no file. Matched against the
// stem before the first dot, case-insensitively, the way Windows resolves it.
const DOS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** @param {unknown} path @returns {boolean} */
export function isDocumentPath(path) {
  if (typeof path !== "string" || !DOCUMENT_PATH.test(path)) return false;
  const name = path.slice(path.indexOf("/") + 1);
  return !DOS_DEVICE.test(name.split(".")[0]);
}

// A search reads its tracking doc, a resume or two and perhaps a reference file.
// The cap is there to refuse a list that is really "everything", not to fit
// normal searches.
export const TRACK_DOCUMENTS_MAX = 20;

/**
 * What is wrong with a track's `documents` list (migrations/0017), or null.
 * Checked on every write path to it, so the runner never asks R2 for a path
 * that could not name a document.
 *
 * Paths only, not whether each exists: a list can be written before its files
 * are uploaded, and GET /api/documents?search= reports what is missing at the
 * point a run needs it.
 * @param {unknown} list
 * @returns {string|null}
 */
export function trackDocumentsError(list) {
  if (!Array.isArray(list)) return "documents must be a list of document paths";
  if (list.length > TRACK_DOCUMENTS_MAX) return `at most ${TRACK_DOCUMENTS_MAX} documents for one search`;
  const bad = list.filter((p) => !isDocumentPath(p));
  if (bad.length) {
    return `not a document path: ${bad.map((p) => JSON.stringify(p)).join(", ")} - a path is ${DOCUMENT_FOLDERS.map((f) => `${f}/`).join(", ")} and a plain file name`;
  }
  return null;
}

// What an overnight run can read as it is. A Word resume is read through the
// text the server extracts beside it on upload, so a list names that text, never
// the .docx (routes/documents.js). The client's READABLE_RESUME_EXTENSIONS adds
// docx for the same reason: the person attaches the Word file.
export const READABLE_DOCUMENT_EXTENSIONS = ["txt", "md", "pdf"];

/** @param {string} path @returns {string} the lowercased extension, '' for none */
export function documentExtension(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Why a search reading this `documents` list would have no resume to read, or
 * null. Separate from trackDocumentsError because the callers exempt a list
 * that is unchanged from what is stored: posting config back as it was read
 * isn't a choice of documents, and refusing it would block every other edit
 * to a search set up before this rule.
 * @param {string[]} list already passed trackDocumentsError
 * @returns {string|null}
 */
export function unreadableDocumentsError(list) {
  if (list.length === 0) return "a search needs at least one document to read - its resume";
  const word = list.filter((p) => ["docx", "doc"].includes(documentExtension(p)));
  if (word.length) {
    return `a run can't read a Word file: ${word.map((p) => JSON.stringify(p)).join(", ")} - list the .txt read from it instead`;
  }
  if (!list.some((p) => READABLE_DOCUMENT_EXTENSIONS.includes(documentExtension(p)))) {
    return `none of these documents can be read by a run - a search needs at least one .${READABLE_DOCUMENT_EXTENSIONS.join(", .")} file`;
  }
  return null;
}

// Names the whole rule rather than the offending part: the callers are a
// PowerShell script and an LLM run, and what they may send is the useful answer.
export function badDocumentPath(path) {
  return json(
    {
      error:
        `invalid document path "${path}" - must be ` +
        `<${DOCUMENT_FOLDERS.join("|")}>/<filename>, one folder deep, ` +
        "with a filename of word characters, spaces, dots or hyphens, " +
        "starting and ending with a letter or digit, and not a reserved " +
        "Windows device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9)",
    },
    400
  );
}

// Every write path that can introduce a company filters through this.
export async function excluderFor(db) {
  const { settings } = await db.getTracksAndSettings();
  return excludedCompanyMatcher(settings.excluded_companies);
}
