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
  handleUpsertUser,
} from "./accounts.js";
import { handlePurgeSearch } from "./admin.js";
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
import { handleUpdate } from "./update.js";

/**
 * The routes that run before anyone is known.
 *
 * - Exchanging a password for a token.
 * - Checking an invite and signing up with it: the person holding an invite link
 *   has no account yet, so there is nothing else they could present. Each
 *   answers only to a code worth 32 random bytes, and signup changes nothing
 *   unless that code is an open invite.
 * - Provisioning a user and purging a retired search, each with ADMIN_TOKEN
 *   checked inside the handler. They name their subject in the body rather than
 *   being the caller, so a session would be the wrong credential - and sitting
 *   here means a session token is not even a candidate credential. Newer admin
 *   routes are in ADMIN_ROUTES, where the check is the router's rather than each
 *   handler's.
 *
 * @type {Array<[string, string|RegExp, Function]>}
 */
export const PUBLIC_ROUTES = [
  ["POST", "/api/login", handleLogin],
  ["GET", /^\/api\/invite\/([^/]+)$/, handleCheckInvite],
  ["POST", "/api/signup", handleSignup],
  ["POST", "/api/users", handleUpsertUser],
  ["POST", "/api/purge", handlePurgeSearch],
];

/**
 * The routes only the operator's scripts and the onboarding run call. Every one
 * requires ADMIN_TOKEN as the bearer, checked by ../index.js before dispatch, so
 * a handler here cannot forget it and a session token is refused whoever it
 * belongs to. None is called by the person it concerns: they work across
 * accounts through ../onboarding.js, or name their subject - deleting an
 * account names it twice, in the path and the body.
 *
 * @type {Array<[string, string|RegExp, Function]>}
 */
export const ADMIN_ROUTES = [
  ["POST", "/api/invites", handleMintInvite],
  ["GET", "/api/invites", handleListInvites],
  ["POST", "/api/invites/revoke", handleRevokeInvite],
  ["GET", "/api/intake/pending", handlePendingIntakes],
  ["POST", "/api/intake/complete", handleCompleteIntake],
  ["POST", "/api/tokens", handleMintSearchToken],
  // Deleting an account sits here rather than beside POST /api/users, which
  // predates this list and checks the token inside the handler: a new admin
  // route belongs where the router does the checking.
  ["DELETE", /^\/api\/users\/([^/]+)$/, handleDeleteUser],
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
    if (routeMethod !== method) continue;
    if (typeof path === "string") {
      if (path === pathname) return { handler, params: [] };
      continue;
    }
    const hit = pathname.match(path);
    if (hit) return { handler, params: hit.slice(1).map(decodeURIComponent) };
  }
  return null;
}
