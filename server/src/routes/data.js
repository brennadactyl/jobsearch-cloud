/**
 * The one read the tracker webpage makes on load: everything this person has,
 * in a single request.
 */

import { json } from "../http.js";
import { dateDaysAgo } from "../validate.js";

// How much of the screened table the page is served. A search screens dozens of
// postings a night, and the rows older than this are read by nobody: what they
// are for is stopping the next run re-finding a posting, and that happens
// server-side on every write (db.dropKnownUrls), whatever a reader has seen.
// Nothing is deleted - a row that leaves this window still does its job.
export const SCREENED_WINDOW_DAYS = 90;

/**
 * GET /api/data - requires a Bearer token ->
 * `{ user, updated, leads[], applications[], screened[], screened_window,
 * tracks[], settings }`.
 *
 * `screened` holds the last SCREENED_WINDOW_DAYS days, and `screened_window` is
 * `{ days, older }` - how many older rows are kept but not sent, so a page can
 * say so rather than implying they are gone.
 *
 * **`?screened=all` serves every row**, with `days: 0`. An export offering
 * "everything this tab holds" has to be able to keep that promise: someone
 * taking their record to a spreadsheet wants all of it, and a person who cannot
 * get their own data out of a hosted service has a worse problem than a long
 * tab.
 */
export async function handleGetData({ db, user, url }) {
  const since = url?.searchParams.get("screened") === "all" ? "" : dateDaysAgo(SCREENED_WINDOW_DAYS);
  const [leads, applications, screenedRows, updated, config] = await Promise.all([
    db.getAllLeads(),
    db.getAllApplications(),
    db.getAllScreened(since),
    db.getUpdatedTimestamp(),
    db.getTracksAndSettings(),
  ]);
  const screened = screenedRows.rows;
  return json({
    // Who the token resolved to, so the page can say whose search it's
    // showing. The client never decides this - it has no way to ask for
    // someone else's data, since every row above is already scoped to the
    // session that made the request.
    user: { id: user.id, name: user.name },
    updated,
    leads,
    applications,
    screened,
    screened_window: { days: since ? SCREENED_WINDOW_DAYS : 0, older: screenedRows.older },
    tracks: config.tracks,
    settings: config.settings,
  });
}
