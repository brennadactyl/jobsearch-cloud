/**
 * The generic field-write: one lead's status/notes, or one application record,
 * upserted. It spans both resources, which is why it sits in its own module
 * rather than in ./leads.js or ./applications.js.
 *
 * Status changes go through the two purpose-built routes instead
 * (./leads.js's handleSetLeadStatus and ./applications.js's
 * handleSetApplicationStatus), which validate the value and own the side
 * effects - application creation, stage-date stamping - that a plain field
 * write can't.
 */

import { json, readJson } from "../http.js";
import { isoDate, storedArea, unknownTrack } from "../validate.js";
import { removeDelistedLead } from "./delisting.js";
import { applicationFromLead } from "./leads.js";

/**
 * POST /api/update - requires a Bearer token. Body
 * `{ type: "lead"|"application", ... }` -> `{ ok, lead }`, or
 * `{ ok, application, moved, existing }` for an application; 400 for an
 * unknown type or a `delistedOn` that isn't YYYY-MM-DD, 404 for an unknown
 * lead, application or destination track, 409 when the destination tab
 * already holds the lead's url. A lead with `delistedOn` answers as
 * ./delisting.js's removeDelistedLead.
 *
 * An application without an `id` is a new one, and its `link` may be a posting
 * this person already has - see createApplication below. `moved` and
 * `existing` describe what happened to it and are always present on that
 * answer; an update by `id` carries neither.
 */
export async function handleUpdate({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (body.type === "lead") {
    // `delistedOn` is the one field the server acts on rather than stores: the
    // caller reports the posting is gone, and what that means is decided in
    // ./delisting.js's removeDelistedLead.
    //
    // "" is a no-op, not an error: it falls through to the plain update, whose
    // field whitelist ignores it, and the lead comes back unchanged.
    //
    // Any other value must be a real YYYY-MM-DD. It triggers a permanent delete
    // and the caller is an LLM, so "unknown" or "today" is refused rather than
    // read as "dead, date unknown".
    if (typeof body.delistedOn === "string" && body.delistedOn.trim()) {
      const on = isoDate(body.delistedOn.trim());
      if (!on) return json({ error: "delistedOn must be YYYY-MM-DD" }, 400);
      return removeDelistedLead(db, body.id, on);
    }

    // `search` moves the lead to another of this user's tabs. It's the one
    // field here that can fail on its own terms, so both failures are caught
    // rather than left to surface as a 500: an unknown track key is the same
    // drift /api/runs rejects (a lead filed under a key no tab displays is a
    // lead nobody sees again), and the destination may already hold this url,
    // which UNIQUE(user_id, search, url) refuses.
    const move = typeof body.search === "string" && body.search ? body.search : "";
    if (move && !(await db.trackExists(move))) return unknownTrack(move);

    let lead;
    try {
      lead = await db.updateLead(body.id, body);
    } catch (err) {
      if (move && /UNIQUE|constraint/i.test(String((err && err.message) || ""))) {
        return json({ error: `"${move}" already has a lead for that url` }, 409);
      }
      throw err;
    }
    if (!lead) return json({ error: "lead not found" }, 404);
    await db.touchUpdated();
    return json({ ok: true, lead });
  }

  if (body.type === "application") {
    if (body.id) {
      const app = await db.updateApplication(body.id, body);
      if (!app) return json({ error: "application not found" }, 404);
      await db.touchUpdated();
      return json({ ok: true, application: app });
    }
    return createApplication(db, body);
  }

  return json({ error: "unknown update type" }, 400);
}

/**
 * Creating an application from a link, which is usually a posting this person
 * already has somewhere: on the board as a lead, or in `screened` because a
 * run's rules turned it away and they disagree. So the posting is looked up
 * first (db.findPostingByUrl, canonical URL) and moved where one lands,
 * rather than added a second time.
 *
 * Moving beats inserting for a reason beyond the duplicate row. The row that
 * is already here knows the company, the title and the location; a fresh one
 * knows a link, and waits a night for the fill to read what this database
 * already had. What the caller sent still wins over it, since a person typing
 * a company is correcting what is stored, not repeating it.
 *
 * `moved` says which table the row came from, `existing` that there was
 * already an application and nothing was created - a caller with no row of its
 * own to show otherwise can't tell the three apart, and they don't mean the
 * same thing to whoever pasted the link.
 *
 * A link that matches nothing, or no link at all, inserts as before. Adding an
 * application with no link is ordinary: not every job applied to came from a
 * posting someone still has.
 */
async function createApplication(db, body) {
  const found = await db.findPostingByUrl(body.link);

  // Already an application: hand back the row they already have. Nothing is
  // written, so the page's "last updated" doesn't move for a no-op.
  if (found?.where === "application") {
    return json({
      ok: true,
      application: await db.getApplication(found.row.id),
      moved: "",
      existing: true,
    });
  }

  // On the board as a lead: this is the same move as marking it Applied, so it
  // goes through the same fields and the same transaction. The lead keeps its
  // row, linked by leadId, and leaves every leads tab because it is Applied -
  // which is what stops the posting showing twice.
  if (found?.where === "lead") {
    const lead = await db.getLead(found.row.id);
    // Gone between the lookup and here, or already applied to: fall through
    // rather than move a row that isn't there or create a second application
    // for one lead.
    if (lead) {
      const already = await db.getApplicationByLeadId(lead.id);
      if (already) {
        return json({ ok: true, application: already, moved: "", existing: true });
      }
      const { application } = await db.setLeadStatusAndMaybeCreateApplication(
        lead.id,
        "Applied",
        applicationFromLead(lead)
      );
      await db.touchUpdated();
      return json({ ok: true, application, moved: "lead", existing: false });
    }
  }

  // An area on a new row is kept only if it is one of the person's ranked
  // entries, as everywhere else (validate.js storedArea).
  const area = body.area === undefined ? "" : storedArea(body.area, (await db.getTracksAndSettings()).settings.priority_locations);

  // Screened: a posting the person is overruling their own search about. The
  // screened row carries what the run saw, so the application starts with a
  // company and a title instead of a blank row and a night's wait.
  if (found?.where === "screened") {
    const row = found.row;
    const application = await db.applyFromScreened(row.id, {
      ...body,
      area,
      company: body.company || row.company || "",
      title: body.title || row.title || "",
      location: body.location || row.location || "",
    });
    await db.touchUpdated();
    return json({ ok: true, application, moved: "screened", existing: false });
  }

  const app = await db.insertApplication({ ...body, area });
  await db.touchUpdated();
  return json({ ok: true, application: app, moved: "", existing: false });
}
