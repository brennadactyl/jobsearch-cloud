/**
 * Invites and setup intake: the data behind invite signup and first-run setup
 * (docs/onboarding.md).
 *
 * Not methods on Db, which is bound to one user and can only see that user's
 * rows. An invite belongs to no one until it is used, signup runs before there
 * is a user, and the onboarding run reads every account's waiting setup - so
 * these take the D1 binding directly, as ./auth.js does for accounts and
 * sessions. A person's own read and write of their setup go through Db
 * (getIntake, createIntakeWithConfig).
 */

import { getUserById, getUserByName, hashPassword, hashToken, newSessionToken, SESSION_LABEL } from "./auth.js";
import { DAY_MS } from "./validate.js";

export const INVITE_DAYS_DEFAULT = 14;
export const INVITE_DAYS_MAX = 30;
// How many nights a failed setup is retried before the run gives up and the
// note tells the person to ask whoever invited them.
export const RETRY_NIGHTS = 3;
const RETRY_WINDOW_MS = RETRY_NIGHTS * DAY_MS;

/**
 * The oldest `sent_at` a failed setup can have and still be retried at `now`:
 * pendingIntakes hands the run a failed setup only while its `sent_at` is after
 * this, strictly.
 * @param {number} now - milliseconds since the epoch
 */
export function retryCutoff(now) {
  return new Date(now - RETRY_WINDOW_MS).toISOString();
}

/**
 * The first instant a setup sent at `sentAt` is no longer retried, which the
 * page shows so it stops promising another night. It is retryCutoff's rule
 * turned around - `sentAt > retryCutoff(now)` holds exactly while
 * `now < retriesEndAt(sentAt)` - so the two must change together. "" when there
 * is no readable `sentAt`.
 * @param {string} sentAt
 */
export function retriesEndAt(sentAt) {
  const sent = Date.parse(sentAt || "");
  return Number.isNaN(sent) ? "" : new Date(sent + RETRY_WINDOW_MS).toISOString();
}

/**
 * @typedef {{id: number, code_hash: string, note: string, created_at: string,
 *   expires_at: string, used_at: string, used_by: string, revoked_at: string}} Invite
 */

/**
 * What became of an invite. Used outranks everything, because an account exists
 * and that is the fact that matters; revoked outranks expired, because it says
 * someone chose to end it.
 * @param {Invite} invite
 * @param {string} now ISO 8601 instant
 * @returns {"open"|"used"|"revoked"|"expired"}
 */
export function inviteState(invite, now) {
  if (invite.used_at) return "used";
  if (invite.revoked_at) return "revoked";
  if (invite.expires_at <= now) return "expired";
  return "open";
}

/**
 * Mint an invite. The code exists only in what this returns - the table holds its
 * hash - so a lost code is revoked and replaced, never recovered.
 * @param {D1Database} d1
 * @param {string} note
 * @param {number} days
 */
export async function mintInvite(d1, note, days) {
  const code = newSessionToken();
  const now = new Date();
  const created_at = now.toISOString();
  const expires_at = new Date(now.getTime() + days * DAY_MS).toISOString();
  const row = await d1
    .prepare("INSERT INTO invites (code_hash, note, created_at, expires_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(await hashToken(code), note, created_at, expires_at)
    .first();
  return { id: row.id, code, note, created_at, expires_at };
}

/**
 * The invite a code names, or null. A code is only ever looked up by its hash, so
 * nothing stored is compared against a guess.
 * @param {D1Database} d1
 * @param {string} code
 * @returns {Promise<Invite|null>}
 */
export async function findInvite(d1, code) {
  if (typeof code !== "string" || !code || code.length > 200) return null;
  const row = await d1.prepare("SELECT * FROM invites WHERE code_hash = ?").bind(await hashToken(code)).first();
  return row || null;
}

/**
 * Every invite, newest first, with the account each one created. Never a code:
 * none is stored.
 * @param {D1Database} d1
 */
export async function listInvites(d1) {
  const rows = await d1
    .prepare(
      `SELECT i.id, i.note, i.created_at, i.expires_at, i.used_at, i.used_by, i.revoked_at, u.name AS used_by_name
         FROM invites i LEFT JOIN users u ON u.id = i.used_by
        ORDER BY i.created_at DESC, i.id DESC`
    )
    .all();
  const now = new Date().toISOString();
  return rows.results.map((r) => ({
    id: r.id,
    note: r.note,
    created_at: r.created_at,
    expires_at: r.expires_at,
    used_at: r.used_at,
    revoked_at: r.revoked_at,
    user: r.used_by ? { id: r.used_by, name: r.used_by_name || "" } : null,
    state: inviteState(r, now),
  }));
}

/**
 * Withdraw an unused invite. An invite already revoked, or expired, is simply
 * revoked (again), so an operator can repeat the call; a used one cannot be,
 * since revoking would not undo the account.
 * @param {D1Database} d1
 * @param {number} id
 * @returns {Promise<"revoked"|"used"|"missing">}
 */
export async function revokeInvite(d1, id) {
  await d1
    .prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at = '' AND revoked_at = ''")
    .bind(new Date().toISOString(), id)
    .run();
  const row = await d1.prepare("SELECT used_at FROM invites WHERE id = ?").bind(id).first();
  if (!row) return "missing";
  return row.used_at ? "used" : "revoked";
}

/**
 * Create an account from an open invite: claim the invite and insert the account
 * in one batch, which D1 runs as one transaction.
 *
 * The claim is conditional on the invite still being open, and the insert is
 * conditional on the claim having named this new account. So a crash lands
 * neither half; of two people racing one link the second claims nothing and so
 * creates nothing; and a name already taken fails users' UNIQUE constraint,
 * which rolls the claim back with it, leaving the link usable with another
 * name. Signup only ever inserts: an existing account is never touched, which is
 * what keeps an invite from becoming a password reset for someone else's name.
 *
 * @param {D1Database} d1
 * @param {Invite} invite already checked open by the caller
 * @param {string} name trimmed
 * @param {string} password
 * @returns {Promise<{user: {id: string, name: string}} | {reason: string} | {taken: true}>}
 */
export async function signupWithInvite(d1, invite, name, password) {
  // Cheap refusal first, before the password is stretched. The constraint below
  // is what actually decides, since a name can be taken between the two.
  if (await getUserByName(d1, name)) return { taken: true };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const { hash, salt, iterations } = await hashPassword(password);
  let results;
  try {
    results = await d1.batch([
      d1
        .prepare(
          `UPDATE invites SET used_at = ?, used_by = ?
            WHERE id = ? AND used_at = '' AND revoked_at = '' AND expires_at > ?`
        )
        .bind(now, id, invite.id, now),
      d1
        .prepare(
          `INSERT INTO users (id, name, password_hash, password_salt, iterations, created_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM invites WHERE id = ? AND used_by = ?)`
        )
        .bind(id, name, hash, salt, iterations, now.slice(0, 10), invite.id, id),
    ]);
  } catch (err) {
    if (/UNIQUE constraint failed: users\.name/i.test(String(err && err.message))) return { taken: true };
    throw err;
  }
  if (!results[1].meta.changes) {
    // The invite was used, revoked or ran out between the caller's check and the batch.
    const again = await d1.prepare("SELECT * FROM invites WHERE id = ?").bind(invite.id).first();
    const state = again ? inviteState(again, now) : "invalid";
    return { reason: state === "open" ? "invalid" : state };
  }
  return { user: { id, name } };
}

/**
 * A long-lived search token for an account: a session labelled
 * scheduled-search, the credential a nightly run holds.
 *
 * Minting deletes the account's other scheduled-search sessions in the same
 * batch, so an account has exactly one search token, and a run that retries the
 * next night replaces the last token rather than adding to a pile. Browser
 * sessions are left alone. The old token is dead when this returns, so a caller
 * stores the new one before doing anything else that can fail.
 *
 * @param {D1Database} d1
 * @param {string} userId
 * @returns {Promise<{token: string, user: {id: string, name: string}, replaced: number} | {missing: true} | {demo: true}>}
 */
export async function mintSearchToken(d1, userId) {
  const user = typeof userId === "string" && userId ? await getUserById(d1, userId) : null;
  if (!user) return { missing: true };
  if (Number(user.demo)) return { demo: true };
  const token = newSessionToken();
  const [removed] = await d1.batch([
    d1.prepare("DELETE FROM sessions WHERE user_id = ? AND label = ?").bind(user.id, SESSION_LABEL.scheduledSearch),
    d1
      .prepare("INSERT INTO sessions (id, user_id, created_at, label) VALUES (?, ?, ?, ?)")
      .bind(await hashToken(token), user.id, new Date().toISOString(), SESSION_LABEL.scheduledSearch),
  ]);
  return { token, user: { id: user.id, name: user.name }, replaced: removed.meta.changes || 0 };
}

/** @param {string} text */
function parseAnswers(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Every setup a run has not finished - pending, or failed and not yet resent -
 * oldest attempt first, with the answers as the person sent them.
 * @param {D1Database} d1
 */
export async function pendingIntakes(d1) {
  // A failed setup is retried on the following nights with the same answers,
  // and gives up after three (docs/onboarding.md#retries). The bound is here,
  // in what the run is handed, rather than in the run's own memory: a run that
  // forgot, or a second machine, would otherwise retry a setup that has already
  // been abandoned, and the person would keep being told tonight is the night.
  //
  // Counted from `sent_at`, the instant the current attempt began, because
  // nothing stores an attempt count - an `attempts` column is the better shape
  // and is its own change. Until then a night the machine was off spends one of
  // the three.
  const giveUpBefore = retryCutoff(Date.now());
  const rows = await d1
    .prepare(
      `SELECT i.user_id, u.name, i.status, i.status_note, i.sent_at, i.updated_at, i.answers
         FROM intake i JOIN users u ON u.id = i.user_id
        WHERE i.status = 'pending'
           OR (i.status = 'failed' AND i.sent_at > ?)
        ORDER BY i.sent_at, i.user_id`
    )
    .bind(giveUpBefore)
    .all();
  return rows.results.map((r) => ({
    user: { id: r.user_id, name: r.name },
    status: r.status,
    status_note: r.status_note,
    sent_at: r.sent_at,
    updated_at: r.updated_at,
    answers: parseAnswers(r.answers),
  }));
}

/**
 * Record how the onboarding run went. Done is final: a late or repeated call
 * cannot reopen a setup whose search already exists.
 * @param {D1Database} d1
 * @param {string} userId
 * @param {"done"|"failed"} status
 * @param {string} note shown to the person as written
 * @returns {Promise<{user: {id: string, name: string}, status: string, status_note: string, updated_at: string} | {missing: true} | {done: true}>}
 */
export async function completeIntake(d1, userId, status, note) {
  const result = await d1
    .prepare("UPDATE intake SET status = ?, status_note = ?, updated_at = ? WHERE user_id = ? AND status <> 'done'")
    .bind(status, note, new Date().toISOString(), userId)
    .run();
  const row = await d1
    .prepare(
      `SELECT i.user_id, u.name, i.status, i.status_note, i.updated_at
         FROM intake i LEFT JOIN users u ON u.id = i.user_id WHERE i.user_id = ?`
    )
    .bind(userId)
    .first();
  if (!row) return { missing: true };
  if (!result.meta.changes) return { done: true };
  return { user: { id: row.user_id, name: row.name || "" }, status: row.status, status_note: row.status_note, updated_at: row.updated_at };
}
