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
 * screened_counts, tracks[], settings }`.
 *
 * Three sets of screened rows, answering three questions. A reader who takes
 * any two of them for one will be wrong about the other, so all three are
 * written here even though only the first two are this route's.
 *
 * **What is sent**: "is this a posting they had, or a rule of theirs at work?"
 * Their settings' rejections, what they lost (`delisted`) and what they set
 * aside by hand. A run's dead link or duplicate never arrives - not in a list,
 * not in a count, and not even when it was once a lead, because a posting that
 * turned out to be dead was never really theirs. Those rows stay in the table
 * as the runs' memory: what a screened row is for happens on the way in.
 *
 * **What is counted**: "did their own settings reject it?" That is
 * `screened_counts`, `{ <search>: <count> }` over the whole table rather than
 * the window, for the periods a window can't answer for, and over the narrower
 * set in validate.js SCREENED_BY_RULES. A search with no such row is absent
 * rather than 0: nothing was counted for it, which is not the same as a month
 * in which it turned nothing away.
 *
 * **What is shown**: "what did their settings cost them without their seeing
 * it?" That set is the page's, not this route's, and today it is the counted
 * set exactly - SCREENED_BY_RULES and nothing else - which is deliberate: a
 * list wider than the number above it is how someone stops trusting both.
 *
 * So exactly two things are sent and not shown: `delisted`, and what someone
 * set aside by hand. The second is worth naming, because sending it looks
 * like intending to display it - the tab is for what a rule decided, and a
 * decision they made themselves is one they already know about. It is sent
 * anyway, as the only record that they made it. Nothing else can be on this
 * list: the sent set above is delisted, hand, and SCREENED_BY_RULES, and the
 * last of those is the shown set. `other` is not here - a run's `other` is in
 * neither set and never leaves the server at all.
 *
 * Stated here because a row arriving is not a row shown, and the next person
 * to read this file will assume it is. This route sends what the person owns;
 * which of it belongs on a page is a different question, answered in
 * client/src/domain/screened.ts and changed there without telling this file.
 *
 * What would break "shown is the counted set exactly" is a kind added to that
 * file's list without `mine`, which shows a row the count doesn't count. A
 * kind added to SCREENED_BY_RULES here does not: the page shows a kind it
 * doesn't recognise, so it is counted and shown together. So the direction to
 * check is client-first, and this paragraph is the likeliest of the three to
 * have gone stale.
 *
 * `screened_window` is `{ days, older }`, and `older` follows the first rule,
 * since it describes the rows not sent.
 *
 * **`?screened=all` serves every row**, with `days: 0`. The window hides rows
 * the person still owns, and this is how they can be asked for: without it, the
 * only way to read what fell outside is an operator and a backup, which is not
 * a thing anyone should need to get their own record. It is the API's answer to
 * "give me all of it" whether or not a page happens to call it today.
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
    screened_counts: screenedRows.counts,
    tracks: config.tracks,
    settings: config.settings,
  });
}
