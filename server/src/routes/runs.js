/**
 * The record that one track's scheduled search finished - see
 * ../../migrations/0001_schema.sql for why this is an explicit call rather
 * than something inferred from /api/leads.
 */

import { json, readJson } from "../http.js";
import { isoDate, unknownTrack } from "../validate.js";

/**
 * POST /api/runs - requires a Bearer token. Body
 * `{ search, status?, note?, at?, on? }` -> `{ ok, run, also }`; 400 for a
 * missing search, 404 for an unknown one.
 *
 * Called at the end of every run, including runs that found nothing: "found
 * nothing" is the case a tab can't otherwise tell apart from "didn't run".
 *
 * 404 rather than upserting an unknown key: it means the run's key and the
 * configured tracks have drifted apart, and an upserted row would be one no
 * tab displays.
 *
 * The caller supplies only what the run alone knows. The counts are derived
 * from each tab's own rows (db.countRunActivity), and one call writes a record
 * for the posted track and for every track it feeds.
 *
 * Count fields in the body are accepted and ignored, never refused: a refused
 * call loses the run record, and a missing record reads as a search that
 * stopped firing.
 *
 * Counting by date means a lead the person adds by hand today counts toward
 * today's run for that tab.
 */
export async function handleRecordRun({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const key = typeof body.search === "string" ? body.search : "";
  if (!key) return json({ error: "missing search (track key)" }, 400);
  if (!(await db.trackExists(key))) return unknownTrack(key);

  const now = new Date();
  // `at` is an instant the server can trust; a caller-supplied one is only
  // honoured if it parses, so a malformed clientside date can't poison the
  // staleness math into reading "ran in 2087" and never warning again.
  let at = now.toISOString();
  if (typeof body.at === "string" && body.at && !isNaN(Date.parse(body.at))) {
    at = new Date(body.at).toISOString();
  }
  // `on` is the caller's *local* date - the worker can't derive it (see the
  // note in migrations/0001_schema.sql). Falls back to the UTC date, which is right for
  // any run scheduled outside the hours where the two disagree.
  const on = isoDate(body.on) || at.slice(0, 10);

  const status = body.status === "error" ? "error" : "ok";
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : "";

  // Every tab this run fills: the posted track, then the tracks whose `fed_by`
  // names it. Read through getTracksAndSettings because handleGetPrompt decides
  // which tabs the prompt covers the same way, so the two can't disagree.
  const config = await db.getTracksAndSettings();
  const keys = [key, ...config.tracks.filter((t) => t.fed_by === key).map((t) => t.key)];

  // Each tab is counted from its own rows, then every record is written in one
  // transaction: a half-written fan-out would leave a searched tab reading as
  // never run, after the run that could have retried is over.
  const counted = await Promise.all(
    keys.map(async (k) => ({ key: k, at, on, status, note, ...(await db.countRunActivity(k, on)) }))
  );
  const runs = await db.recordRuns(counted);

  // `run` is the posted track's record; `also` holds the fed tabs' records, so
  // a run's own report can say what was written on its behalf.
  return json({ ok: true, run: runs[0], also: runs.slice(1) });
}
