/**
 * The account panel's own write (docs/account-settings-plan.md).
 *
 * POST /api/writeup is the overnight run's way into a search, and this is the
 * person's: each accepts only its own fields and refuses the other's by name,
 * whatever it is sent.
 */

import { json, readJson } from "../http.js";
import { LOCATION_SETTING_KEYS, parseDocumentList } from "../db.js";
import { fileName, isChoosableResume, listedPathFor, resumeParts, samePairName, withResume } from "../resumes.js";
import { locationSettingError, nowhereToSearchError, unreadableDocumentsError } from "../validate.js";

const ACCEPTED = ["resumes", ...LOCATION_SETTING_KEYS];

// Every refusal about a chosen resume says which search it is about, so the
// page can show it beside that search's picker.
function refuse(status, search, error) {
  return json({ error, search, field: "resume" }, status);
}

/**
 * POST /api/settings - requires a Bearer token. Body `{ resumes?: { <search>:
 * <path> }, search_locations?, excluded_locations?, priority_locations?,
 * location_note? }` -> `{ resumes: { <search>: { documents, profile_pending } },
 * locations: { <key>: <stored value> } }`.
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

  const resumes = body.resumes;
  if (resumes === undefined) {
    await db.setSettings(locations);
    return json({ resumes: {}, locations });
  }
  if (!resumes || typeof resumes !== "object" || Array.isArray(resumes)) {
    return json({ error: "resumes must be an object of search key to resume path", field: "resumes" }, 400);
  }

  if (!docs?.bucket) {
    return json({ error: "documents are not configured on this deployment - the DOCS R2 bucket is not bound (see server/wrangler.toml)" }, 503);
  }
  const rows = await db.getResumeState();
  const byKey = new Map(rows.map((r) => [r.key, r]));
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
  await db.setSettings(locations);
  return json({ resumes: reply, locations });
}
