/**
 * Nightly run logs: what each search did, kept in R2 rather than only on the
 * machine that ran it (../r2.js, RunLogs, has where and why).
 *
 * A search uploads its own run's log as its last act (scripts/run-search.ps1).
 * The log is written once per run and named by when that run started, so an
 * upload that is retried replaces itself rather than adding a second copy.
 */

import { CORS_HEADERS, json } from "../http.js";
import { unknownTrack } from "../validate.js";

// A run's log is tens of kilobytes. The cap is there so a run that loops and
// writes megabytes of output can't fill the bucket, not to fit normal runs.
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

// When the run started, in UTC, as a name that sorts in time order and is safe
// as part of an R2 key and a URL: 2026-09-16T08-00-01Z.
const STARTED = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

function missingBucket(runLogs) {
  if (runLogs && runLogs.bucket) return null;
  return json(
    { error: "run logs are not configured on this deployment - the DOCS R2 bucket is not bound (see server/wrangler.toml)" },
    503
  );
}

function badStarted(started) {
  return json(
    { error: `"${started}" is not a run start time - expected UTC as yyyy-MM-ddTHH-mm-ssZ, e.g. 2026-09-16T08-00-01Z` },
    400
  );
}

/**
 * PUT /api/logs/<track>/<started> - requires a Bearer token. Body: the run's
 * log, as text -> `{ track, started, bytes }`; 400 for a malformed start time,
 * 404 for a track this person doesn't have, 413 over MAX_LOG_BYTES, 503 with no
 * bucket bound.
 *
 * The track has to be one of the caller's configured tracks, which is also
 * what keeps the key well-formed: a track key is a single path segment, and
 * only a key this person already has reaches R2.
 */
export async function handlePutRunLog({ request, db, runLogs, params }) {
  const unconfigured = missingBucket(runLogs);
  if (unconfigured) return unconfigured;

  const [track, started] = params;
  if (!STARTED.test(started)) return badStarted(started);
  if (!(await db.trackExists(track))) return unknownTrack(track);

  // Refused on the declared length before reading, and on the buffered length
  // after, as documents are: the object is never written oversized.
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_LOG_BYTES) return tooLarge(declared);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_LOG_BYTES) return tooLarge(body.byteLength);

  const written = await runLogs.put(track, started, body);
  return json({ track, started, bytes: written.bytes });
}

/**
 * GET /api/logs/<track> - requires a Bearer token -> `{ track, logs:
 * [{started, bytes, uploaded}] }`, newest first; 404 for a track this person
 * doesn't have, 503 with no bucket bound.
 */
export async function handleListRunLogs({ db, runLogs, params }) {
  const unconfigured = missingBucket(runLogs);
  if (unconfigured) return unconfigured;

  const [track] = params;
  if (!(await db.trackExists(track))) return unknownTrack(track);
  return json({ track, logs: await runLogs.list(track) });
}

/**
 * GET /api/logs/<track>/<started> - requires a Bearer token -> the log, as
 * text/plain; 400 for a malformed start time, 404 for a track this person
 * doesn't have or a run with no log, 503 with no bucket bound.
 *
 * Streams the stored object back as it is rather than through text(), like
 * GET /api/documents/<path>: a log can run to megabytes, and reading it into a
 * string first would buffer the whole thing in the Worker for nothing.
 */
export async function handleGetRunLog({ db, runLogs, params }) {
  const unconfigured = missingBucket(runLogs);
  if (unconfigured) return unconfigured;

  const [track, started] = params;
  if (!STARTED.test(started)) return badStarted(started);
  if (!(await db.trackExists(track))) return unknownTrack(track);

  const obj = await runLogs.get(track, started);
  if (!obj) return json({ error: `no log for the ${track} run that started ${started}` }, 404);
  return new Response(obj.body, {
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

function tooLarge(bytes) {
  return json({ error: `a run log is at most ${MAX_LOG_BYTES} bytes; this one is ${bytes}` }, 413);
}
