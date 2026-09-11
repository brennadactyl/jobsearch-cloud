/**
 * This person's documents: their resumes, and the per-track baseline doc the
 * nightly search reads at step 1 and edits at step 8b.
 *
 * Two conventions bend here, and only here. A document body is raw bytes in
 * both directions, so these handlers skip readJson() on the way in and
 * json()/text() on the way out; every error still goes through json(), so it
 * carries CORS headers and the usual error shape.
 *
 * The path capture in ./index.js is `(.+)` rather than `[^/]+`, because a
 * document path contains a slash (`docs/x.md`) - the path tracks.doc_file and
 * tracks.resume_line name. ../validate.js's isDocumentPath limits it to one
 * known folder and one plain filename.
 *
 * Every handler answers 503 when the DOCS bucket isn't bound (missingBucket)
 * and 400 for a path isDocumentPath refuses.
 */

import { json, CORS_HEADERS } from "../http.js";
import { badDocumentPath, isDocumentPath } from "../validate.js";

/**
 * The largest document this API will store. Every object is downloaded in full
 * by every nightly run that uses it (scripts/run-search.ps1) and again by every
 * backup (scripts/backup-tracker.ps1), so its size is paid on every run, not
 * once at upload. 8 MB leaves room for a scanned resume, not for a video.
 */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

function tooLarge(bytes) {
  return json(
    {
      error:
        `document is ${bytes} bytes; the limit is ${MAX_DOCUMENT_BYTES} ` +
        "(8 MB). Documents are re-downloaded by every nightly run and every backup.",
    },
    413
  );
}

/**
 * The refusal for a deployment with no `DOCS` bucket bound (wrangler.toml's
 * [[r2_buckets]] block). Without it the first call reads `.list` off undefined,
 * and the uncaught TypeError becomes a 500 with no CORS headers, which a
 * browser sees as an opaque network failure. 503 because the request is fine
 * and the fix is a config change, not a retry.
 *
 * @param {import("../r2.js").Docs|null} docs
 * @returns {Response|null} the refusal, or null when the bucket is there
 */
function missingBucket(docs) {
  if (docs && docs.bucket) return null;
  return json(
    {
      error:
        "documents are not configured on this deployment - the DOCS R2 bucket " +
        "is not bound (see server/wrangler.toml)",
    },
    503
  );
}

/**
 * GET /api/documents - requires a Bearer token -> `{ documents: [...] }`.
 *
 * Path, kind, content type, size, etag and upload time for each, with no
 * bodies, so the listing stays cheap: the nightly runner fetches this first and
 * then only the paths it needs.
 */
export async function handleListDocuments({ docs }) {
  const unconfigured = missingBucket(docs);
  if (unconfigured) return unconfigured;

  return json({
    documents: (await docs.list()).map((d) => ({
      path: d.path,
      kind: d.kind,
      content_type: d.contentType,
      bytes: d.bytes,
      etag: d.etag,
      uploaded: d.uploaded,
    })),
  });
}

/**
 * GET /api/documents/<path> - requires a Bearer token -> the object's bytes,
 * or 404.
 *
 * Served with its stored content type and its etag, which a caller hands back
 * as `If-Match` on the PUT.
 */
export async function handleGetDocument({ docs, params }) {
  const unconfigured = missingBucket(docs);
  if (unconfigured) return unconfigured;

  const path = params[0];
  if (!isDocumentPath(path)) return badDocumentPath(path);

  const obj = await docs.get(path);
  // `Docs` only addresses keys under this caller's own prefix, so another
  // person's path is simply not there.
  if (!obj) return json({ error: `no document at "${path}"` }, 404);

  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      etag: obj.httpEtag,
      ...CORS_HEADERS,
    },
  });
}

/**
 * PUT /api/documents/<path> - requires a Bearer token. Raw body, optional
 * `If-Match` -> `{ path, etag, bytes }`; 412 for a stale `If-Match`, 413 over
 * MAX_DOCUMENT_BYTES.
 *
 * With `If-Match`, a stale etag writes nothing. A nightly run reads the
 * baseline doc at the start of a long turn and writes its edited copy at the
 * end, so an unconditional write would erase anything saved in between;
 * scripts/run-search.ps1 keeps the run's copy when it gets the 412. Without
 * `If-Match` the write is unconditional, for callers establishing a document
 * rather than revising one they read.
 */
export async function handlePutDocument({ request, docs, params }) {
  const unconfigured = missingBucket(docs);
  if (unconfigured) return unconfigured;

  const path = params[0];
  if (!isDocumentPath(path)) return badDocumentPath(path);

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const ifMatch = request.headers.get("if-match") || "";

  // The declared length refuses an oversized upload before reading it; the
  // buffered length catches a chunked or understated one. Buffering before the
  // put is what keeps an oversized object from ever being written.
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_DOCUMENT_BYTES) return tooLarge(declared);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return tooLarge(bytes.byteLength);

  const written = await docs.put(path, bytes, contentType, ifMatch);
  if (!written) {
    return json(
      {
        error: `document "${path}" changed since you read it - your If-Match no longer matches`,
        path,
      },
      412
    );
  }

  return json({ path, etag: written.etag, bytes: written.bytes });
}

/**
 * DELETE /api/documents/<path> - requires a Bearer token -> `{ path, deleted }`,
 * or 404.
 *
 * R2 deletes a missing key without complaint; the 404 tells a caller its path
 * was wrong instead of reporting a cleanup that did nothing.
 */
export async function handleDeleteDocument({ docs, params }) {
  const unconfigured = missingBucket(docs);
  if (unconfigured) return unconfigured;

  const path = params[0];
  if (!isDocumentPath(path)) return badDocumentPath(path);

  const deleted = await docs.delete(path);
  if (!deleted) return json({ error: `no document at "${path}"` }, 404);

  return json({ path, deleted: true });
}
