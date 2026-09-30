/**
 * The admin area's Overview: is the system running, and is it serving anyone.
 */

import { json } from "../http.js";
import { overview } from "../overview.js";

/**
 * GET /api/admin/overview - in ADMIN_ROUTES, so the router has already
 * admitted the caller: a signed-in person whose account carries `users.admin`.
 * The deployment's token does not open this one - it is the page's screen, and
 * a machine has its own list -> `{ night, running, serving, standing }`.
 *
 * One route for the whole screen rather than one per number. Every number is
 * counted over the same tables at the same moment, so a page can't show a
 * "searches running" that disagrees with the "ran last night" beside it -
 * which is how a reader stops trusting a dashboard.
 *
 * The rules are in ../overview.js and the reads in ../deployment-db.js, which
 * is why this handler is one line: what a number means and where it is stored
 * change for different reasons, and neither of them is routing.
 *
 * This handler receives no `Db`, like every route in that list.
 */
export async function handleAdminOverview({ deploymentDb }) {
  return json(await overview(deploymentDb));
}
