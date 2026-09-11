/**
 * Leads: the postings a search found and filed into one of this person's tabs.
 *
 * Three ways in and one way out. A run appends them (/api/leads), a person
 * moves one to "Applied" (/api/leads/:id/status), and a person clears the ones
 * they have decided against (/api/delete-leads). The fourth thing that removes
 * a lead - a run reporting the posting taken down - lives in ./delisting.js,
 * because that rule is shared with /api/update and must not be written twice.
 */

import { DELISTED_REASON } from "../db.js";
import { excludedCompanyMatcher } from "../exclude.js";
import { json, readJson } from "../http.js";
import { isoDate, today, unknownTrackResponse } from "../validate.js";

// Duplicated from client/public/index.html's LEAD_STATUS: no build step ties
// client and server together. Only handleSetLeadStatus validates against it;
// /api/update (./update.js) writes `status` unvalidated.
export const LEAD_STATUS = ["New", "Reviewing", "Applied", "Not a fit"];

/**
 * POST /api/leads - requires a Bearer token. Body `{ on?, leads: [...] }` ->
 * `{ added, duplicates, excluded }`; 400 for no valid leads, 404 naming any
 * unknown track (nothing inserted).
 *
 * Appends leads whose posting this user doesn't already have, matched by
 * canonical URL (../url.js) as well as the UNIQUE constraint, so the same
 * posting under a different URL is caught too. Scoped to the search, so one
 * branched run can't file a posting into two of its tabs. `on` is the caller's
 * local date, used for found/verified.
 */
export async function handleAddLeads({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const incoming = Array.isArray(body.leads) ? body.leads : [];
  if (incoming.length === 0) return json({ error: "no leads provided" }, 400);

  // Of EXTRA_FIELDS, only team/setup/comp are things a posting states. The rest
  // (referral, resume, lastContact, nextAction*, link) are the person's own:
  // accepted, but a search never sends them, so they default to ''.
  const valid = incoming.filter((lead) => lead.search && lead.url && lead.company && lead.title);
  if (valid.length === 0) return json({ error: "no valid leads in payload" }, 400);

  // The run's own local date, applied to every lead that didn't carry one.
  // Same reasoning as /api/runs' `on`: the worker only knows UTC, so it cannot
  // derive the day the search believes it is having.
  const on = isoDate(body.on);

  // One read serves both guards below: the tracks for the drift check, the
  // settings for the exclusion matcher.
  const { tracks, settings } = await db.getTracksAndSettings();

  // Checked before the exclusion filter, so a mistyped search whose rows are
  // all excluded still gets the 404 rather than `{ added: 0 }`.
  const drift = unknownTrackResponse(tracks, valid);
  if (drift) return drift;

  // Companies this person will not work for, enforced here because a run
  // doesn't reliably follow the prompt's instruction. See ../exclude.js for the
  // matching rules.
  const isExcluded = excludedCompanyMatcher(settings.excluded_companies);
  const allowed = valid.filter((lead) => !isExcluded(lead.company));
  const excluded = valid.length - allowed.length;
  if (allowed.length === 0) return json({ added: 0, duplicates: 0, excluded });

  const { added, duplicates } = await db.addLeads(allowed, on);
  if (added > 0) await db.touchUpdated();

  // `duplicates` is reported so a run's own report says what it actually added,
  // not how many rows it posted.
  return json({ added, duplicates, excluded });
}

/**
 * POST /api/leads/:id/status - requires a Bearer token. Body `{ status }` ->
 * `{ lead, application }`; 400 for a status not in LEAD_STATUS, 404 for an
 * unknown lead.
 *
 * Moving to "Applied" creates the application row in the same D1 transaction
 * (db.setLeadStatusAndMaybeCreateApplication), so a lead can't end up Applied
 * without one. The existing-application check is a read before the write, not
 * a constraint, so two truly concurrent requests for one lead can both create
 * one.
 */
export async function handleSetLeadStatus({ request, db, params }) {
  const id = params[0];
  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (!LEAD_STATUS.includes(body.status)) {
    return json({ error: "invalid status" }, 400);
  }

  const [lead, existingApp] = await Promise.all([db.getLead(id), db.getApplicationByLeadId(id)]);
  if (!lead) return json({ error: "lead not found" }, 404);

  const willCreateApp = body.status === "Applied" && !existingApp;
  const { lead: updatedLead, application: newApp } = await db.setLeadStatusAndMaybeCreateApplication(
    id,
    body.status,
    willCreateApp
      ? {
          leadId: String(id),
          company: lead.company,
          title: lead.title,
          location: lead.location || "",
          dateApplied: today(),
          status: "Applied",
          notes: lead.notes || "",
          link: lead.url || "",
          referral: lead.referral || "",
          comp: lead.comp || "",
          team: lead.team || "",
          setup: lead.setup || "",
        }
      : null
  );
  await db.touchUpdated();

  return json({ lead: updatedLead, application: willCreateApp ? newApp : existingApp || null });
}

/** Longest `reason` accepted. It's a note on a screened row, not a document. */
const MAX_REASON = 200;

/**
 * POST /api/delete-leads - requires a Bearer token. Body `{ ids: [...],
 * reason }` (or `id`) -> `{ removed, kept, unmatched, reason }`; 400 for a
 * missing or over-long reason or no ids.
 *
 * Removes leads a person has decided against, leaving a screened row with
 * their reason. How it differs from /api/delist and /api/purge: server/README.md,
 * "The three ways a lead can be deleted".
 *
 * `reason` is required, not defaulted: the screened row is the only record of
 * why the posting went, and a default would claim a motive nobody gave. That
 * row is also what stops tomorrow's run re-adding the URL.
 *
 * A lead an application points at is kept and listed in `kept`, since deleting
 * it would strand the application. Its leadId isn't cleared the way
 * purgeSearch clears it: one-click removal shouldn't silently sever an
 * application. Ids that don't resolve - another person's included - come back
 * in `unmatched`.
 */
export async function handleDeleteLeads({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  let reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return json({ error: "missing reason - say why these are being removed; it is stored on the screened row" }, 400);
  }
  if (reason.length > MAX_REASON) {
    return json({ error: `reason must be ${MAX_REASON} characters or fewer` }, 400);
  }

  // DELISTED_REASON is reserved for delistings, and a person could naturally
  // type it here - see server/README.md, "One shared trap".
  if (reason.toLowerCase() === DELISTED_REASON) reason = "removed by hand";

  const ids = Array.isArray(body.ids) ? body.ids : body.id != null ? [body.id] : [];
  if (!ids.length) return json({ error: "missing ids" }, 400);

  let removed = 0;
  const kept = [];
  const unmatched = [];
  for (const rawId of ids) {
    const lead = await db.getLead(rawId);
    if (!lead) {
      unmatched.push(rawId);
      continue;
    }
    if (await db.getApplicationByLeadId(lead.id)) {
      kept.push(lead.id);
      continue;
    }
    // 'hand': a person clearing their own board isn't a run's work, so the
    // screened row isn't counted as one (migrations/0007_screened_added_by.sql).
    if (await db.deleteLeadAndScreen(lead, reason, null, "hand")) removed++;
  }

  if (removed) await db.touchUpdated();
  return json({ removed, kept, unmatched, reason });
}
