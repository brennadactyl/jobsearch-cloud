/**
 * The one destructive route in the API, and the only write a scheduled search
 * cannot reach.
 *
 * Like ./accounts.js's user provisioning, it takes the ADMIN_TOKEN secret
 * rather than a session and names its subject in the body, so it builds its own
 * `Db` (see ../db.js) for that user rather than being handed one. It still
 * never queries d1 directly.
 */

import { bearer, getUserByName } from "../auth.js";
import { Db } from "../db.js";
import { json, readJson, unauthorized } from "../http.js";

/**
 * POST /api/purge - requires the ADMIN_TOKEN secret as Bearer. Body
 * `{ user, search, dryRun? }` -> `{ purged }`, `{ dryRun: true, wouldPurge }`,
 * or `{ purged, note }` when nothing is stored; 400 for a missing field, 401
 * without the admin token, 404 for an unknown user, 409 for a key that is still
 * a configured track.
 *
 * Removes every row a retired search left behind - leads, screened rows, its
 * company-rotation rows and run record - in one transaction. Dropping a track
 * from /api/config keeps its rows so a config edit never loses leads; this is
 * how they go. Application rows survive with `leadId` cleared, and
 * `applications` in the counts is how many were cleared (see db.purgeSearch).
 * How it compares with the other delete routes: server/README.md, "The three
 * ways a lead can be deleted".
 *
 * Two guards. The ADMIN_TOKEN, because every session route is reachable with
 * the token a scheduled run keeps on disk, and a prompt-injected run must not
 * be able to empty a table. And the 409, so only data no tab displays can be
 * deleted and a typo naming a live search is an error, not a delete.
 */
export async function handlePurgeSearch({ request, env }) {
  const admin = env.ADMIN_TOKEN;
  if (!admin || bearer(request) !== admin) return unauthorized();

  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.user === "string" ? body.user.trim() : "";
  const key = typeof body.search === "string" ? body.search.trim() : "";
  if (!name || !key) return json({ error: "user and search are required" }, 400);

  const user = await getUserByName(env.DB, name);
  if (!user) return json({ error: `no user named "${name}"` }, 404);

  const db = new Db(env.DB, user.id);
  if (await db.trackExists(key)) {
    return json(
      {
        error: `"${key}" is a configured track for ${user.name} - remove it from the track list first if you mean to retire it`,
      },
      409
    );
  }

  const counts = await db.countSearchRows(key);
  if (counts.leads === 0 && counts.screened === 0 && counts.sweeps === 0 && counts.runs === 0) {
    return json({ purged: counts, note: `nothing stored under "${key}" for ${user.name}` });
  }

  // `dryRun` so the rows can be counted before anyone commits to removing
  // them. The counts come from the same method the purge uses, so what this
  // reports is what that would delete.
  if (body.dryRun) return json({ dryRun: true, wouldPurge: counts });

  const purged = await db.purgeSearch(key);
  await db.touchUpdated();
  return json({ purged });
}
