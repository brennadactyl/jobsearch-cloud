/**
 * Applications: the rows that outlive the postings they came from.
 *
 * An application is the least recoverable row in this database - it is the
 * record of having applied, and every deletion path elsewhere bends around
 * keeping it (see ./leads.js's handleDeleteLeads and ./delisting.js).
 */

import { json, readJson } from "../http.js";
import { isoDate } from "../validate.js";

// Duplicated from client/public/index.html's APP_STATUS: no build step ties
// client and server together.
//
// "To Apply" is a posting logged before applying to it - a row in the
// Applications tab that hasn't been sent yet, so it has no dateApplied until
// it moves on.
export const APP_STATUS = [
  "To Apply", "Applied", "Recruiter Screen", "Tech Screen", "Onsite / Loop",
  "Offer", "Rejected", "Withdrawn",
];

// Which column holds the date an application first reached each stage;
// mirrors client/public/index.html's STAGE_DATE_FIELDS. The stamp only fills a
// blank column, so a "To Apply" row gets dateApplied the day it's applied to.
export const STAGE_DATE_MAP = {
  "Applied": "dateApplied",
  "Recruiter Screen": "dateRecruiterScreen",
  "Tech Screen": "dateTechScreen",
  "Onsite / Loop": "dateOnsite",
  "Offer": "dateOffer",
  "Rejected": "dateRejected",
  "Withdrawn": "dateWithdrawn",
};

/**
 * POST /api/applications/:id/status - requires a Bearer token. Body
 * `{ status, date? }` -> `{ application }`; 400 for a status not in APP_STATUS,
 * 404 for an unknown application.
 *
 * The first time an application reaches a stage in STAGE_DATE_MAP, that
 * column is stamped in the same statement, only if still empty, so a date
 * corrected by hand (via /api/update) is never overwritten. The date is `date`
 * when it is a valid YYYY-MM-DD - the page asks, since a stage often happened
 * days before it's logged - and today otherwise.
 *
 * Moving back to "To Apply" clears dateApplied instead: the row isn't applied
 * to yet, and a leftover date would block the stamp when it is.
 */
export async function handleSetApplicationStatus({ request, db, params }) {
  const id = params[0];
  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (!APP_STATUS.includes(body.status)) {
    return json({ error: "invalid status" }, 400);
  }
  const explicitDate = isoDate(body.date) || null;

  const application = await db.setApplicationStatus(
    id,
    body.status,
    STAGE_DATE_MAP[body.status] || null,
    body.status === "To Apply" ? "dateApplied" : null,
    explicitDate
  );
  if (!application) return json({ error: "application not found" }, 404);
  await db.touchUpdated();
  return json({ application });
}

/**
 * POST /api/delete-application - requires a Bearer token. Body `{ id }` ->
 * `{ ok }`; 400 for a missing id, 404 for an unknown application.
 */
export async function handleDeleteApplication({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (!body.id) return json({ error: "missing id" }, 400);
  const deleted = await db.deleteApplication(body.id);
  if (!deleted) return json({ error: "application not found" }, 404);
  await db.touchUpdated();
  return json({ ok: true });
}

// ------------------------------------------------- the overnight fill --
//
// An application can be added as just a URL; a nightly run reads the posting
// and fills in the rest. There is nothing for the person to drive: every
// application with a link and a gap is read once, and a flag records that it
// was. See migrations/0009_application_autofill.sql for the flag,
// db.getAutofillQueue for which rows qualify, ../prompt.js's
// buildAutofillPrompt for what the run is told, and server/README.md for the
// long form.

/** Longest `reason` or `note` accepted. It's a line on a row, not a report. */
const MAX_REASON = 200;

/**
 * GET /api/applications/pending - requires a Bearer token ->
 * `{ applications: [{id, link}] }`.
 *
 * What the nightly fill run fetches. Two columns, because this lands in a
 * headless run's context every night. An empty list is the ordinary answer and
 * means "stop here". The server picks the rows (db.getAutofillQueue) so a run
 * never judges a filled-in row unfinished enough to overwrite.
 */
export async function handleGetAutofillQueue({ db }) {
  return json({ applications: await db.getAutofillQueue() });
}

/**
 * POST /api/applications/autofill - requires a Bearer token. Body
 * `{ filled: [{id, company, title, location, team, setup, comp, note?}],
 *    failed: [{id, reason}] }` -> `{ filled, failed, unmatched: [id] }`; 400
 * when both lists are empty.
 *
 * One call for the whole night rather than one per row, because a run asked to
 * make thirty calls tends to stop short. Only unread rows move, so an id in
 * `unmatched` was deleted or already reported since the queue was fetched -
 * nothing to retry.
 *
 * A partial read is a `filled` row with a `note` saying why it's still short,
 * not a failure: the fields it did get are real.
 */
export async function handleReportAutofill({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const filled = Array.isArray(body.filled) ? body.filled : [];
  const failed = Array.isArray(body.failed) ? body.failed : [];
  if (filled.length === 0 && failed.length === 0) {
    return json({ error: "no filled or failed rows provided" }, 400);
  }

  const unmatched = [];
  let filledCount = 0;
  let failedCount = 0;

  for (const row of filled) {
    if (!row || !row.id) continue;
    // Shown on the row like a failure's reason, so it gets the same cap.
    const note = String((row.note || "")).trim().slice(0, MAX_REASON);
    if (await db.applyAutofill(row.id, { ...row, note })) filledCount++;
    else unmatched.push(row.id);
  }

  for (const row of failed) {
    if (!row || !row.id) continue;
    const reason = String(row.reason || "").trim() || "couldn't read the posting";
    if (await db.failAutofill(row.id, reason.slice(0, MAX_REASON))) failedCount++;
    else unmatched.push(row.id);
  }

  // Only a fill writes application fields. A failure sets just the flag and its
  // note, so it doesn't bump the page's "last updated" banner.
  if (filledCount > 0) await db.touchUpdated();
  return json({ filled: filledCount, failed: failedCount, unmatched });
}

/**
 * POST /api/applications/requeue - requires a Bearer token. Body
 * `{ ids: [...] }` -> `{ requeued }`; 400 for no ids.
 *
 * Clears the read flag on the named rows, so the next fill reads them again.
 * An id that isn't the caller's doesn't match and isn't counted.
 *
 * Not a retry, and nothing calls it on a schedule. A row is read once by
 * design (migrations/0009_application_autofill.sql); this is for when the
 * reader itself has improved, a judgement made by whoever changed it - hence
 * explicit ids, not a "re-read every failure" switch that could be wired to a
 * schedule. The page has no control for it: a person facing an unreadable row
 * wants to type it in.
 */
export async function handleRequeueAutofill({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => id || id === 0) : [];
  if (ids.length === 0) return json({ error: "no ids provided" }, 400);

  const requeued = await db.requeueAutofill(ids);
  return json({ requeued });
}
