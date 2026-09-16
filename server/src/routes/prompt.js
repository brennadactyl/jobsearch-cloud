/**
 * The daily search prompt for one track, composed from that track's D1 config
 * (see ../prompt.js) - what scripts/run-search.ps1 fetches and runs.
 */

import { json, text } from "../http.js";
import { buildAutofillPrompt, buildSearchPrompt } from "../prompt.js";
import { unknownTrack } from "../validate.js";

/**
 * GET /api/prompt/:key - requires a Bearer token -> text/plain; 404 for an
 * unknown track, 409 for a track with `fed_by` set (the error names the one to
 * run) or with no search config.
 *
 * text/plain because its consumer pipes it straight into the CLI.
 */
export async function handleGetPrompt({ db, user, params }) {
  const key = params[0];
  const [track, config] = await Promise.all([db.getTrack(key), db.getTracksAndSettings()]);
  if (!track) return unknownTrack(key);

  // A track with `fed_by` set is a tab, not a search: a sibling's run fills it
  // (docs/glossary.md#searches-and-tracks), and a prompt for it would be a
  // second, near-identical search of the same job boards.
  // setup-scheduler.ps1 registers no task for one, so this is reached by a
  // hand-run or by a task registered before the track was fed.
  if (track.fed_by) {
    return json(
      {
        error: `track "${key}" has no search of its own - "${track.fed_by}" fills it. Run that track instead.`,
      },
      409
    );
  }

  // A track with no search config would still compose a well-formed prompt
  // from the generic fallbacks - prompt.js falls back to "roles matching the
  // resume" - and a run would carry out that hollow search all night and report
  // success. `role_search_line` is what says which roles to look for, so a
  // track without it is not written up, whatever else has been filled in
  // (docs/onboarding.md#why-it-is-split-this-way). Every track starts in this state now: the
  // setup form creates it, and the overnight run writes it up.
  if (!track.role_search_line) {
    return json(
      {
        error: `track "${key}" has no role_search_line yet, so there is nothing to search for - the overnight run writes it up`,
        field: "role_search_line",
      },
      409
    );
  }

  // The tabs this run fills besides its own. Passing them turns the prompt
  // multi-tab: dedup for every key, a filing step, and a run record each.
  const feeds = config.tracks.filter((t) => t.fed_by === key);

  return text(buildSearchPrompt({ user, track, settings: config.settings, feeds }));
}

/**
 * GET /api/prompt/_applications - requires a Bearer token -> text/plain.
 *
 * The nightly fill for applications added as nothing but a URL, under a
 * reserved key rather than a track (see ./index.js for the route order).
 *
 * Its body doesn't depend on who asks: one nightly task covers every account
 * on a machine, so the prompt is written for "each account you were given" and
 * scripts/run-fill.ps1 supplies the accounts. A session is still required.
 *
 * Composed even when every queue is empty; the prompt's first step checks, and
 * a 409 for "nothing to do" would look like handleGetPrompt's 409s, which mean
 * a track is misconfigured.
 */
export async function handleGetAutofillPrompt() {
  return text(buildAutofillPrompt());
}
