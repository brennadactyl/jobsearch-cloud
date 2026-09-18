/**
 * This person's configuration: which track tabs exist, what they're labelled,
 * and the prose settings ../prompt.js composes each track's daily search
 * prompt from. The client renders off this rather than a baked-in TRACKS
 * object, which is what lets one deployment hold several people's searches.
 */

import { LOCATION_SETTING_KEYS, parseDocumentList, WRITEUP_FIELDS } from "../db.js";
import { json, readJson } from "../http.js";
import { locationSettingError, trackDocumentsError, unknownTrack, unreadableDocumentsError } from "../validate.js";

/**
 * The refusal for a `documents` list a search couldn't read its resume from,
 * or null. A list identical to the stored one passes, so config read and
 * posted back is accepted for a search set up before this rule. So does a tab
 * another search fills, whose own list no run reads.
 * @param {string[]} list already passed trackDocumentsError
 * @param {string[]|null} storedList the list as stored, null for a new track
 * @param {string} fedBy the track's `fed_by` once this write lands
 * @returns {string|null}
 */
/**
 * What is wrong with a track's `paused_since` as posted, or null, normalising a
 * valid one in place (migrations/0025_track_paused.sql).
 *
 * "" resumes the search; anything else must be an instant, stored in the one
 * ISO form so the page and the prompt refusal print it the same way. Only the
 * track that runs a search is paused: a tab another search fills follows it, so
 * a stamp on the tab would be a second switch that disagrees with the first.
 *
 * @param {Object} t the track as posted; `t.paused_since` is rewritten when valid
 * @param {{fed_by?: string}|undefined} was the track as stored
 * @returns {string|null}
 */
function pausedSinceError(t, was) {
  if (t.paused_since === undefined || t.paused_since === "") return null;
  if (typeof t.paused_since !== "string" || Number.isNaN(Date.parse(t.paused_since))) {
    return "paused_since must be an ISO 8601 instant, or \"\" to resume";
  }
  // replaceTracks keeps a stored fed_by that the post leaves out.
  const fedBy = typeof t.fed_by === "string" ? t.fed_by : was?.fed_by || "";
  if (fedBy) return `a tab filled by "${fedBy}" is paused with that search - pause "${fedBy}" instead`;
  t.paused_since = new Date(t.paused_since).toISOString();
  return null;
}

function documentsChoiceError(list, storedList, fedBy) {
  if (fedBy) return null;
  const deduped = [...new Set(list)];
  if (storedList && JSON.stringify(deduped) === JSON.stringify(storedList)) return null;
  return unreadableDocumentsError(deduped);
}

/**
 * GET /api/config - requires a Bearer token -> `{ tracks[], settings }`.
 *
 * Track tabs, tab labels, display title, the location lists and the
 * staleness threshold, plus each track's search config and the prose settings.
 * Each track carries its own `last_run`.
 */
export async function handleGetConfig({ db }) {
  return json(await db.getTracksAndSettings());
}

/**
 * POST /api/writeup - requires a Bearer token. Body `{ search, <write-up
 * fields> }` -> `{ written: [field, ...] }`; 400 for a missing search or a key
 * this route does not accept, 404 for an unknown track.
 *
 * The overnight run's only way into a track's config. A run that read the whole
 * config, edited it and posted it back through POST /api/config would re-write
 * the setup form's fields - `label`, `sort_order`, the title, the location
 * lists - as a side effect of every night it ran. This route makes "the run
 * leaves those alone" a guarantee: db.writeUpTrack builds its UPDATE from
 * WRITEUP_FIELDS, so a form-owned field is unreachable
 * here whatever the body says (docs/onboarding.md#why-it-is-split-this-way).
 *
 * An unaccepted key is refused rather than dropped, naming the key: a run that
 * tries to rename a tab should hear that it can't, not wonder later why the
 * rename didn't take.
 *
 * Writing a track that is already written up is ordinary - a retry night works
 * on a track that exists - so there is no conflict to report.
 *
 * `profile_refreshed` is the runner's, and not a field: it echoes the
 * `profile_stale.since` it read from GET /api/documents?search= once it has
 * accepted the rewritten profile, and clears the mark only if no resume change
 * has landed since (migrations/0018_profile_stale.sql). `written` names it only
 * when the mark was cleared.
 *
 * POST /api/config stays as it is, for the tracker's own settings.
 */
export async function handleWriteUp({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const key = typeof body.search === "string" ? body.search.trim() : "";
  if (!key) return json({ error: "missing search (track key)" }, 400);

  const accepted = new Set([...WRITEUP_FIELDS, "search", "profile_refreshed"]);
  for (const sent of Object.keys(body)) {
    if (!accepted.has(sent)) {
      return json(
        {
          error: `"${sent}" is not a field the overnight run writes - the setup form owns it, and it can only be changed from the tracker`,
          field: sent,
        },
        400
      );
    }
    // `documents` is the one list among the run's fields; everything else is
    // prose the prompt reads.
    if (sent === "documents") {
      const problem = trackDocumentsError(body.documents);
      if (problem) return json({ error: problem, field: "documents" }, 400);
    } else if (sent !== "search" && typeof body[sent] !== "string") {
      return json({ error: `${sent} must be text`, field: sent }, 400);
    }
  }

  const stored = await db.getTrack(key);
  if (!stored) return unknownTrack(key);
  if ("documents" in body) {
    const problem = documentsChoiceError(body.documents, parseDocumentList(stored.documents), stored.fed_by);
    if (problem) return json({ error: problem, field: "documents" }, 400);
  }

  const fields = "documents" in body ? { ...body, documents: JSON.stringify([...new Set(body.documents)]) } : body;
  const written = await db.writeUpTrack(key, fields);
  if (written === null) return unknownTrack(key);
  return json({ written });
}

/**
 * POST /api/config - requires a Bearer token. Body `{ tracks?, display_title?,
 * overview_label?, applications_label?, all_leads_label?, stale_run_hours?,
 * search_locations?, excluded_locations?, priority_locations?, location_note?,
 * excluded_companies?, footer_note?, pronouns? }` -> `{ tracks[], settings }`;
 * 400 for an empty or invalid track list, a `fed_by` that isn't another listed
 * track, a non-positive `stale_run_hours`, or a location setting that isn't
 * text or is too long (validate.js locationSettingError).
 *
 * `tracks` replaces the whole track list, since setup writes the complete set
 * at once. Leads and applications under a removed track keep their `search`
 * and only lose their tab. search_runs stays 1:1 with the list: new tracks gain
 * a "never ran" row, removed tracks lose theirs.
 */
export async function handleSetConfig({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  // Checked before anything is written, so a refused value leaves the tracks as
  // they were too.
  for (const key of LOCATION_SETTING_KEYS) {
    if (body[key] === undefined) continue;
    const problem = locationSettingError(key, body[key]);
    if (problem) return json({ error: problem, field: key }, 400);
  }

  if (Array.isArray(body.tracks)) {
    const stored = new Map((await db.getTracksAndSettings()).tracks.map((t) => [t.key, t]));
    const valid = body.tracks.filter((t) => t && typeof t.key === "string" && t.key);
    if (valid.length === 0) return json({ error: "tracks must be a non-empty array of {key, ...}" }, 400);
    // A `fed_by` pointing anywhere but at another track in this same list is a
    // tab no search fills: nothing lands in it and nothing records a run
    // against it, so it sits there reading "no run recorded yet" forever with
    // no error anywhere to say why.
    const keys = new Set(valid.map((t) => t.key));
    for (const t of valid) {
      if (t.fed_by && (t.fed_by === t.key || !keys.has(t.fed_by))) {
        return json({ error: `track "${t.key}" is fed_by "${t.fed_by}", which is not another track in this list` }, 400);
      }
      const paused = pausedSinceError(t, stored.get(t.key));
      if (paused) return json({ error: `track "${t.key}": ${paused}`, field: "paused_since" }, 400);
      if (t.documents !== undefined) {
        const problem = trackDocumentsError(t.documents);
        if (problem) return json({ error: `track "${t.key}": ${problem}`, field: "documents" }, 400);
        // replaceTracks keeps a stored fed_by that the post leaves out.
        const was = stored.get(t.key);
        const fedBy = typeof t.fed_by === "string" ? t.fed_by : was?.fed_by || "";
        const unreadable = documentsChoiceError(t.documents, was ? was.documents : null, fedBy);
        if (unreadable) return json({ error: `track "${t.key}": ${unreadable}`, field: "documents" }, 400);
      }
    }
    // Each track carries its display fields and, optionally, its search
    // config (TRACK_CONFIG_FIELDS in db.js - the role line, target companies,
    // candidate blurb and so on that prompt.js composes the daily prompt
    // from). replaceTracks whitelists them itself and keeps the stored value of
    // any field a track leaves out, so renaming a tab doesn't blank its config;
    // sending "" clears a field.
    await db.replaceTracks(valid);
  }

  // db.setSettings reads only its own keys (SETTING_KEYS, PROMPT_SETTING_KEYS,
  // priority_locations, excluded_companies), so a tracks-only post is a no-op
  // there.
  if (body.stale_run_hours != null) {
    const n = Number(body.stale_run_hours);
    if (!Number.isFinite(n) || n <= 0) return json({ error: "stale_run_hours must be a positive number" }, 400);
  }
  await db.setSettings(body);

  return json(await db.getTracksAndSettings());
}
