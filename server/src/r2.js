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

  /**
   * Remove every document this person has: what deleting their account has to
   * take with it, since once the account is gone nothing else names these keys.
   *
   * Loops rather than deleting one page, because `list` caps at 1000 keys and
   * the account being deleted is the one that might hold more than a person's
   * usual fifteen. Each pass lists what is left and deletes that, so a pass
   * that dies part way leaves the rest for a later call - which is what lets
   * the delete route be repeated rather than resumed.
   *
   * @returns {Promise<number>} how many objects were removed
   */
  async deleteAll() {
    return deleteUnder(this.bucket, `${this.userId}/`);
  }
}

/**
 * Remove every object under a prefix, a page at a time. `list` caps at 1000
 * keys, so each pass lists what is left and deletes that; a pass that dies part
 * way leaves the rest for a later call, which is what lets the account delete
 * be repeated rather than resumed.
 * @param {R2Bucket} bucket
 * @param {string} prefix
 * @returns {Promise<number>} how many objects were removed
 */
async function deleteUnder(bucket, prefix) {
  let removed = 0;
  for (let pass = 0; pass < 20; pass++) {
    const result = await bucket.list({ prefix });
    if (result.objects.length === 0) break;
    await bucket.delete(result.objects.map((obj) => obj.key));
    removed += result.objects.length;
  }
  return removed;
}

/**
 * @typedef {Object} RunLogEntry
 * @property {string} started - when the run began, as the run named it: `2026-09-16T08-00-01Z`
 * @property {number} bytes
 * @property {string} uploaded - ISO 8601 UTC instant
 */

/**
 * One person's nightly run logs: what each search did, kept off the machine
 * that ran it.
 *
 * In the same bucket as documents but outside their prefix, at
 * `logs/<user-id>/<track>/<started>.log`, for two reasons:
 * - Every search downloads every document in its account before it starts
 *   (scripts/run-search.ps1). Logs under `<user-id>/` would join that list, and
 *   each night would pull down every night before it.
 * - One bucket rule on the `logs/` prefix expires them for every account after
 *   30 days, the same window the backups keep (README.md, "Backups"). A rule
 *   can only match from the start of a key, so logs have to start with `logs/`.
 *
 * Bound to one user like Docs, so no method can address another person's log.
 * The track and the name are checked by the route before they reach a key.
 */
export class RunLogs {
  /**
   * @param {R2Bucket} bucket the `DOCS` binding
   * @param {string} userId whose logs this instance can see
   */
  constructor(bucket, userId) {
    this.bucket = bucket;
    this.userId = userId;
  }

  /** @param {string} track */
  #prefix(track) {
    return `logs/${this.userId}/${track}/`;
  }

  /**
   * Write one run's log, replacing any earlier copy under the same name - so a
   * run that retries its upload leaves one log, not two.
   * @param {string} track
   * @param {string} started
   * @param {ArrayBuffer} body
   * @returns {Promise<{bytes: number}>}
   */
  async put(track, started, body) {
    const obj = await this.bucket.put(`${this.#prefix(track)}${started}.log`, body, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    return { bytes: obj.size };
  }

  /**
   * A track's logs, newest first. No paging: `list` returns up to 1000, and a
   * nightly search keeps about 30.
   * @param {string} track
   * @returns {Promise<RunLogEntry[]>}
   */
  async list(track) {
    const prefix = this.#prefix(track);
    const result = await this.bucket.list({ prefix });
    return result.objects
      .map((obj) => ({
        started: obj.key.slice(prefix.length).replace(/\.log$/, ""),
        bytes: obj.size,
        uploaded: obj.uploaded.toISOString(),
      }))
      .sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0));
  }

  /**
   * @param {string} track
   * @param {string} started
   * @returns {Promise<R2ObjectBody|null>}
   */
  async get(track, started) {
    return await this.bucket.get(`${this.#prefix(track)}${started}.log`);
  }

  /** Every log this person has, across tracks: what deleting the account removes. */
  async deleteAll() {
    return deleteUnder(this.bucket, `logs/${this.userId}/`);
  }

  /** @returns {Promise<number>} how many logs this person has, across tracks */
  async count() {
    const result = await this.bucket.list({ prefix: `logs/${this.userId}/` });
    return result.objects.length;
  }
}
