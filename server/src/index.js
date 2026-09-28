/**
 * The worker's entry point: the CORS preflight, resolving who is calling,
 * building the `Db`, `Docs` and `RunLogs` scoped to them and the shared
 * `CompanyList`, and dispatching to the route table in ./routes/index.js.
 *
 * Access control is that scoped construction (see ./db.js): a handler reaches
 * a user's data only through the `Db`, `Docs` and `RunLogs` it is handed.
 * Never hand a handler an unscoped binding in their place.
 *
 * `CompanyList` is the one store a handler gets unscoped, on purpose: no row in
 * it belongs to anyone (see ./companies.js), so there is nothing to scope it
 * to. It stands beside the scoped stores, never in place of one.
 */

import { DeploymentDb } from "./deployment-db.js";
import { adminSessionUser, bearer, getSessionUser, isAdminRequest } from "./auth.js";
import { CompanyList } from "./companies.js";
import { Db } from "./db.js";
import { corsPreflight, CORS_HEADERS, unauthorized } from "./http.js";
import { Docs, RunLogs } from "./r2.js";
import { ADMIN_ROUTES, matchRoute, PUBLIC_ROUTES, S2S_ROUTES, SESSION_ROUTES } from "./routes/index.js";

/**
 * What every handler receives - one shape for all of them, so ./routes/index.js
 * stays a flat table.
 *
 * @typedef {Object} Ctx
 * @property {Request} request the incoming request
 * @property {Object} env worker bindings - `env.DB` (D1), `env.DOCS` (R2) and `env.ADMIN_TOKEN`
 * @property {URL} url the parsed request URL, for query parameters
 * @property {string[]} params the path captures, in order, already decoded
 * @property {string} token the caller's bearer token ("" on a public route)
 * @property {Object|null} user the person the token resolved to, or null
 * @property {Db|null} db a Db scoped to that person, or null on a public route
 * @property {CompanyList|null} companyList the company list every account shares, or null on a public route
 * @property {Docs|null} docs their documents in R2, scoped the same way
 * @property {RunLogs|null} runLogs their nightly run logs in R2, scoped the same way
 * @property {DeploymentDb|null} deploymentDb the deployment-wide reader, on admin routes only
 * @property {{id: string, name: string}|null} adminUser on an admin route reached
 *   by a person's session, who that was; null when the deployment's
 *   ADMIN_TOKEN was used, and on every other route. For attribution only - it
 *   says who did something and never whose rows are in front of them. An admin
 *   handler still receives `user: null` and `db: null`, so it cannot scope by
 *   this even by accident.
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return corsPreflight();
    }

    const url = new URL(request.url);

    const open = matchRoute(PUBLIC_ROUTES, request.method, url.pathname);
    if (open) {
      return open.handler({
        request, env, url, params: open.params, token: "", user: null, db: null,
        companyList: null, docs: null, runLogs: null, adminUser: null, deploymentDb: null,
      });
    }

    // Two lists, one credential each, checked as lists before any handler in
    // them runs. A machine's routes take ADMIN_TOKEN; a person's take a session
    // whose account carries `users.admin`. Which list a route is in is the
    // whole of who may call it - see routes/index.js for why that beats one
    // list with two doors.
    //
    // The machine list is tried first and answers without a database read, so
    // the scripts' path is exactly what it was. A path in both lists - invites,
    // for now - falls through to the admin check when no token was given,
    // which is what makes it reachable by either.
    //
    // What reaches neither kind of handler is `user` and `db`, null in both.
    // These routes act on an account they name; handed a `Db` a handler would
    // act on the caller's own while looking correct in review. The absence is
    // the rule enforcing itself, so it survives the next handler added by
    // someone who hasn't read this.
    const context = (route, adminUser) => ({
      request, env, url, params: route.params, token: "", user: null, db: null,
      companyList: null, docs: null, runLogs: null, adminUser,
      // The cross-account reader, and the only thing here that can see more
      // than one person's rows. Built without a user on purpose
      // (./deployment-db.js); it reads and never writes.
      deploymentDb: new DeploymentDb(env.DB),
    });

    const s2s = matchRoute(S2S_ROUTES, request.method, url.pathname);
    if (s2s && (await isAdminRequest(request, env))) {
      return s2s.handler(context(s2s, null));
    }

    const admin = matchRoute(ADMIN_ROUTES, request.method, url.pathname);
    if (admin) {
      const adminUser = await adminSessionUser(request, env);
      if (adminUser) {
        return admin.handler(context(admin, adminUser));
      }
    }

    // Matched one of the two lists but brought the wrong credential. Refused
    // here rather than falling through to the session routes, where the path
    // would 404 and say something about which routes exist.
    if (s2s || admin) return unauthorized();

    // Resolve the session before matching the path, so an unauthenticated
    // caller gets 401 for every path and learns nothing about which exist.
    const token = bearer(request);
    const user = await getSessionUser(env.DB, token);
    if (!user) {
      return unauthorized();
    }

    const route = matchRoute(SESSION_ROUTES, request.method, url.pathname);
    if (!route) {
      return new Response("Not found", { status: 404, headers: CORS_HEADERS });
    }

    return route.handler({
      request,
      env,
      url,
      params: route.params,
      token,
      user,
      db: new Db(env.DB, user.id),
      companyList: new CompanyList(env.DB),
      docs: new Docs(env.DOCS, user.id),
      runLogs: new RunLogs(env.DOCS, user.id),
      // Null on every session route, including one an admin is making. Here
      // they are a person reading their own tracker, and `db` is theirs; the
      // admin reach begins and ends in ADMIN_ROUTES above.
      adminUser: null,
      deploymentDb: null,
    });
  },
};
