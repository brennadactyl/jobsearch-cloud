/**
 * All R2 access - every `env.DOCS` call lives here.
 *
 * Every instance is bound to one user, and #key() prefixes every key with that
 * id, so no method can address another person's object (the scoping rationale
 * is in ./db.js).
 *
 * An object's key is `<user-id>/<path>`, where `<path>` is the relative path
 * the file occupies in that person's data folder: `docs/tracked_swe_postings.md`,
 * `resumes/Someone_Resume.txt`. `tracks.doc_file` and the hand-written
 * `tracks.resume_line` prose name these paths verbatim, so don't change the
 * layout without rewriting them.
 *
 * No D1 table beside this: `kind` is the first path segment, and R2's strongly
 * consistent list() already returns size, etag, upload time and content type.
 *
 * `<path>` is validated in ./validate.js; this file assumes it has been checked.
 */

/**
 * @typedef {Object} DocumentEntry
 * @property {string} path - relative path, e.g. `docs/tracked_swe_postings.md`
 * @property {string} kind - 'docs' | 'resumes' | 'reference'; the first path segment
 * @property {string} contentType - as stored on upload, '' if none was given
 * @property {number} bytes
 * @property {string} etag - unquoted; what a conditional write matches on
 * @property {string} uploaded - ISO 8601 UTC instant
 */

/**
 * An etag as R2 compares it. A caller may echo back the quoted header form
 * (`"abc123"`) or the bare property form, and an `If-Match` must not fail on
 * that spelling difference - it would look exactly like a real conflict.
 *
 * @param {string} value
 * @returns {string}
 */
function bareEtag(value) {
  return String(value || "").replace(/^W\//, "").replace(/^"|"$/g, "");
}

export class Docs {
  /**
   * @param {R2Bucket} bucket the `DOCS` binding
   * @param {string} userId whose documents this instance can see
   */
  constructor(bucket, userId) {
    this.bucket = bucket;
    this.userId = userId;
  }

  /** @param {string} path @returns {string} */
  #key(path) {
    return `${this.userId}/${path}`;
  }

  /**
   * Every document this person has.
   *
   * No paging: `list` caps at 1000 keys per call, and a person holds about
   * fifteen documents.
   *
   * @returns {Promise<DocumentEntry[]>}
   */
  async list() {
    const prefix = `${this.userId}/`;
    const result = await this.bucket.list({ prefix, include: ["httpMetadata"] });
    return result.objects.map((obj) => {
      const path = obj.key.slice(prefix.length);
      return {
        path,
        kind: path.split("/")[0],
        contentType: (obj.httpMetadata && obj.httpMetadata.contentType) || "",
        bytes: obj.size,
        etag: obj.etag,
        uploaded: obj.uploaded.toISOString(),
      };
    });
  }

  /**
   * One document's bytes, or null if this person has no such path.
   *
   * @param {string} path
   * @returns {Promise<R2ObjectBody|null>}
   */
  async get(path) {
    return await this.bucket.get(this.#key(path));
  }

  /**
   * Write a document, replacing whatever was at that path.
   *
   * `ifMatch` makes the nightly write-back safe: the run hands back a copy it
   * read many minutes earlier, and without a precondition anything written in
   * between is silently erased. With one, the write fails and the caller keeps
   * its version (scripts/run-search.ps1 saves it for a person to merge).
   *
   * A failed precondition returns null rather than throwing - it is an ordinary
   * answer, which the route turns into a 412. R2 signals it the same way.
   *
   * @param {string} path
   * @param {ReadableStream|ArrayBuffer|string} body
   * @param {string} contentType
   * @param {string} [ifMatch] unquoted or quoted etag; unconditional if absent
   * @returns {Promise<{etag: string, bytes: number}|null>}
   */
  async put(path, body, contentType, ifMatch) {
    /** @type {R2PutOptions} */
    const options = { httpMetadata: { contentType } };
    if (ifMatch) options.onlyIf = { etagMatches: bareEtag(ifMatch) };

    const obj = await this.bucket.put(this.#key(path), body, options);
    if (!obj) return null;
    return { etag: obj.etag, bytes: obj.size };
  }

  /**
   * Remove a document.
   *
   * R2's delete succeeds whether or not the key was there, so this reports
   * which it was - the route answers 404 for a path this person never had,
   * rather than 200 for a deletion that deleted nothing.
   *
   * @param {string} path
   * @returns {Promise<boolean>} whether an object was actually removed
   */
  async delete(path) {
    const key = this.#key(path);
    const existing = await this.bucket.head(key);
    if (!existing) return false;
    await this.bucket.delete(key);
    return true;
  }
}
