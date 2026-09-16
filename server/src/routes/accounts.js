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
  countAccountRows,
  createSession,
  deleteAccount,
  deleteOtherBrowserSessions,
  deleteSession,
  getUserById,
  getUserByName,
  PASSWORD_MIN_LENGTH,
  SESSION_LABEL,
  setUserPassword,
  upsertUser,
  verifyPassword,
} from "../auth.js";
import { json, readJson } from "../http.js";
import { Docs, RunLogs } from "../r2.js";

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

  const token = await createSession(env.DB, user.id, typeof body.label === "string" ? body.label : SESSION_LABEL.browser);
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
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name) return json({ error: "name is required" }, 400);
  if (password.length < PASSWORD_MIN_LENGTH) {
    return json({ error: `password must be at least ${PASSWORD_MIN_LENGTH} characters` }, 400);
  }

  // `demo` marks an account whose data is invented, which keeps it off the
  // company list every account shares (demo account, docs/glossary.md#accounts).
  // Anything but a boolean means "not saying", and leaves an existing account
  // as it was.
  const demo = typeof body.demo === "boolean" ? body.demo : undefined;
  const result = await upsertUser(env.DB, name, password, demo);
  return json(result, result.created ? 201 : 200);
}

/**
 * DELETE /api/users/<id> - in ADMIN_ROUTES, so the router has already required
 * ADMIN_TOKEN. Body `{ name, dryRun? }` -> `{ deleted: {<table>: n, documents,
 * logs, invites} }`, or `{ dryRun: true, wouldDelete }`; 400 without a name, 404 for
 * an id nobody has, 409 when the name is not that account's.
 *
 * The id is in the path and the name in the body because deleting an account
 * should take two independent references to the same person. A mistyped id
 * alone deletes nobody: it either doesn't resolve, or resolves to an account
 * whose name won't match. There is no form of this route that names a set of
 * accounts - every call deletes exactly one, named twice.
 *
 * Documents go before the rows (../auth.js explains the order), and both halves
 * tolerate having already run, so a call that failed part way is finished by
 * calling it again rather than by anyone repairing it by hand.
 *
 * What the account contributed to the shared company list stays: those facts
 * are every account's, and the rotation would lose them for everyone. `deleted`
 * counts rows per table so a caller can assert on what went, the way
 * /api/purge does.
 */
export async function handleDeleteUser({ request, env, params }) {
  const id = params[0];
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json({ error: "name is required - it names the same account as the id, so a wrong id deletes nobody" }, 400);

  const user = await getUserById(env.DB, id);
  if (!user) return json({ error: `no account with id "${id}"` }, 404);
  if (user.name !== name) {
    return json({ error: `"${name}" is not the name of account ${id}`, name: user.name }, 409);
  }

  // Run logs live in the same bucket but outside the documents' prefix
  // (../r2.js), so they are deleted on their own - and, like the documents,
  // before the rows, so a call that dies between the two is finished by
  // calling again.
  const docs = env.DOCS ? new Docs(env.DOCS, user.id) : null;
  const runLogs = env.DOCS ? new RunLogs(env.DOCS, user.id) : null;
  if (body.dryRun) {
    const rows = await countAccountRows(env.DB, user.id);
    const documents = docs ? (await docs.list()).length : null;
    const logs = runLogs ? await runLogs.count() : null;
    return json({ dryRun: true, wouldDelete: { ...rows, documents, logs } });
  }

  const documents = docs ? await docs.deleteAll() : null;
  const logs = runLogs ? await runLogs.deleteAll() : null;
  const deleted = await deleteAccount(env.DB, user.id);
  return json({ deleted: { ...deleted, documents, logs } });
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
  // Checked before the current password is verified, so the two refusals
  // can't be read as one another.
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return json({ error: `your new password must be at least ${PASSWORD_MIN_LENGTH} characters` }, 400);
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
