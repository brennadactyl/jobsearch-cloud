/**
 * The worker's entry point: the CORS preflight, resolving who is calling,
 * building the `Db` and `Docs` scoped to them, and dispatching to the route
 * table in ./routes/index.js.
 *
 * Access control is that scoped construction (see ./db.js): a handler reaches
 * a user's data only through the `Db` and `Docs` it is handed. Never hand a
 * handler an unscoped binding in their place.
 */

import { bearer, getSessionUser } from "./auth.js";
import { Db } from "./db.js";
import { corsPreflight, CORS_HEADERS, unauthorized } from "./http.js";
import { Docs } from "./r2.js";
import { matchRoute, PUBLIC_ROUTES, SESSION_ROUTES } from "./routes/index.js";

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
 * @property {Docs|null} docs their documents in R2, scoped the same way
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return corsPreflight();

    const url = new URL(request.url);

    const open = matchRoute(PUBLIC_ROUTES, request.method, url.pathname);
    if (open) {
      return open.handler({
        request, env, url, params: open.params, token: "", user: null, db: null, docs: null,
      });
    }

    // Resolve the session before matching the path, so an unauthenticated
    // caller gets 401 for every path and learns nothing about which exist.
    const token = bearer(request);
    const user = await getSessionUser(env.DB, token);
    if (!user) return unauthorized();

    const route = matchRoute(SESSION_ROUTES, request.method, url.pathname);
    if (!route) return new Response("Not found", { status: 404, headers: CORS_HEADERS });

    return route.handler({
      request,
      env,
      url,
      params: route.params,
      token,
      user,
      db: new Db(env.DB, user.id),
      docs: new Docs(env.DOCS, user.id),
    });
  },
};
