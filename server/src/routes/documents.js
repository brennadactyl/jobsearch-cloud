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
 * GET /api/documents - requires a Bearer token -> `{ documents: [...] }`.
 *
 * The index: path, kind, content type, size, etag and upload time for each,
 * with no bodies. The nightly runner fetches this first and then pulls each
 * path it needs, which is also why the bodies aren't inlined - the docs alone
 * are ~380KB across the accounts on one machine, and a listing that carried
 * them would make "what do I have?" the most expensive call in the API.
 */
export async function handleListDocuments({ docs }) {
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
  const path = params[0];
  if (!isDocumentPath(path)) return badDocumentPath(path);

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const ifMatch = request.headers.get("if-match") || "";

  const written = await docs.put(path, request.body, contentType, ifMatch);
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
  const path = params[0];
  if (!isDocumentPath(path)) return badDocumentPath(path);

  const deleted = await docs.delete(path);
  if (!deleted) return json({ error: `no document at "${path}"` }, 404);

  return json({ path, deleted: true });
}
