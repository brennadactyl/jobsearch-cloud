/**
 * Who is calling: exchanging a password for a token, giving one back, saying
 * who a token belongs to, and provisioning the people who hold them.
 *
 * ---- Auth. A person has a name and a password; they hold bearer tokens
 * (sessions). Passwords are seen by exactly three handlers in this whole
 * codebase, and all three are here - login, admin provisioning, and a person
 * changing their own - every other route resolves a token to a user
 * before its module is reached; see ../auth.js for the crypto and ../index.js
 * for the resolution.
 *
 * These are also the only routes that take a raw `d1` rather than a scoped
 * `Db`: login has no session yet to have scoped one from, and user
 * provisioning names its subject in the body rather than being the caller.
 */

import {
  bearer,
  createSession,
  deleteOtherBrowserSessions,
  deleteSession,
  getUserById,
  getUserByName,
  setUserPassword,
  upsertUser,
  verifyPassword,
} from "../auth.js";
import { json, readJson, unauthorized } from "../http.js";

/**
 * POST /api/login - public. Body `{ name, password, label? }` ->
 * `{ token, user }`; 400 for a missing field, 401 for a wrong name or password.
 *
 * The only place a name identifies anyone; every other route goes by token.
 * One message for an unknown name and a wrong password, so this can't be used
 * to find out who has an account. `label` says what the token is for
 * ('browser', or 'scheduled-search' for a headless run's long-lived one), so it
 * can be revoked by purpose later.
 */
export async function handleLogin({ request, env }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name || !password) return json({ error: "name and password are required" }, 400);

  const user = await getUserByName(env.DB, name);
  if (!(await verifyPassword(password, user))) {
    return json({ error: "that name and password don't match" }, 401);
  }

  const token = await createSession(env.DB, user.id, typeof body.label === "string" ? body.label : "browser");
  return json({ token, user: { id: user.id, name: user.name } });
}

/**
 * POST /api/logout - requires a Bearer token -> `{ ok }`.
 *
 * Revokes only the token that made the request, so signing out of a browser
 * leaves the scheduled search's credential alone. A second logout 401s at
 * routing, since the token no longer resolves.
 */
export async function handleLogout({ env, token }) {
  await deleteSession(env.DB, token);
  return json({ ok: true });
}

/**
 * POST /api/users - requires the ADMIN_TOKEN secret as Bearer. Body
 * `{ name, password, demo? }` -> `{ id, name, created, demo }`, 201 when
 * created and 200 when an existing account's password was set; 400 for a
 * missing name or a password under 12 characters, 401 without the admin token.
 *
 * Gated by the ADMIN_TOKEN rather than a session: there is no self-signup, and
 * whoever operates the deployment provisions people. It is also the reset for
 * a forgotten password, which /api/password can't do without the current one.
 */
export async function handleUpsertUser({ request, env }) {
  const admin = env.ADMIN_TOKEN;
  if (!admin || bearer(request) !== admin) return unauthorized();

  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name) return json({ error: "name is required" }, 400);
  // Long rather than complex, and enforced here because /api/login has no rate
  // limiting in front of it - see server/README.md.
  if (password.length < 12) return json({ error: "password must be at least 12 characters" }, 400);

  // `demo` marks an account whose data is invented, which keeps it off the
  // company list every account shares (migrations/0012_demo_account.sql).
  // Anything but a boolean means "not saying", and leaves an existing account
  // as it was.
  const demo = typeof body.demo === "boolean" ? body.demo : undefined;
  const result = await upsertUser(env.DB, name, password, demo);
  return json(result, result.created ? 201 : 200);
}

/** GET /api/me - requires a Bearer token -> `{ id, name }`. */
export function handleGetMe({ user }) {
  return json({ id: user.id, name: user.name });
}

/**
 * POST /api/password - requires a Bearer token. Body
 * `{ currentPassword, newPassword, signOutOthers? }` -> `{ ok, signedOut }`;
 * 400 for a missing field or a new password under 12 characters or equal to
 * the current one, 403 for a wrong current password.
 *
 * The current password is required as well as the session, so a copied token
 * can't take over the account. The 400s and the 403 are told apart, unlike
 * /api/login's refusal: the caller is already authenticated as this person.
 *
 * Sessions survive by default, because revoking the scheduled search's token
 * would silently stop its runs. `signOutOthers: true` revokes only the caller's
 * other 'browser' sessions (deleteOtherBrowserSessions). The reasoning at
 * length: server/README.md, "Changing your own password".
 */
export async function handleChangePassword({ request, env, user, token }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return json({ error: "currentPassword and newPassword are both required" }, 400);
  }
  // The same minimum as /api/users, for the same reason: /api/login has no
  // rate limiting, so length is the defence. Checked before the current
  // password is verified so the two refusals can't be read as one another.
  if (newPassword.length < 12) {
    return json({ error: "your new password must be at least 12 characters" }, 400);
  }
  if (newPassword === currentPassword) {
    // Almost always a mis-fill rather than an intention. Succeeding silently
    // would leave them believing they had changed something.
    return json({ error: "that's the password you already have" }, 400);
  }

  // By the session's id, not by name, so the lookup can't miss if a name
  // changes.
  const stored = await getUserById(env.DB, user.id);
  if (!(await verifyPassword(currentPassword, stored))) {
    return json({ error: "that isn't your current password" }, 403);
  }

  await setUserPassword(env.DB, user.id, newPassword);

  const signedOut = body.signOutOthers === true
    ? await deleteOtherBrowserSessions(env.DB, user.id, token)
    : 0;

  return json({ ok: true, signedOut });
}
