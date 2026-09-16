/**
 * This person's configuration: which track tabs exist, what they're labelled,
 * and the prose settings ../prompt.js composes each track's daily search
 * prompt from. The client renders off this rather than a baked-in TRACKS
 * object, which is what lets one deployment hold several people's searches.
 */

import { WRITEUP_FIELDS, WRITEUP_SETTINGS } from "../db.js";
import { json, readJson } from "../http.js";
import { unknownTrack } from "../validate.js";

/**
 * GET /api/config - requires a Bearer token -> `{ tracks[], settings }`.
 *
 * Track tabs, tab labels, display title, priority-location rules and the
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
 * rules - as a side effect of every night it ran. This route makes "the run
 * leaves those alone" a guarantee: db.writeUpTrack builds its UPDATE from
 * WRITEUP_FIELDS and WRITEUP_SETTINGS, so a form-owned field is unreachable
 * here whatever the body says (docs/instant-setup-plan.md).
 *
 * An unaccepted key is refused rather than dropped, naming the key: a run that
 * tries to rename a tab should hear that it can't, not wonder later why the
 * rename didn't take.
 *
 * Writing a track that is already written up is ordinary - a retry night works
 * on a track that exists - so there is no conflict to report.
 *
 * POST /api/config stays as it is, for the tracker's own settings.
 */
export async function handleWriteUp({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const key = typeof body.search === "string" ? body.search.trim() : "";
  if (!key) return json({ error: "missing search (track key)" }, 400);

  const accepted = new Set([...WRITEUP_FIELDS, ...WRITEUP_SETTINGS, "search"]);
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
    if (sent !== "search" && typeof body[sent] !== "string") {
      return json({ error: `${sent} must be text`, field: sent }, 400);
    }
  }

  const written = await db.writeUpTrack(key, body);
  if (written === null) return unknownTrack(key);
  return json({ written });
}

/**
 * POST /api/config - requires a Bearer token. Body `{ tracks?, display_title?,
 * overview_label?, applications_label?, all_leads_label?, stale_run_hours?,
 * priority_locations?, excluded_companies?, geo_scope_line?, scope_clause?,
 * scope_disqualifier?, location_guidance?, footer_note?, pronouns? }` ->
 * `{ tracks[], settings }`; 400 for an empty or invalid track list, a `fed_by`
 * that isn't another listed track, or a non-positive `stale_run_hours`.
 *
 * `tracks` replaces the whole track list, since setup writes the complete set
 * at once. Leads and applications under a removed track keep their `search`
 * and only lose their tab. search_runs stays 1:1 with the list: new tracks gain
 * a "never ran" row, removed tracks lose theirs.
 */
export async function handleSetConfig({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (Array.isArray(body.tracks)) {
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
