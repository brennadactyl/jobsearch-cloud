/**
 * The daily search prompt for one track, composed from that track's D1 config
 * (see ../prompt.js) - what scripts/run-search.ps1 fetches and runs.
 */

import { json, text } from "../http.js";
import { buildAutofillPrompt, buildSearchPrompt, DEFAULT_DOC_BUDGET_BYTES } from "../prompt.js";
import { tracksFedBy } from "../tracks.js";
import { unknownTrack } from "../validate.js";

/**
 * GET /api/prompt/:key - requires a Bearer token -> text/plain; 404 for an
 * unknown track, 409 for a track with `fed_by` set (the error names the one to
 * run), a paused search (with `paused_since`), or one with no search config.
 *
 * Each 409 body carries a `code` - `fed_tab`, `paused` or `not_written_up` -
 * because the three mean different things to a runner: a leftover task, a
 * search someone stopped, and one the overnight run has still to write up.
 * scripts/run-search.ps1 branches on it, so the sentences stay free to change.
 *
 * `?doc_budget=<bytes>` sets how much step 8b tells the run it may add to its
 * doc. scripts/run-search.ps1 passes the budget it enforces, so the number lives
 * in one place. A value that isn't a whole number from 100 to 20000 is ignored
 * rather than refused: a bad parameter must not cost a night's run.
 *
 * text/plain because its consumer pipes it straight into the CLI.
 */
export async function handleGetPrompt({ db, user, params, url }) {
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
        code: "fed_tab",
      },
      409
    );
  }

  // A paused search keeps everything it found and runs nothing
  // (migrations/0025_track_paused.sql). setup-scheduler.ps1 registers no task
  // for one, so this is reached by a task left over on some machine: refused
  // here so that task can't run it, with the date so its log says why.
  if (track.paused_since) {
    return json(
      {
        error: `search "${key}" has been paused since ${track.paused_since} - resume it in the tracker's config to run it again`,
        code: "paused",
        paused_since: track.paused_since,
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
        code: "not_written_up",
        field: "role_search_line",
      },
      409
    );
  }

  // The tabs this run fills besides its own. Passing them turns the prompt
  // multi-tab: dedup for every key, a filing step, and a run record each.
  const feeds = tracksFedBy(config.tracks, key);

  return text(buildSearchPrompt({ user, track, settings: config.settings, feeds, docBudget: docBudgetFrom(url) }));
}

function docBudgetFrom(url) {
  const raw = url ? url.searchParams.get("doc_budget") : null;
  const n = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return n >= 100 && n <= 20000 ? n : DEFAULT_DOC_BUDGET_BYTES;
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
