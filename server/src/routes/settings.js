/**
 * The account panel's own write (docs/account-settings-plan.md).
 *
 * POST /api/writeup is the overnight run's way into a search, and this is the
 * person's: each accepts only its own fields and refuses the other's by name,
 * whatever it is sent.
 */

import { json, readJson } from "../http.js";
import { parseDocumentList } from "../db.js";
import { fileName, isChoosableResume, listedPathFor, resumeParts, samePairName, withResume } from "../resumes.js";
import { unreadableDocumentsError } from "../validate.js";

const ACCEPTED = ["resumes"];

// Every refusal about a chosen resume says which search it is about, so the
// page can show it beside that search's picker.
function refuse(status, search, error) {
  return json({ error, search, field: "resume" }, status);
}

/**
 * POST /api/settings - requires a Bearer token. Body `{ resumes: { <search>:
 * <path> } }` -> `{ resumes: { <search>: { documents, profile_pending } } }`.
 *
 * Points each named search at a resume. Send only the searches that changed;
 * naming the resume a search already reads changes nothing.
 *
 * - The path is a stored file under resumes/. A Word file is accepted, and the
 *   list names the text read from it, which is what a run reads; that text's
 *   own path is accepted as the same choice.
 * - The chosen resume replaces every resumes/ entry in the search's
 *   `documents` list. Anything else it reads, such as a reference file, stays.
 * - A change marks the search's profile stale (migrations/0018_profile_stale.sql),
 *   so its next run rewrites the profile from the new file.
 * - All or nothing: every search is checked before any is written, and the
 *   writes are one transaction.
 *
 * Refusals, each `{ error, search, field: "resume" }`: 404 for a search this
 * person doesn't have or a file that isn't stored; 400 for a tab another search
 * fills (its resume is that search's), or a path outside resumes/; 422 for a
 * file a search can't read. A key other than `resumes` is a 400 naming it.
 */
export async function handlePostSettings({ request, db, docs }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  for (const sent of Object.keys(body)) {
    if (!ACCEPTED.includes(sent)) {
      return json({ error: `"${sent}" is not a setting this page can change`, field: sent }, 400);
    }
  }
  const resumes = body.resumes;
  if (resumes === undefined) return json({ resumes: {} });
  if (!resumes || typeof resumes !== "object" || Array.isArray(resumes)) {
    return json({ error: "resumes must be an object of search key to resume path", field: "resumes" }, 400);
  }

  if (!docs?.bucket) {
    return json({ error: "documents are not configured on this deployment - the DOCS R2 bucket is not bound (see server/wrangler.toml)" }, 503);
  }
  const rows = await db.getResumeState();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const stored = (await docs.list()).map((d) => d.path);

  const changes = [];
  const reply = {};
  for (const [key, sent] of Object.entries(resumes)) {
    const track = byKey.get(key);
    if (!track) return refuse(404, key, `unknown search "${key}"`);
    const label = track.label || key;
    if (track.fed_by) {
      const root = byKey.get(track.fed_by);
      const rootLabel = root?.label || track.fed_by;
      return refuse(400, key, `${label} is filled by the ${rootLabel} search - choose the resume for ${rootLabel} instead`);
    }
    if (typeof sent !== "string" || !resumeParts(sent)) {
      return refuse(400, key, `the resume for ${label} must be a file under resumes/`);
    }
    // A list read back names a Word file's text, so a caller may send that; it
    // is the Word file's choice either way.
    const path = (resumeParts(sent).ext === "txt" && samePairName(stored, sent, "docx")[0]) || sent;
    if (!stored.includes(path)) return refuse(404, key, `there is no resume named ${fileName(path)}`);
    if (!isChoosableResume(stored, path)) {
      const why =
        resumeParts(path).ext === "docx"
          ? `no text was read from ${fileName(path)} - attach it again, or attach a PDF`
          : `a search can't read ${fileName(path)} - choose a PDF, Word (.docx), .txt or .md resume`;
      return refuse(422, key, why);
    }

    const current = parseDocumentList(track.documents);
    const documents = withResume(current, listedPathFor(stored, path));
    const problem = unreadableDocumentsError(documents);
    if (problem) return refuse(422, key, `${label}: ${problem}`);

    const changed = JSON.stringify(documents) !== JSON.stringify(current);
    if (changed) changes.push({ key, documents, was: current.find((p) => p.startsWith("resumes/")) || "" });
    reply[key] = { documents, profile_pending: changed || !!track.profile_stale_since };
  }

  await db.setSearchResumes(changes, new Date().toISOString());
  return json({ resumes: reply });
}
