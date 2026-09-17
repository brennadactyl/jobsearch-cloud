/**
 * Everything that touches a password or a session token.
 *
 * A person has a name and a password (users) and holds zero or more bearer
 * tokens (sessions). Only POST /api/login, /api/users and /api/password see a
 * password; every other request carries a token of 32 random bytes unrelated
 * to it. That lets a scheduled search keep a long-lived credential on disk that
 * isn't the human's password, and makes "log this browser out" a row delete
 * rather than a password change.
 *
 * No dependencies: PBKDF2 and getRandomValues are native to Workers via Web
 * Crypto.
 */

// 100k rather than the ~600k OWASP suggests for PBKDF2-SHA256, deliberately:
// this runs inside a Worker request, where CPU time is both metered and
// capped, and a login is already the slowest thing this API does. The
// `iterations` column is stored per user so this can be raised later without
// invalidating anyone's password.
const PBKDF2_ITERATIONS = 100000;

// Long rather than complex, and the same floor wherever a password is set,
// because /api/login has no rate limiting in front of it - see server/README.md.
// Three other places check the same number before sending and can't import
// this one, so a change goes in all four: MIN_PASSWORD in
// client/src/domain/account.ts, scripts/set-password.ps1 and
// scripts/seed-demo-user.ps1.
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Where a session token lives, stored as its label. Revoking by label is how
 * "sign out other browsers" leaves a machine's search token alone, so every
 * insert and every filter on a label uses these rather than a typed string.
 */
export const SESSION_LABEL = Object.freeze({
  browser: "browser",
  scheduledSearch: "scheduled-search",
});
const DERIVED_BITS = 256;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;

// Used when no account matches the name given at login - see verifyPassword.
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA==";

/** @typedef {{id: string, name: string, password_hash: string, password_salt: string, iterations: number, created_at: string, demo: number}} User */

// base64url (no padding) rather than plain base64: session tokens travel in an
// Authorization header and get pasted into JSON config files by hand, and '+'
// and '/' are exactly the characters that survive that journey least well.
function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Derives the stored form of a password. Pass an existing salt/iterations to
 * re-derive for verification; omit them to mint a new credential.
 * @param {string} password
 * @param {string} [saltB64]
 * @param {number} [iterations]
 * @returns {Promise<{hash: string, salt: string, iterations: number}>}
 */
export async function hashPassword(password, saltB64, iterations = PBKDF2_ITERATIONS) {
  const salt = saltB64 ? fromBase64(saltB64) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    DERIVED_BITS
  );
  return { hash: toBase64(new Uint8Array(bits)), salt: toBase64(salt), iterations };
}

// Compares every byte regardless of where the first mismatch is, so how long
// the comparison takes doesn't leak how much of the hash was guessed right.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @param {string} password
 * @param {User} user
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, user) {
  // An empty stored hash means login is disabled until POST /api/users sets a
  // password. Fail closed rather than treating "no password" as "any password".
  //
  // Derive anyway before returning, so an unknown name isn't measurably faster
  // than a wrong password - the identical error message is there to withhold
  // whether the account exists.
  if (!user || !user.password_hash || !user.password_salt) {
    await hashPassword(password, DUMMY_SALT, PBKDF2_ITERATIONS);
    return false;
  }
  const { hash } = await hashPassword(password, user.password_salt, user.iterations || PBKDF2_ITERATIONS);
  return timingSafeEqual(hash, user.password_hash);
}

/** @returns {string} a new bearer token - 32 random bytes, base64url */
export function newSessionToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/**
 * What actually goes in `sessions.id`. The token itself is never stored: 32
 * random bytes need no salt or stretching to be unguessable, but storing them
 * as-is would mean a `d1 export`, a backup file, or the audit query in the
 * README each hand over working credentials for every signed-in device. A
 * plain SHA-256 costs one hash per request and makes the stored row useless
 * to anyone who reads it.
 * @param {string} token
 * @returns {Promise<string>}
 */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64(new Uint8Array(digest));
}

/**
 * Whether a request carries the deployment's ADMIN_TOKEN. Both sides are hashed
 * before comparing, so the comparison runs over equal-length strings and its
 * timing says nothing about how much of a guess was right. A deployment with no
 * ADMIN_TOKEN configured has no admin, rather than one whose secret is empty.
 * @param {Request} request
 * @param {{ADMIN_TOKEN?: string}} env
 * @returns {Promise<boolean>}
 */
export async function isAdminRequest(request, env) {
  const given = bearer(request);
  if (!env.ADMIN_TOKEN || !given) return false;
  return timingSafeEqual(await hashToken(given), await hashToken(env.ADMIN_TOKEN));
}

export function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * Resolves a bearer token to the person holding it. This is the whole access
 * check for every route outside PUBLIC_ROUTES: a token that doesn't join to a
 * user isn't one.
 *
 * `demo` is included because a route has to refuse a demo account before it
 * writes anything shared (demo account, docs/glossary.md#accounts), and this is the
 * one lookup every request already makes.
 * @param {D1Database} d1
 * @param {string} token
 * @returns {Promise<{id: string, name: string, demo: number, session_id: string}|null>}
 */
export async function getSessionUser(d1, token) {
  if (!token) return null;
  const row = await d1
    .prepare(
      `SELECT u.id AS id, u.name AS name, u.demo AS demo, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .bind(await hashToken(token))
    .first();
  return row || null;
}

/** @param {D1Database} d1 @param {string} name @returns {Promise<User|null>} */
export async function getUserByName(d1, name) {
  const row = await d1.prepare("SELECT * FROM users WHERE name = ?").bind(name).first();
  return row || null;
}

/**
 * Issues a session. `label` is free text describing where the token will live
 * (see SESSION_LABEL), so a credential can later be revoked by
 * what it is rather than by guessing which opaque string is which.
 * @param {D1Database} d1
 * @param {string} userId
 * @param {string} label
 * @returns {Promise<string>} the new token
 */
export async function createSession(d1, userId, label) {
  const token = newSessionToken();
  await d1
    .prepare("INSERT INTO sessions (id, user_id, created_at, label) VALUES (?, ?, ?, ?)")
    .bind(await hashToken(token), userId, new Date().toISOString(), (label || SESSION_LABEL.browser).slice(0, 60))
    .run();
  // The only time the token itself exists anywhere; the row holds its hash.
  return token;
}

/** @param {D1Database} d1 @param {string} token @returns {Promise<boolean>} */
export async function deleteSession(d1, token) {
  const result = await d1.prepare("DELETE FROM sessions WHERE id = ?").bind(await hashToken(token)).run();
  return result.meta.changes > 0;
}

/**
 * Creates a user, or sets an existing one's password. One operation on purpose:
 * the admin route this serves is the only way to reset a password its owner
 * can't supply. An existing account keeps its id, so a reset leaves every row
 * that references the user alone.
 * @param {D1Database} d1
 * @param {string} name
 * @param {string} password
 * @param {boolean} [demo] whether the account's data is invented
 *   (docs/glossary.md#accounts). Omitted, a new account is a person and
 *   an existing one keeps what it was, so a password reset never changes it.
 * @returns {Promise<{id: string, name: string, created: boolean, demo: boolean}>}
 */
export async function upsertUser(d1, name, password, demo) {
  const { hash, salt, iterations } = await hashPassword(password);
  const existing = await getUserByName(d1, name);
  if (existing) {
    const flag = demo === undefined ? (Number(existing.demo) ? 1 : 0) : demo ? 1 : 0;
    await d1
      .prepare("UPDATE users SET password_hash = ?, password_salt = ?, iterations = ?, demo = ? WHERE id = ?")
      .bind(hash, salt, iterations, flag, existing.id)
      .run();
    return { id: existing.id, name: existing.name, created: false, demo: flag === 1 };
  }
  const id = crypto.randomUUID();
  const flag = demo ? 1 : 0;
  await d1
    .prepare(
      `INSERT INTO users (id, name, password_hash, password_salt, iterations, created_at, demo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, name, hash, salt, iterations, new Date().toISOString().slice(0, 10), flag)
    .run();
  return { id, name, created: true, demo: flag === 1 };
}

/**
 * What an account owns in D1, table by table. Every table with a `user_id`
 * appears here, which is what the delete below removes.
 *
 * Not `company_fetch`: the company list is shared by every account
 * (docs/glossary.md#companies-and-the-rotation), so what this person's runs learned
 * about reaching a company stays when they go. Their own record of which
 * companies they swept, in `company_sweeps`, is theirs and goes.
 */
const OWNED_TABLES = [
  "applications",
  "company_sweeps",
  "intake",
  "leads",
  "meta",
  "screened",
  "search_runs",
  "sessions",
  "tracks",
];

/**
 * Everything an account holds, counted before it is removed.
 * @param {D1Database} d1
 * @param {string} id
 * @returns {Promise<Record<string, number>>} one count per table in OWNED_TABLES
 */
export async function countAccountRows(d1, id) {
  const rows = await d1.batch(
    OWNED_TABLES.map((t) => d1.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).bind(id))
  );
  return Object.fromEntries(OWNED_TABLES.map((t, i) => [t, Number(rows[i].results[0].n) || 0]));
}

/**
 * Delete an account and everything in D1 that belongs to it, in one batch,
 * which D1 runs as one transaction: the account and its rows go together or
 * not at all, and a caller never meets an account whose rows are half gone.
 *
 * Documents live in R2 and cannot join this transaction, so the route deletes
 * those first and this runs second (routes/accounts.js). That order is
 * deliberate: a failure between the two leaves an account whose documents are
 * gone, which deleting again finishes, rather than objects in R2 that nothing
 * names any more.
 *
 * An invite that made this account keeps its ledger row, with `used_by`
 * cleared. `used_at` set beside an empty `used_by` is unambiguous - an unused
 * invite has both empty - so the ledger reads "used, and the account it made is
 * gone". The operator's record of who was invited and when outlives the
 * account; nothing identifying the person survives in it.
 *
 * @param {D1Database} d1
 * @param {string} id
 * @returns {Promise<Record<string, number> & {invites: number}>} what was removed
 */
export async function deleteAccount(d1, id) {
  const counts = await countAccountRows(d1, id);
  const invites = await d1
    .prepare("SELECT COUNT(*) AS n FROM invites WHERE used_by = ?")
    .bind(id)
    .first();
  await d1.batch([
    ...OWNED_TABLES.map((t) => d1.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(id)),
    d1.prepare("UPDATE invites SET used_by = '' WHERE used_by = ?").bind(id),
    d1.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  return { ...counts, invites: Number(invites && invites.n) || 0 };
}

/**
 * The full user row, stored credential included, for a caller already known by
 * session.
 * @param {D1Database} d1
 * @param {string} id
 * @returns {Promise<User|null>}
 */
export async function getUserById(d1, id) {
  const row = await d1.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  return row || null;
}

/**
 * Sets the password of an account that already exists, by id. Never use
 * upsertUser here: it creates an account on a name miss.
 *
 * Rewrites only the credential columns, so sessions survive - including the
 * long-lived token a scheduled search holds on disk.
 * @param {D1Database} d1
 * @param {string} userId
 * @param {string} password
 */
export async function setUserPassword(d1, userId, password) {
  const { hash, salt, iterations } = await hashPassword(password);
  await d1
    .prepare("UPDATE users SET password_hash = ?, password_salt = ?, iterations = ? WHERE id = ?")
    .bind(hash, salt, iterations, userId)
    .run();
}

/**
 * Signs this person's *other browsers* out, leaving the caller's own session
 * and every non-browser credential alone.
 *
 * The filter is an allowlist, `label = 'browser'`, never "everything except
 * 'scheduled-search'", because an unrecognised label must survive: a revoked
 * search token fails silently - the nightly run just stops, looking like a
 * search that found nothing - while a session wrongly kept is visible and can
 * be logged out.
 * @param {D1Database} d1
 * @param {string} userId
 * @param {string} keepToken the raw token of the session doing the revoking
 * @returns {Promise<number>} how many were signed out
 */
export async function deleteOtherBrowserSessions(d1, userId, keepToken) {
  const result = await d1
    .prepare("DELETE FROM sessions WHERE user_id = ? AND label = ? AND id != ?")
    .bind(userId, SESSION_LABEL.browser, await hashToken(keepToken))
    .run();
  return result.meta.changes || 0;
}
