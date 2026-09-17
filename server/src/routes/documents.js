/**
 * This person's documents: their resumes, and the per-track baseline doc the
 * nightly search reads first (the prompt's step 1) and edits near the end (step
 * 8b, docUpdateLine in ../prompt.js).
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
import { parseDocumentList } from "../db.js";
import { countWords, docxText, DocxError, MIN_WORDS } from "../docx.js";
import {
  fileName,
  isChoosableResume,
  joinNames,
  listedPathFor,
  resumeParts,
  resumeUsage,
  samePairName,
  searchesReading,
} from "../resumes.js";
import { searchRootOf } from "../tracks.js";
import { badDocumentPath, isDocumentPath, unknownTrack } from "../validate.js";

/**
 * The largest document this API will store. Every object is downloaded in full
 * by every nightly run that uses it (scripts/run-search.ps1) and again by every
 * backup (scripts/backup-tracker.ps1), so its size is paid on every run, not
 * once at upload. 8 MB leaves room for a scanned resume, not for a video.
 */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

// `field: "resume"` marks the refusal of a resume, so the setup form can show it
// beside the file it is about rather than at the top of the form.
const RESUME_FIELD = { field: "resume" };

function tooLarge(bytes, path) {
  return json(
    {
      error:
        `document is ${bytes} bytes; the limit is ${MAX_DOCUMENT_BYTES} ` +
        "(8 MB). Documents are re-downloaded by every nightly run and every backup.",
      ...(path.startsWith("resumes/") ? RESUME_FIELD : {}),
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
 * GET /api/documents[?search=<key>] - requires a Bearer token -> `{ documents:
 * [...] }`, or with `search`, `{ search, documents: [...], missing: [path, ...],
 * profile_stale }`; with `search`, 404 for a track this person doesn't have and
 * 409 for one whose `documents` list is empty.
 *
 * Path, kind, content type, size, etag, upload time and stored word count for
 * each, with no bodies, so the listing stays cheap.
 *
 * Without `search`, everything this person has - what the backup, the import
 * script and the resume section of the page want. Each file under resumes/
 * also says what the page shows about it (docs/account-settings-plan.md#your-resume):
 *
 * - `readable`: whether a search can be pointed at it (../resumes.js
 *   isChoosableResume).
 * - `text_path` on a Word file, the text a search reads for it, and
 *   `paired_with` on that text, the Word file it was read from. The page shows
 *   the pair as the Word file.
 * - `used_by`: `[{search, tabs, state}]`, which searches read it and the tabs
 *   each fills, and whether its profile is caught up (../resumes.js
 *   resumeUsage).
 *
 * With `search`, only what that one search reads: its tracking
 * doc (`doc_file`) and its `documents` list (migrations/0017). The nightly run
 * asks with `search`, so a person with two searches doesn't hand each one the
 * other's tracking doc and resumes. A tab another search fills is served that
 * search's list, since that search is the one that runs.
 *
 * `missing` names a listed path with no document behind it, rather than
 * leaving it out: the runner refuses to search against a partial profile, and
 * a path quietly dropped here would look like a complete one.
 *
 * An empty `documents` list is refused, not served as the tracking doc alone. A
 * search with no resume runs anyway and searches for nothing in particular, and
 * the refusal is the loud version of that.
 *
 * `profile_stale` is `{since, was}` while the search's resume has changed since
 * its candidate profile was written, and null otherwise
 * (migrations/0018_profile_stale.sql). The runner rewrites the profile when it
 * is set, and echoes `since` to POST /api/writeup to clear it.
 */
export async function handleListDocuments({ docs, db, url }) {
  const unconfigured = missingBucket(docs);
  if (unconfigured) return unconfigured;

  const all = (await docs.list()).map((d) => ({
    path: d.path,
    kind: d.kind,
    content_type: d.contentType,
    bytes: d.bytes,
    etag: d.etag,
    uploaded: d.uploaded,
    words: d.words,
  }));

  const search = url.searchParams.get("search");
  if (search === null) {
    const rows = await db.getResumeState();
    const stored = all.map((d) => d.path);
    return json({
      documents: all.map((d) => {
        const parts = resumeParts(d.path);
        if (!parts) return d;
        const pairing =
          parts.ext === "docx"
            ? { text_path: listedPathFor(stored, d.path) }
            : parts.ext === "txt" && samePairName(stored, d.path, "docx").length
              ? { paired_with: samePairName(stored, d.path, "docx")[0] }
              : {};
        return {
          ...d,
          ...pairing,
          readable: isChoosableResume(stored, d.path),
          used_by: resumeUsage(rows, stored, d.path),
        };
      }),
    });
  }

  const track = await db.getTrack(search);
  if (!track) return unknownTrack(search);
  // A fed tab reads the documents of the search that fills it. A root that has
  // gone missing falls back to the tab itself.
  const rootKey = searchRootOf(track);
  const runs = rootKey === track.key ? track : (await db.getTrack(rootKey)) || track;

  const listed = parseDocumentList(runs.documents);
  if (listed.length === 0) {
    return json(
      {
        error: `search "${runs.key}" lists no documents, so a run would have no resume to read - set its documents before running it`,
        field: "documents",
      },
      409
    );
  }

  const wanted = [...new Set([runs.doc_file, ...listed].filter(Boolean))];
  const byPath = new Map(all.map((d) => [d.path, d]));
  return json({
    search: runs.key,
    documents: wanted.filter((p) => byPath.has(p)).map((p) => byPath.get(p)),
    missing: wanted.filter((p) => !byPath.has(p)),
    profile_stale: runs.profile_stale_since ? { since: runs.profile_stale_since, was: runs.resume_was } : null,
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
 * A Word resume (`resumes/<name>.docx`, any case) is read on upload
 * (docs/word-resumes-plan.md): its text is written beside it as
 * `resumes/<name>.txt`, which is what a search reads, and the reply adds
 * `text_path` and `words`. A .docx this can't read, or one with fewer than
 * MIN_WORDS words (a scanned image, a template), is a 422 naming why - with
 * `words` when it was read - and nothing is stored. An older Word file
 * (`resumes/<name>.doc`) is a 415.
 *
 * That text belongs to the Word file: a direct PUT to a resume .txt whose .docx
 * is stored is a 409 with `paired_with`. The pair is matched on the name
 * ignoring case, since a run downloads onto a Windows disk where `resume.txt`
 * and `Resume.txt` are one file.
 *
 * A .txt or .md resume is stored with its word count, as a Word file's text is,
 * so the page lists it without reading the file.
 *
 * Replacing a resume a search reads - different contents under the same name -
 * marks that search's profile stale, as choosing another resume does: the list
 * still names the file, but the profile was written from what it used to say.
 *
 * With `If-Match`, a stale etag writes nothing. A nightly run reads the
 * baseline doc at the start of a long turn and writes its edited copy at the
 * end, so an unconditional write would erase anything saved in between;
 * scripts/run-search.ps1 keeps the run's copy when it gets the 412. Without
 * `If-Match` the write is unconditional, for callers establishing a document
 * rather than revising one they read.
 */
export async function handlePutDocument({ request, docs, db, params }) {
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
  if (declared > MAX_DOCUMENT_BYTES) return tooLarge(declared, path);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return tooLarge(bytes.byteLength, path);

  const resume = resumeParts(path);
  const before = resume ? await docs.list() : [];
  const storedBefore = before.map((d) => d.path);
  if (resume?.ext === "doc") {
    return json({ error: `${resume.name} is an older Word file - Save it as .docx or PDF and attach that`, ...RESUME_FIELD }, 415);
  }
  if (resume?.ext === "txt") {
    const wordFile = samePairName(storedBefore, path, "docx")[0];
    if (wordFile) return textIsServerOwned(wordFile, "replace");
  }

  // A Word resume is read on the way in, so a file with nothing readable in it
  // is refused while the person is still there, and nothing is stored.
  let extracted = null;
  if (resume?.ext === "docx") {
    try {
      extracted = await docxText(bytes);
    } catch (err) {
      if (!(err instanceof DocxError)) throw err;
      return json({ error: `${resume.name} ${err.message}`, ...RESUME_FIELD }, 422);
    }
    if (extracted.words < MIN_WORDS) {
      return json(
        {
          error: `${resume.name} has only ${extracted.words} words of text - if it is a scanned image or a template, attach a PDF or paste the text instead`,
          words: extracted.words,
          ...RESUME_FIELD,
        },
        422
      );
    }
  }
  const words =
    extracted?.words ??
    (resume && ["txt", "md"].includes(resume.ext) ? countWords(new TextDecoder().decode(bytes)) : undefined);

  // The Word file goes first because it is the conditional write: a stale
  // If-Match writes nothing at all. Its text follows, unconditionally, and
  // sending the same file again rewrites both if the second write was lost.
  const written = await docs.put(path, bytes, contentType, ifMatch, words);
  if (!written) {
    return json(
      {
        error: `document "${path}" changed since you read it - your If-Match no longer matches`,
        path,
      },
      412
    );
  }

  const textPath = extracted ? `resumes/${resume.base}.txt` : null;
  if (extracted) {
    await docs.put(textPath, new TextEncoder().encode(extracted.text), "text/plain; charset=utf-8", "", extracted.words);
    // A text file of the same name in another case would be the same file on the
    // Windows disk a run downloads to, and whichever arrived second would win.
    for (const other of samePairName(storedBefore, path, "txt")) {
      if (other !== textPath) await docs.delete(other);
    }
  }

  // R2's etag is a digest of the contents, so the same file sent again is not a
  // change and leaves the profile alone.
  const previous = before.find((d) => d.path === path);
  if (previous && previous.etag !== written.etag) {
    const listed = textPath || path;
    const rows = await db.getResumeState();
    const readers = searchesReading(rows, storedBefore, path).filter((s) => s.list.includes(listed));
    await db.markProfilesStale(readers.map((s) => s.key), listed, new Date().toISOString());
  }

  if (!extracted) return json({ path, etag: written.etag, bytes: written.bytes });
  return json({ path, etag: written.etag, bytes: written.bytes, text_path: textPath, words: extracted.words });
}

/**
 * The refusal for writing or removing a resume's text directly. The text is
 * read from the Word file, so the Word file is the one to change - otherwise a
 * hand-edited text file would silently stand in for what was read, and nothing
 * would show which one a search is using.
 * @param {string} wordFile
 * @param {"replace"|"remove"} action
 */
function textIsServerOwned(wordFile, action) {
  const name = wordFile.slice("resumes/".length);
  return json({ error: `This text is read from ${name} - ${action} that file instead.`, paired_with: wordFile, ...RESUME_FIELD }, 409);
}

/**
 * DELETE /api/documents/<path> - requires a Bearer token -> `{ path, deleted }`,
 * or 404.
 *
 * Removing a Word resume also removes the text read from it, listed in
 * `removed`. Removing that text on its own is a 409 with `paired_with`, as
 * writing it is.
 *
 * A file a search reads - its list names it (for a Word file, its text), or it
 * is the search's tracking doc - is a 409 naming those searches in `searches`,
 * with the page's sentence in `error`: a run would otherwise stop on a missing
 * document, or search with no resume. The search has to be pointed elsewhere
 * first (POST /api/settings). A file a search has only just been switched away
 * from isn't read by the next run, so it can go.
 *
 * R2 deletes a missing key without complaint; the 404 tells a caller its path
 * was wrong instead of reporting a cleanup that did nothing.
 */
export async function handleDeleteDocument({ docs, db, params }) {
  const unconfigured = missingBucket(docs);
  if (unconfigured) return unconfigured;

  const path = params[0];
  if (!isDocumentPath(path)) return badDocumentPath(path);

  const stored = (await docs.list()).map((d) => d.path);
  const resume = resumeParts(path);
  if (resume?.ext === "txt") {
    const wordFile = samePairName(stored, path, "docx")[0];
    if (wordFile) return textIsServerOwned(wordFile, "remove");
  }

  const readers = searchesReading(await db.getResumeState(), stored, path);
  if (readers.length) {
    const names = joinNames(readers.map((s) => s.label || s.key));
    const verb = readers.length === 1 ? "reads" : "read";
    const pronoun = readers.length === 1 ? "that search" : "them";
    const error = resume
      ? `${names} ${verb} this resume, so it can't be removed. Choose another resume for ${pronoun} below first.`
      : `${names} ${verb} ${fileName(path)}, so it can't be removed.`;
    return json({ error, searches: readers.map((s) => s.key), ...(resume ? RESUME_FIELD : {}) }, 409);
  }

  const deleted = await docs.delete(path);
  if (!deleted) return json({ error: `no document at "${path}"` }, 404);

  // Removing a Word resume removes the text read from it: the pair is one
  // resume. The Word file goes first, so a failure between the two leaves a
  // text file with nothing claiming it, which can then be removed directly.
  if (resume?.ext === "docx") {
    const removed = [];
    for (const text of samePairName(stored, path, "txt")) {
      if (await docs.delete(text)) removed.push(text);
    }
    return json({ path, deleted: true, removed });
  }
  return json({ path, deleted: true });
}
