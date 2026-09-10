/**
 * This person's documents: their resumes, and the per-track baseline doc the
 * nightly search reads at step 1 and edits at step 8b.
 *
 * Until these moved here they lived only in a gitignored folder on whichever
 * Windows machine ran the searches - copied between machines by hand, covered
 * by no backup, and read by the run straight off disk. The baseline doc is the
 * one artifact a run *writes*, which is what tied the run to that one PC. See
 * ../../../docs/private-storage-plan.md.
 *
 * ---- Two conventions bend here, both on purpose and only here.
 *
 * A document body is not JSON. Upload is the raw request body and download
 * streams the object back, so these are the only handlers in the worker that
 * don't call readJson() on the way in or json()/text() on the way out. Wrapping
 * a .docx in base64 inside a JSON envelope would buy consistency and cost a
 * third of the payload plus an encode and decode at both ends, for a body that
 * is already exactly what both sides want. Every *error* still goes through
 * json(), so CORS headers and the error shape are unchanged.
 *
 * And the path capture is `(.+)`, not the `[^/]+` every other RegExp route in
 * ./index.js uses. A document path contains a slash - `docs/x.md` - because it
 * is the relative path the file occupies in the person's folder, which is what
 * lets tracks.doc_file and tracks.resume_line go on naming the paths they
 * always named. ./validate.js's isDocumentPath is what keeps that from meaning
 * "any depth": one known folder, one plain filename.
 */

import { json, CORS_HEADERS } from "../http.js";
import { badDocumentPath, isDocumentPath } from "../validate.js";

/**
 * The largest document this API will store.
 *
 * R2 would take five terabytes and never complain, which is the problem: every
 * object here is downloaded in full by *every* nightly run that materializes it
 * (scripts/run-search.ps1) and again by every backup (scripts/backup-tracker.ps1).
 * An unbounded upload is not primarily a storage bill, it is a cost paid twice a
 * day forever on a machine nobody is watching.
 *
 * 8 MB against a real corpus whose largest member is a 250 KB PDF - thirty
 * times the biggest thing anyone has actually stored, which leaves room for a
 * scanned resume without leaving room for a video.
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
 * The refusal for a deployment that has this code but no `DOCS` bucket.
 *
 * Reachable exactly one way: a worker deployed from a wrangler.toml without the
 * [[r2_buckets]] block, or against an account where R2 was never enabled. Every
 * other route keeps working in that state - `Docs` is constructed per request
 * but touches the binding only when a method is called - so the failure is
 * narrow, and it is worth failing narrowly on purpose.
 *
 * Without this the first call reads `.list` off undefined and the worker's
 * uncaught TypeError becomes a 500 carrying a raw stack trace: no JSON error
 * shape, and no CORS headers, which reaches a browser as an opaque network
 * failure with no status to read (the case ../http.js exists to prevent). 503
 * rather than 500 because nothing is wrong with the request - the deployment is
 * incomplete, and the fix is a config change rather than a retry.
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
 * The index: path, kind, content type, size, etag and upload time for each,
 * with no bodies. The nightly runner fetches this first and then pulls each
 * path it needs, which is also why the bodies aren't inlined - the docs alone
 * are ~380KB across the accounts on one machine, and a listing that carried
 * them would make "what do I have?" the most expensive call in the API.
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
 * GET /api/documents/<path> - requires a Bearer token -> the object's bytes.
 *
 * Served with the content type it was stored with and its etag, so a caller can
 * hand that etag straight back as `If-Match` on the way in. That round trip is
 * the whole concurrency story for the baseline doc.
 */
export async function handleGetDocument({ docs, params }) {
  const unconfigured = missingBucket(docs);
  if (unconfigured) return unconfigured;

  const path = params[0];
  if (!isDocumentPath(path)) return badDocumentPath(path);

  const obj = await docs.get(path);
  // Another person's path lands here too, and says the same thing: `Docs` can
  // only address keys under this caller's own prefix, so "not theirs" and "not
  // there" are the same answer, arrived at without a check.
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
 * `If-Match`. -> `{ path, etag, bytes }`.
 *
 * PUT rather than POST: the caller names the URI and writing the same bytes
 * twice is the same as writing them once, which is what makes the import script
 * re-runnable.
 *
 * With `If-Match`, a stale etag is 412 and nothing is written. That matters
 * because of how long a nightly run holds a document: it reads the baseline doc
 * at the start of a turn that lasts many minutes and hands back an edited copy
 * at the end. Anything written in between would be silently erased by a copy
 * made before it existed. The 412 leaves the run holding its version, and
 * scripts/run-search.ps1 saves it rather than dropping it.
 *
 * Without `If-Match` the write is unconditional, which is what the import
 * script and the setup skill want - they are establishing a document, not
 * revising one they read.
 */
export async function handlePutDocument({ request, docs, params }) {
  const unconfigured = missingBucket(docs);
  if (unconfigured) return unconfigured;

  const path = params[0];
  if (!isDocumentPath(path)) return badDocumentPath(path);

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const ifMatch = request.headers.get("if-match") || "";

  // Two size checks, and both earn their place. The header is a claim, so it is
  // refused before anything is read - that is what stops a huge upload being
  // pulled across the wire at all. The buffered length is the fact, and it is
  // what a caller sending chunked (no content-length) or simply lying is
  // measured against.
  //
  // Buffering rather than streaming to R2: at 8 MB it is comfortably inside a
  // Worker's memory, and it is the only way to know the real size before the
  // object exists rather than after. A streamed put would have to delete what
  // it had already written, which is a worse thing to get wrong.
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
 * DELETE /api/documents/<path> - requires a Bearer token -> `{ path, deleted }`.
 *
 * 404s a path this person doesn't have. R2's delete is happy to remove a key
 * that was never there, and reporting success for that would tell a caller its
 * cleanup worked when it may have been aiming at a path it had already got
 * wrong.
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
