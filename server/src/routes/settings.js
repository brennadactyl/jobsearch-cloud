/**
 * The account panel's own write (docs/account-settings-plan.md).
 *
 * POST /api/writeup is the overnight run's way into a search, and this is the
 * person's: each accepts only its own fields and refuses the other's by name,
 * whatever it is sent.
 */

import { json, readJson } from "../http.js";
import { LOCATION_SETTING_KEYS, PANEL_TRACK_FIELDS, parseDocumentList } from "../db.js";
import { PRONOUNS } from "../prompt.js";
import { fileName, isChoosableResume, listedPathFor, resumeParts, samePairName, withResume } from "../resumes.js";
import {
  DISPLAY_TITLE_MAX_CHARS,
  excludedCompaniesError,
  FIT_PROSE_MAX_CHARS,
  locationSettingError,
  nameError,
  halfSetPayFloorError,
  nowhereToSearchError,
  payFloorError,
  payFloorUnitError,
  pronounsError,
  ROLE_LINE_MAX_CHARS,
  searchProseError,
  TRACK_LABEL_MAX_CHARS,
  unreadableDocumentsError,
} from "../validate.js";

// The settings the panel writes as values, beside the location keys: what the
// page is called, how the prompt refers to the person, and who never to bring
// them. Each takes effect on the next read, so the panel promises nothing about
// tonight (docs/account-settings-plan.md).
const PANEL_SETTING_KEYS = ["display_title", "pronouns", "excluded_companies"];
const ACCEPTED = ["resumes", "searches", ...LOCATION_SETTING_KEYS, ...PANEL_SETTING_KEYS];

// What each field a search carries is checked against. A tab name and the
// roles line are refused empty: a tab needs a name, and an empty
// `role_search_line` is how the database says a search has never been written
// up (db.js WRITTEN_UP), so clearing it would put the search back in front of
// the overnight run as one still to build. The two rules may be cleared,
// because a rule someone no longer wants is one they can delete.
// `paused` is the one that isn't stored as sent: it is true or false, and the
// server stamps `paused_since` or clears it. Only the track that runs a search
// carries the switch - a tab follows its root - so pausing a tab is refused,
// naming the search to pause instead.
const SEARCH_FIELD_CHECKS = {
  label: (f, v) => nameError(f, v, TRACK_LABEL_MAX_CHARS),
  role_search_line: (f, v) => nameError(f, v, ROLE_LINE_MAX_CHARS),
  fit_clause: (f, v) => searchProseError(f, v, FIT_PROSE_MAX_CHARS),
  fit_disqualifier: (f, v) => searchProseError(f, v, FIT_PROSE_MAX_CHARS),
  paused: (f, v, track) => {
    if (typeof v !== "boolean") return "paused must be true or false";
    if (track.fed_by) return `"${track.fed_by}" fills this tab - pause that search and this tab pauses with it`;
    return "";
  },
  pay_floor: payFloorError,
  pay_floor_unit: payFloorUnitError,
};

// Every refusal about a chosen resume says which search it is about, so the
// page can show it beside that search's picker.
function refuse(status, search, error) {
  return json({ error, search, field: "resume" }, status);
}

/**
 * POST /api/settings - requires a Bearer token. Body `{ resumes?: { <search>:
 * <path> }, search_locations?, excluded_locations?, priority_locations?,
 * location_note?, display_title?, pronouns?, excluded_companies?, searches?:
 * { <key>: { label?, role_search_line?, fit_clause?, fit_disqualifier?,
 * paused?, pay_floor?, pay_floor_unit? } } }` -> `{ resumes: { <search>: { documents, profile_pending } },
 * locations: { <key>: <stored value> }, settings: { display_title, pronouns,
 * excluded_companies }, searches: { <key>: { label, role_search_line,
 * fit_clause, fit_disqualifier, paused_since, paused, pay_floor,
 * pay_floor_unit } } }`.
 *
 * The account panel's one Save, so a request may carry a resume choice, a place
 * edit, a page title and a tab rename together, and everything it can write
 * takes effect on the next read - the panel promises nothing about tonight
 * (docs/account-settings-plan.md). `settings` and `searches` in the reply are
 * read back after the write, not echoed from the request.
 *
 * `display_title` and each `label` are text, trimmed, refused empty; `pronouns`
 * is one the prompt knows or empty; `excluded_companies` is a list, and an
 * empty one means "exclude no one".
 *
 * `searches` writes a search's name and what it looks for, each field optional
 * and each refused by name with the search it belongs to. It can do nothing
 * else: the rest of a track's config, its place in the tab order and the track
 * list itself are `POST /api/config`'s, so a panel save can't drop a search.
 * `fit_clause` and `fit_disqualifier` accept "" and clear, since a rule someone
 * no longer wants is one they can delete; `label` and `role_search_line` are
 * refused empty (validate.js, db.js WRITTEN_UP). The reply's `searches` carries
 * every search, so one reply refreshes the panel.
 *
 * `paused` is true or false, and the server stamps `paused_since` or clears it:
 * the page never sends a time, and pausing a search already paused keeps the
 * instant it carries (docs/pause-search-plan.md). Only the track that runs a
 * search can be paused - a tab follows its root - so `paused` on a fed tab is a
 * 400 naming the search to pause instead. The reply carries each search's
 * `paused_since` and the resolved `paused` a reader shows.
 *
 * `pay_floor` is the lowest pay worth showing, as the person typed it, and
 * `pay_floor_unit` is `year` or `hour` beside it. Nothing reads a number out of
 * the amount - prompt.js states both in step 7 and the run judges a posting
 * against them (docs/search-fields-plan.md). The two are set together and
 * cleared together: a write that would leave one without the other is a 400
 * naming `pay_floor`, judged on what the save leaves, so sending one while the
 * other is stored is an ordinary edit.
 *
 * The location lists and note are stored as typed, trimmed at the ends, and
 * take effect on each search's next run (docs/location-settings-plan.md). Each
 * must be text within its cap, or the request is a 400 naming it. A write that
 * would leave both the searched and the ranked list empty is a 400 naming
 * `search_locations`; an empty searched list alone means "only the ranked
 * places".
 *
 * Points each named search at a resume. Send only the searches that changed;
 * naming the resume a search already reads changes nothing.
 *
 * - The path is a stored file under resumes/. A Word file is accepted, and the
 *   list names the text read from it, which is what a run reads; that text's
 *   own path is accepted as the same choice.
 * - The chosen resume replaces every resumes/ entry in the search's
 *   `documents` list. Anything else it reads, such as a reference file, stays.
 * - A change marks the search's profile stale (migrations/0018_profile_stale.sql),
 *   so its next run rewrites the profile from the new file.
 * - All or nothing: every search is checked before any is written, and the
 *   writes are one transaction.
 *
 * Refusals, each `{ error, search, field: "resume" }`: 404 for a search this
 * person doesn't have or a file that isn't stored; 400 for a tab another search
 * fills (its resume is that search's), or a path outside resumes/; 422 for a
 * file a search can't read. Any other key is a 400 naming it.
 *
 * Every part of a request is checked before any of it is written.
 */
export async function handlePostSettings({ request, db, docs }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  for (const sent of Object.keys(body)) {
    if (!ACCEPTED.includes(sent)) {
      return json({ error: `"${sent}" is not a setting this page can change`, field: sent }, 400);
    }
  }
  const locations = {};
  for (const key of LOCATION_SETTING_KEYS) {
    if (body[key] === undefined) continue;
    const problem = locationSettingError(key, body[key]);
    if (problem) return json({ error: problem, field: key }, 400);
    locations[key] = body[key].trim();
  }
  // Judged on what the write leaves, so clearing the searched list is accepted
  // while a ranked place is stored, and a save of other settings is never held
  // up by the lists.
  if ("search_locations" in locations || "priority_locations" in locations) {
    const { settings } = await db.getTracksAndSettings();
    const problem = nowhereToSearchError(
      locations.search_locations ?? settings.search_locations,
      locations.priority_locations ?? settings.priority_locations
    );
    if (problem) return json({ error: problem, field: "search_locations" }, 400);
  }

  const values = {};
  for (const key of PANEL_SETTING_KEYS) {
    if (body[key] === undefined) continue;
    const problem =
      key === "display_title"
        ? nameError(key, body[key], DISPLAY_TITLE_MAX_CHARS)
        : key === "pronouns"
          ? pronounsError(body[key], Object.keys(PRONOUNS))
          : excludedCompaniesError(body[key]);
    if (problem) return json({ error: problem, field: key }, 400);
    values[key] = typeof body[key] === "string" ? body[key].trim() : body[key];
  }

  const resumes = body.resumes;
  const searches = body.searches;
  if (searches !== undefined && (!searches || typeof searches !== "object" || Array.isArray(searches))) {
    return json({ error: "searches must be an object of search key to its fields", field: "searches" }, 400);
  }
  if (resumes !== undefined && (!resumes || typeof resumes !== "object" || Array.isArray(resumes))) {
    return json({ error: "resumes must be an object of search key to resume path", field: "resumes" }, 400);
  }
  // One read for both, since each names searches that have to exist.
  const rows = resumes === undefined && searches === undefined ? [] : await db.getResumeState();
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const bySearch = {};
  for (const [key, sent] of Object.entries(searches || {})) {
    if (!byKey.has(key)) return json({ error: `unknown search "${key}"`, search: key, field: "label" }, 404);
    if (!sent || typeof sent !== "object" || Array.isArray(sent)) {
      return json({ error: `the entry for ${key} must be an object of fields`, search: key, field: "label" }, 400);
    }
    for (const field of Object.keys(sent)) {
      if (!SEARCH_FIELD_CHECKS[field]) {
        return json({ error: `"${field}" is not something this page can change about a search`, search: key, field }, 400);
      }
    }
    const fields = {};
    for (const [field, value] of Object.entries(sent)) {
      const problem = SEARCH_FIELD_CHECKS[field](field, value, byKey.get(key));
      if (problem) return json({ error: problem, search: key, field }, 400);
      if (field !== "paused") fields[field] = value.trim();
    }
    // The page says paused or running and the server stamps the time, so no
    // caller can date a pause (docs/pause-search-plan.md, "The switch").
    // Pausing a search that is already paused keeps the instant it carries,
    // since a save of another field is not a new pause.
    if (sent.paused !== undefined) {
      const stored = byKey.get(key).paused_since || "";
      fields.paused_since = sent.paused ? stored || new Date().toISOString() : "";
    }
    // The amount and its unit are set together and cleared together, judged on
    // what the save leaves: sending one while the other is stored is a normal
    // edit, and sending neither leaves a floor alone.
    if (sent.pay_floor !== undefined || sent.pay_floor_unit !== undefined) {
      const track = byKey.get(key);
      const problem = halfSetPayFloorError(
        fields.pay_floor ?? track.pay_floor ?? "",
        fields.pay_floor_unit ?? track.pay_floor_unit ?? ""
      );
      if (problem) return json({ error: problem, search: key, field: "pay_floor" }, 400);
    }
    if (Object.keys(fields).length) bySearch[key] = fields;
  }

  if (resumes === undefined) {
    await db.setSettings({ ...locations, ...values });
    await db.setTrackFields(bySearch);
    return json({ resumes: {}, locations, ...(await panelState(db)) });
  }
  if (!docs?.bucket) {
    return json({ error: "documents are not configured on this deployment - the DOCS R2 bucket is not bound (see server/wrangler.toml)" }, 503);
  }
  const stored = (await docs.list()).map((d) => d.path);

  const changes = [];
  const reply = {};
  for (const [key, sent] of Object.entries(resumes)) {
    const track = byKey.get(key);
    if (!track) return refuse(404, key, `unknown search "${key}"`);
    const label = track.label || key;
    if (track.fed_by) {
      const root = byKey.get(track.fed_by);
      const rootLabel = root?.label || track.fed_by;
      return refuse(400, key, `${label} is filled by the ${rootLabel} search - choose the resume for ${rootLabel} instead`);
    }
    if (typeof sent !== "string" || !resumeParts(sent)) {
      return refuse(400, key, `the resume for ${label} must be a file under resumes/`);
    }
    // A list read back names a Word file's text, so a caller may send that; it
    // is the Word file's choice either way.
    const path = (resumeParts(sent).ext === "txt" && samePairName(stored, sent, "docx")[0]) || sent;
    if (!stored.includes(path)) return refuse(404, key, `there is no resume named ${fileName(path)}`);
    if (!isChoosableResume(stored, path)) {
      const why =
        resumeParts(path).ext === "docx"
          ? `no text was read from ${fileName(path)} - attach it again, or attach a PDF`
          : `a search can't read ${fileName(path)} - choose a PDF, Word (.docx), .txt or .md resume`;
      return refuse(422, key, why);
    }

    const current = parseDocumentList(track.documents);
    const documents = withResume(current, listedPathFor(stored, path));
    const problem = unreadableDocumentsError(documents);
    if (problem) return refuse(422, key, `${label}: ${problem}`);

    const changed = JSON.stringify(documents) !== JSON.stringify(current);
    if (changed) changes.push({ key, documents, was: current.find((p) => p.startsWith("resumes/")) || "" });
    // A search not yet written up gets its profile from the current resume when
    // it is, so it has nothing pending (db.setSearchResumes).
    reply[key] = { documents, profile_pending: !!track.role_search_line && (changed || !!track.profile_stale_since) };
  }

  await db.setSearchResumes(changes, new Date().toISOString());
  await db.setSettings({ ...locations, ...values });
  await db.setTrackFields(bySearch);
  return json({ resumes: reply, locations, ...(await panelState(db)) });
}

/**
 * The panel's values as they now stand, read back rather than echoed from the
 * request, so a save that stored a trimmed or de-duplicated value shows what a
 * reload would.
 * @param {import("../db.js").Db} db
 */
async function panelState(db) {
  const { tracks, settings } = await db.getTracksAndSettings();
  return {
    settings: {
      display_title: settings.display_title,
      pronouns: settings.pronouns,
      excluded_companies: settings.excluded_companies,
    },
    // Every search, not only the ones a save named, so one reply refreshes the
    // whole panel. `paused` rides along because it is what a reader shows: on a
    // tab it is the root's, while the tab's own `paused_since` stays empty.
    searches: Object.fromEntries(
      tracks.map((t) => [t.key, { ...Object.fromEntries(PANEL_TRACK_FIELDS.map((f) => [f, t[f]])), paused: t.paused }])
    ),
  };
}
