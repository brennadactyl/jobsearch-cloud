/**
 * Operator writes a scheduled search cannot reach: removing a retired search's
 * rows, and tidying the shared company list.
 *
 * Like ./accounts.js's user provisioning, each takes the ADMIN_TOKEN secret
 * rather than a session and names its subject in the body, so it builds its own
 * `Db` or `CompanyList` rather than being handed one. Neither queries d1
 * directly.
 */

import { getUserByName } from "../auth.js";
import { CompanyList } from "../companies.js";
import { Db } from "../db.js";
import { json, readJson } from "../http.js";
import { storedArea } from "../validate.js";

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

/**
 * POST /api/companies/cleanup - requires the ADMIN_TOKEN secret as Bearer. Body
 * `{ merges?: [{keep, absorb: [name, ...], rename?}], renames?: [{from, to,
 * clear_facts?}], aliases?: [{name, company}], dryRun? }` -> `{ dryRun, changes:
 * [{company, position, from, facts, sweeps, aliases}], aliases: [{company,
 * aliases}] }`; 400 for a malformed request or a company named twice, 404 for a
 * name not on the list, 409 for a retracted row, a new name already on the list,
 * an alias that is a company on the list, or one that already means another
 * company.
 *
 * Every name a merge absorbs or a rename replaces is kept as an alias of the
 * company it became, carried with the company from then on, and a run that
 * reports it is recorded against that company (routes/coverage.js). `aliases`
 * adds one without a merge: send the alias and the company, and the server adds
 * it to that company's list - de-duplicated, never the company's own name.
 *
 * Tidies the shared company list (../company-cleanup.js): a merge folds each
 * absorbed row into the kept one - its facts filling only what the kept row
 * lacks, each search's record of it kept by most recent sweep - and deletes it;
 * a rename re-keys a company under its new name, and `clear_facts` drops what
 * was known about its old careers site. Every change is checked before any is
 * written, and the writes are one transaction.
 *
 * Admin-only because it rewrites what every account's searches are served and
 * every search's own record of those companies. `dryRun` reports the same
 * changes without writing them.
 */
export async function handleCleanUpCompanies({ request, env }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const dryRun = body.dryRun === true;
  const result = await new CompanyList(env.DB).cleanUpCompanies(body, dryRun);
  if ("error" in result) return json({ error: result.error }, result.status);

  return json({
    dryRun,
    changes: result.changes.map((c) => ({
      company: c.row.display_name,
      position: c.row.position,
      from: c.before.map((r) => ({ company: r.display_name, position: r.position })),
      facts: Object.fromEntries(
        ["board", "endpoint", "url_shape", "dead_signal", "note", "verified_on", "wall", "wall_dates"].map((f) => [f, c.row[f]])
      ),
      sweeps: c.sweeps.length,
      aliases: c.row.aliases,
    })),
    // Aliases added to companies no merge or rename touched, with the whole
    // list each one now has.
    aliases: result.aliasOnly.map((a) => ({ company: a.company, aliases: a.aliases })),
  });
}

/**
 * POST /api/areas/fill - requires the ADMIN_TOKEN secret as Bearer. Body
 * `{ user, leads?: [{id, area}], applications?: [{id, area}], dryRun? }` ->
 * `{ dryRun, leads: {set, skipped}, applications: {set, skipped}, area_cleared }`;
 * 400 without a user, 404 for an unknown one.
 *
 * The one-time fill that gives an account's existing leads and applications
 * their area (docs/location-settings-plan.md, "Restoring the tiers the
 * migration lost"). The areas are worked out beforehand with the page's own
 * matcher; this only stores them, through the same check every other path
 * makes (validate.js storedArea), so an area that isn't a ranked entry is
 * counted in `area_cleared` and not written.
 *
 * Admin-only because a person never sets an area by hand: a run files it, and
 * this puts right rows filed before areas existed. It fills only a row whose
 * area is still empty, so an area a run has since filed is kept, and counts it
 * in `skipped`. `dryRun` reports the same counts and writes nothing.
 */
export async function handleFillAreas({ request, env }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.user === "string" ? body.user.trim() : "";
  if (!name) return json({ error: "user is required" }, 400);
  const user = await getUserByName(env.DB, name);
  if (!user) return json({ error: `no user named "${name}"` }, 404);

  const db = new Db(env.DB, user.id);
  const ranked = (await db.getTracksAndSettings()).settings.priority_locations;
  let areaCleared = 0;
  const checked = (rows) =>
    (Array.isArray(rows) ? rows : [])
      .filter((r) => r && Number.isInteger(Number(r.id)))
      .map((r) => {
        const area = storedArea(r.area, ranked);
        if (!area && typeof r.area === "string" && r.area.trim()) areaCleared++;
        return { id: Number(r.id), area };
      })
      .filter((r) => r.area);

  const leads = checked(body.leads);
  const applications = checked(body.applications);
  const dryRun = body.dryRun === true;
  const result = await db.fillAreas(leads, applications, dryRun);
  return json({ dryRun, ...result, area_cleared: areaCleared });
}
