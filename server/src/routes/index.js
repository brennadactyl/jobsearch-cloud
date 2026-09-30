/**
 * The route table: which method and path map to which handler, in three lists
 * split by what the caller has to be.
 *
 * That split is the whole access-control story, and it is a list rather than a
 * flag on each row so it cannot be got wrong by omission. PUBLIC_ROUTES is short
 * and every entry is there for a stated reason. ADMIN_ROUTES all require the
 * deployment's ADMIN_TOKEN, which ../index.js checks once for the whole list
 * before any of them runs. Everything else is in SESSION_ROUTES, where
 * ../index.js has already resolved the bearer token to a person and built the
 * `Db` scoped to them. A route added later inherits one of those by default
 * rather than by remembering to.
 *
 * Every handler takes one context object (see ../index.js's Ctx) and returns a
 * Response, so adding an endpoint is one line here and one exported function in
 * the module beside this one.
 *
 * The API reference lives with each handler; ../../README.md has the prose
 * version. Persistence: ../db.js. Schema: ../../migrations/.
 */

import {
  handleChangePassword,
  handleDeleteUser,
  handleGetMe,
  handleLogin,
  handleLogout,
  handleSetUserAdmin,
  handleUpsertUser,
} from "./accounts.js";
import { handleCleanUpCompanies, handlePurgeSearch } from "./admin.js";
import { handleAdminOverview } from "./overview.js";
import {
  handleDeleteApplication,
  handleGetAutofillQueue,
  handleReportAutofill,
  handleRequeueAutofill,
  handleSetApplicationStatus,
} from "./applications.js";
import { handleGetConfig, handleSetConfig, handleWriteUp } from "./config.js";
import { handleGetCoverage, handleRecordSweeps } from "./coverage.js";
import { handleGetData } from "./data.js";
import {
  handleDeleteDocument,
  handleGetDocument,
  handleListDocuments,
  handlePutDocument,
} from "./documents.js";
import { handleDelistUrls, handleMarkVerified } from "./delisting.js";
import { handleGetRunLog, handleListRunLogs, handlePutRunLog } from "./logs.js";
import { handleAddLeads, handleDeleteLeads, handleSetLeadStatus } from "./leads.js";
import {
  handleCheckInvite,
  handleCompleteIntake,
  handleGetIntake,
  handleListInvites,
  handleMintInvite,
  handleMintSearchToken,
  handlePendingIntakes,
  handlePostIntake,
  handleRevokeInvite,
  handleSignup,
} from "./onboarding.js";
import { handleGetAutofillPrompt, handleGetPrompt } from "./prompt.js";
import { handleRecordRun } from "./runs.js";
import { handleAddScreened, handleGetDedup, handleUnscreen } from "./screened.js";
import { handlePostSettings } from "./settings.js";
import { handleUpdate } from "./update.js";

/**
 * The routes that run before anyone is known.
 *
 * - Exchanging a password for a token.
 * - Checking an invite and signing up with it: the person holding an invite link
 *   has no account yet, so there is nothing else they could present. Each
 *   answers only to a code worth 32 random bytes, and signup changes nothing
 *   unless that code is an open invite.
 *
 * Nothing here takes ADMIN_TOKEN: an operator route belongs in ADMIN_ROUTES,
 * where the router checks the token for every entry.
 *
 * @type {Array<[string, string|RegExp, Function]>}
 */
export const PUBLIC_ROUTES = [
  ["POST", "/api/login", handleLogin],
  ["GET", /^\/api\/invite\/([^/]+)$/, handleCheckInvite],
  ["POST", "/api/signup", handleSignup],
];

/**
 * **Machine routes: the deployment's own credential, and nothing else.**
 * ADMIN_TOKEN as the bearer, checked by ../index.js once for the whole list
 * before dispatch, so a handler here cannot forget it.
 *
 * These are what the operator scripts and the nightly onboarding run call. The
 * token lives in a scheduled task on a machine, never in a browser, and a
 * person's session - whatever their account carries - is refused here.
 *
 * That refusal is the point rather than an accident of history. `/api/tokens`
 * mints a search token for a named account, which reaches everything that
 * account owns; a browser credential that could call it would turn every admin
 * into a reader of everyone's tracker. Keeping the lists apart means an admin's
 * reach is decided by which list a route is in, rather than by anyone
 * remembering that one of them is different.
 *
 * A route a person should also be able to call gets **its own entry in
 * ADMIN_ROUTES below, sharing this one's logic** - not a second credential on
 * this one. Two routes over one function say who may do what; one route with
 * two doors says only "somebody may".
 *
 * @type {Array<[string, string|RegExp, Function]>}
 */
export const S2S_ROUTES = [
  // Invites are in both lists for now, the one place a path is reachable by
  // either credential. The portal takes invites over entirely in a later
  // chunk (docs/admin-dashboard-plan.md), and `new-invite.ps1` stops being the
  // way in; until then both callers are real and the duplication is the
  // honest description of that.
  ["POST", "/api/invites", handleMintInvite],
  ["GET", "/api/invites", handleListInvites],
  ["POST", "/api/invites/revoke", handleRevokeInvite],
  // The onboarding run's own three. No human does any of this from a page.
  ["GET", "/api/intake/pending", handlePendingIntakes],
  ["POST", "/api/intake/complete", handleCompleteIntake],
  ["POST", "/api/tokens", handleMintSearchToken],
  // Creating an account or resetting its password, and removing one. Each names
  // the account it acts on, so the caller is never the subject.
  ["POST", "/api/users", handleUpsertUser],
  // Who may use the admin routes, changed on its own. Separate from the upsert
  // above because that one writes a password on every call, so granting
  // through it would cost the person theirs - and revoking would too, which is
  // how a flag stops being taken back.
  ["POST", /^\/api\/users\/([^/]+)\/admin$/, handleSetUserAdmin],
  ["DELETE", /^\/api\/users\/([^/]+)$/, handleDeleteUser],
  // Removing the rows a retired search left behind, for the account named in the body.
  ["POST", "/api/purge", handlePurgeSearch],
  // Merging duplicate companies and renaming acquired ones, on the list every
  // account shares.
  ["POST", "/api/companies/cleanup", handleCleanUpCompanies],
];

/**
 * **Admin routes: a person, signed in, whose account carries `users.admin`.**
 * The flag is read from the database on every request (../auth.js
 * adminSessionUser), so clearing it ends that reach at once and on every
 * device. ADMIN_TOKEN does not open these: a machine has its own list above.
 *
 * **Every handler here receives `user: null` and `db: null`,** as in
 * S2S_ROUTES. None of these is called by the person it concerns: they name
 * their subject, or read across accounts through `ctx.deploymentDb`. With no
 * `Db` to reach for, a handler cannot quietly act on the caller's own rows,
 * and a route added later inherits that rather than remembering it.
 *
 * Setting `users.admin` is not reachable from here at all: it lives on
 * `POST /api/users`, which is machine-only, so granting and revoking stay with
 * the token by structure rather than by a check.
 *
 * The destructive ones - deleting an account, purging a search - are
 * deliberately absent until the portal needs them, and when it does they
 * arrive as their own entries over the same functions the machine list uses.
 * An auth-bearing route with no caller is a liability, and the way to add one
 * is not to put a second credential on the machine's.
 *
 * @type {Array<[string, string|RegExp, Function]>}
 */
export const ADMIN_ROUTES = [
  // Invites: the temporary overlap described above.
  ["POST", "/api/invites", handleMintInvite],
  ["GET", "/api/invites", handleListInvites],
  ["POST", "/api/invites/revoke", handleRevokeInvite],
  // The Overview, counted across every account. The one read here that isn't
  // about a named subject, so it is the one route handed `ctx.deploymentDb`
  // (../deployment-db.js) rather than naming an account itself.
  ["GET", "/api/admin/overview", handleAdminOverview],
];

/**
 * Everything else. By the time one of these runs, `ctx.user` is the person the
 * bearer token resolved to and `ctx.db` is a `Db` that can only see their rows -
 * so no handler checks ownership, because none can see anything to check.
 * Another user's lead id doesn't resolve, their track key reads as
 * unconfigured, their settings aren't in the result set.
 *
 * A RegExp path captures its groups into `ctx.params`, in order. The numeric-id
 * routes are deliberately stricter than the track-key ones: an id is a row this
 * database assigned, while a track key is an installer-chosen slug, so the
 * latter accept any single path segment and 404 on anything that isn't one of
 * this person's configured tracks.
 *
 * @type {Array<[string, string|RegExp, Function]>}
 */
export const SESSION_ROUTES = [
  ["POST", "/api/logout", handleLogout],
  ["GET", "/api/me", handleGetMe],
  // A session route, not an admin one: the caller is the account's owner, and
  // the handler also requires their current password.
  ["POST", "/api/password", handleChangePassword],
  // A person's own first-run setup. The admin routes under /api/intake/ are
  // matched first, from ADMIN_ROUTES, and these two paths are exact.
  ["GET", "/api/intake", handleGetIntake],
  ["POST", "/api/intake", handlePostIntake],
  ["GET", "/api/data", handleGetData],
  ["GET", "/api/config", handleGetConfig],
  ["POST", "/api/config", handleSetConfig],
  // The overnight run's only way into a track's config, and the form's fields
  // are unreachable through it - see handleWriteUp.
  ["POST", "/api/writeup", handleWriteUp],
  // Its mirror: the account panel's fields, and nothing the run writes.
  ["POST", "/api/settings", handlePostSettings],
  ["POST", "/api/leads", handleAddLeads],
  ["POST", "/api/runs", handleRecordRun],
  ["POST", "/api/screened", handleAddScreened],
  ["POST", "/api/update", handleUpdate],
  // The two URL-set reports a nightly run makes about the postings it already
  // tracks: which are still live, and which have come down.
  ["POST", "/api/verified", handleMarkVerified],
  ["POST", "/api/delist", handleDelistUrls],
  // Not in any prompt - see handleUnscreen.
  ["POST", "/api/unscreen", handleUnscreen],
  ["POST", /^\/api\/leads\/(\d+)\/status$/, handleSetLeadStatus],
  ["POST", /^\/api\/applications\/(\d+)\/status$/, handleSetApplicationStatus],
  // The overnight fill (./applications.js). `pending` needs no ordering care:
  // the numeric-id route above only matches \d+.
  ["GET", "/api/applications/pending", handleGetAutofillQueue],
  ["POST", "/api/applications/autofill", handleReportAutofill],
  // Not a retry, and nothing on a schedule calls it - see the handler.
  ["POST", "/api/applications/requeue", handleRequeueAutofill],
  ["GET", /^\/api\/dedup\/([^/]+)$/, handleGetDedup],
  ["GET", /^\/api\/coverage\/([^/]+)$/, handleGetCoverage],
  ["POST", "/api/coverage", handleRecordSweeps],
  // Above the track pattern, which would otherwise match `_applications` first
  // and 404. The leading underscore keeps it out of the names installers give
  // tracks.
  ["GET", "/api/prompt/_applications", handleGetAutofillPrompt],
  ["GET", /^\/api\/prompt\/([^/]+)$/, handleGetPrompt],
  ["POST", "/api/delete-application", handleDeleteApplication],
  ["POST", "/api/delete-leads", handleDeleteLeads],
  // The one resource addressed by its own URI, so the verb carries the
  // operation (PUT and DELETE are also listed in ../http.js's CORS_HEADERS).
  // `(.+)` because a document path contains a slash - see ./documents.js.
  ["GET", "/api/documents", handleListDocuments],
  ["GET", /^\/api\/documents\/(.+)$/, handleGetDocument],
  ["PUT", /^\/api\/documents\/(.+)$/, handlePutDocument],
  ["DELETE", /^\/api\/documents\/(.+)$/, handleDeleteDocument],
  // A search's run logs (./logs.js), kept apart from the documents a run
  // downloads. Also addressed by URI, so PUT carries the write.
  ["GET", /^\/api\/logs\/([^/]+)$/, handleListRunLogs],
  ["GET", /^\/api\/logs\/([^/]+)\/([^/]+)$/, handleGetRunLog],
  ["PUT", /^\/api\/logs\/([^/]+)\/([^/]+)$/, handlePutRunLog],
];

/**
 * First route in the list whose method and path both match, or null.
 *
 * Method is checked before path, so a GET to a POST-only path falls through to
 * the 404 rather than being answered by the wrong handler.
 *
 * @param {Array<[string, string|RegExp, Function]>} routes
 * @param {string} method
 * @param {string} pathname
 * @returns {{handler: Function, params: string[]}|null}
 */
export function matchRoute(routes, method, pathname) {
  for (const [routeMethod, path, handler] of routes) {
    if (routeMethod !== method) {
      continue;
    }
    if (typeof path === "string") {
      if (path === pathname) {
        return { handler, params: [] };
      }
      continue;
    }
    const hit = pathname.match(path);
    if (hit) {
      return { handler, params: hit.slice(1).map(decodeURIComponent) };
    }
  }
  return null;
}
