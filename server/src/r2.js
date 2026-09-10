/**
 * The one place that knows this is R2. Every `env.DOCS` call lives here - the
 * route modules never touch the bucket directly, exactly as they never touch
 * `env.DB` (see ./db.js). Same reason: if these ever move to another object
 * store, only this file changes.
 *
 * ---- Every instance belongs to one user, and that is the whole access story.
 * `new Docs(env.DOCS, userId)` binds the store to whoever is making the
 * request, and #key() prefixes every single key with that id. It is not a
 * per-method parameter for the reason db.js gives at length: with a parameter,
 * one call site that forgets one argument reads or overwrites another person's
 * resume, and nothing about the code looks wrong. Prefixed at construction,
 * there is no method left that *can* forget.
 *
 * So `add-api-route`'s "never check ownership" rule holds here too. A handler
 * cannot name a key outside its caller's prefix, so there is nothing for it to
 * check - another user's path simply resolves to an object that isn't there,
 * and the handler's existing "not found" branch is the access check.
 *
 * ---- Why there is no table beside this. An earlier shape of this feature kept
 * a D1 row per object holding its kind, content type, size and etag. Every one
 * of those is already here: `kind` is the first path segment, and list() hands
 * back size, etag, upload time and content type in one call. R2 is strongly
 * consistent - for list() as much as for get() - so a listing is the bucket
 * rather than a cache of it. A table would have been a second copy of facts
 * this store already holds, kept in step by hand and free to drift.
 *
 * ---- The key layout is the schema. An object's key is
 * `<user-id>/<path>`, where `<path>` is the relative path the file occupies in
 * that person's data folder: `docs/tracked_swe_postings.md`,
 * `resumes/Someone_Resume.txt`. That is not incidental. The nightly run's
 * config names those paths verbatim - `tracks.doc_file` and the hand-written
 * `tracks.resume_line` prose - so keeping them as the key means the run's
 * prompt did not have to change and no track's config had to be rewritten,
 * legacy filenames included. See ../../docs/private-storage-plan.md.
 *
 * The shape of `<path>` is enforced in ./validate.js, not here, because it is a
 * request-validation concern: one of three known folders, one plain filename,
 * no nesting. This file assumes it has already been checked.
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
 * An etag as R2 compares it. The header form is quoted (`"abc123"`) and the
 * property form is not, and a caller echoing back what it was given can send
 * either - curl users especially, since the quotes are part of the HTTP
 * spelling rather than part of the value. Normalising on the way in means an
 * `If-Match` never fails for the difference between the two spellings, which
 * would look exactly like a genuine mid-run conflict.
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
   * No paging. `list` caps at 1000 keys per call and a person holds one doc per
   * track plus a handful of resumes - call it fifteen. Saying so here rather
   * than leaving the absent cursor loop looking like an oversight: if that ever
   * stops being true, `result.truncated` is what to notice.
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
   * `ifMatch` is what makes the nightly write-back safe. The run reads a doc at
   * the start of its turn and hands back an edited version many minutes later;
   * without a precondition, anything written in between is silently erased by
   * the run's copy, which was made before it existed. With one, the write fails
   * and the caller still holds its version - see scripts/run-search.ps1, which
   * saves that copy rather than discarding it.
   *
   * Returns null - not a throw - when the precondition fails, because that is
   * an ordinary answer rather than an error: the route turns it into a 412 and
   * the caller decides what to do. R2 signals it by returning null from put().
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
