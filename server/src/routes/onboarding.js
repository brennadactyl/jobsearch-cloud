/**
 * Invite signup and first-run setup (docs/onboarding.md).
 *
 * Three kinds of caller, and the route table (./index.js) keeps them apart:
 * - a new person with only an invite link: the invite check and signup are
 *   public
 * - that person once signed in: their own setup, through their session
 * - the operator's scripts and the onboarding run: invites, the setup queue and
 *   search tokens, with ADMIN_TOKEN, checked once for the whole admin list
 *
 * Data access is in ../onboarding.js and, for a person's own setup, ../db.js.
 */

import { createSession, PASSWORD_MIN_LENGTH, SESSION_LABEL } from "../auth.js";
import { json, readJson } from "../http.js";
import { PRONOUNS } from "../prompt.js";
import {
  completeIntake,
  findInvite,
  INVITE_DAYS_DEFAULT,
  INVITE_DAYS_MAX,
  inviteState,
  listInvites,
  mintInvite,
  mintSearchToken,
  pendingIntakes,
  retriesEndAt,
  revokeInvite,
  signupWithInvite,
} from "../onboarding.js";
import { isDocumentPath, locationSettingError, nowhereToSearchError, pronounsError } from "../validate.js";

const NOTE_MAX = 200;
const NAME_MAX = 60;
const STATUS_NOTE_MAX = 500;
const ANSWERS_MAX_BYTES = 256 * 1024;
const ROLES_MAX = 10;
const ANSWER_STRINGS = [
  "page_title", "pronouns", "resume_text", "work_scope", "location_limits", "locations_first",
  "location_note", "never_work_for", "preferences",
];
// The form's location answers, and the setting each becomes, stored as typed
// (docs/location-settings-plan.md). The answer keys predate the settings' names.
const LOCATION_ANSWERS = {
  work_scope: "search_locations",
  location_limits: "excluded_locations",
  locations_first: "priority_locations",
  location_note: "location_note",
};
// A track key is a slug of the role name, fixed at creation: renaming a role
// later changes the label only, so no lead is orphaned
// (docs/onboarding.md#why-it-is-split-this-way).
const KEY_MAX = 40;
// One send per account, so the refusal is the same whatever state the setup is
// in - and it says what to do instead, since there is no re-send.
const ALREADY_SENT = {
  error: "your setup has already been sent - change your search from the tracker, or ask whoever invited you",
};
const ROLE_STRINGS = ["name", "titles", "company_kinds", "rule_outs", "min_pay"];

/**
 * GET /api/invite/:code - public -> `{ valid: true, expires_at }` or
 * `{ valid: false, reason: "invalid"|"used"|"expired"|"revoked" }`.
 *
 * What the page asks before showing signup. A code nobody minted and a malformed
 * one both read "invalid": telling them apart would only help someone guessing.
 */
export async function handleCheckInvite({ env, params }) {
  const invite = await findInvite(env.DB, params[0]);
  if (!invite) return json({ valid: false, reason: "invalid" });
  const state = inviteState(invite, new Date().toISOString());
  return state === "open" ? json({ valid: true, expires_at: invite.expires_at }) : json({ valid: false, reason: state });
}

/**
 * POST /api/signup - public. Body `{ code, name, password }` -> `201 { token,
 * user: {id, name} }`; 410 `{ error, reason }` for an invite that cannot be used;
 * 400 `{ error, field }` for the name or password; 409 `{ error, field: "name" }`
 * for a name already taken, with the invite left open.
 *
 * The invite is checked before anything else, so a caller without a working
 * link learns nothing about which names exist. The claim and the account happen
 * together or not at all - see signupWithInvite. The token is a browser session,
 * issued once the account exists; if issuing it failed, the person could still
 * sign in with the password they chose.
 */
export async function handleSignup({ request, env }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const invite = await findInvite(env.DB, typeof body.code === "string" ? body.code : "");
  const state = invite ? inviteState(invite, new Date().toISOString()) : "invalid";
  if (state !== "open") return json({ error: "this invite can't be used", reason: state }, 410);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name) return json({ error: "name is required", field: "name" }, 400);
  if (name.length > NAME_MAX) return json({ error: `name must be at most ${NAME_MAX} characters`, field: "name" }, 400);
  if (password.length < PASSWORD_MIN_LENGTH) {
    return json({ error: `password must be at least ${PASSWORD_MIN_LENGTH} characters`, field: "password" }, 400);
  }

  const outcome = await signupWithInvite(env.DB, invite, name, password);
  if (outcome.taken) {
    return json({ error: `The name “${name}” is already taken here — pick another.`, field: "name" }, 409);
  }
  if (outcome.reason) return json({ error: "this invite can't be used", reason: outcome.reason }, 410);

  const token = await createSession(env.DB, outcome.user.id, SESSION_LABEL.browser);
  return json({ token, user: outcome.user }, 201);
}

/**
 * GET /api/intake - requires a Bearer token -> `{ intake: null }` or
 * `{ intake: { answers, status, status_note, sent_at, updated_at, retries_end_at } }`.
 *
 * `retries_end_at` is the first instant a failed setup is no longer handed to
 * the overnight run (../onboarding.js's retriesEndAt), as an ISO instant, or ""
 * without a `sent_at`. It is sent whatever the status, so the page can stop
 * promising another night once it has passed.
 */
export async function handleGetIntake({ db }) {
  const intake = await db.getIntake();
  return json({ intake: intake && { ...intake, retries_end_at: retriesEndAt(intake.sent_at) } });
}

/**
 * POST /api/intake - requires a Bearer token. Body `{ answers }` -> `{ intake }`,
 * stored as pending; 400 `{ error, field }` for answers the run cannot use; 409
 * once the setup is done; 403 for a demo account.
 *
 * The answers are stored whole, as sent, because the run reads every field and
 * the form may add more. Only what the run cannot work without is checked:
 * at least one role with a name and titles, a resume it can find, location
 * answers as text within their caps, and somewhere to look. A resume counts
 * when there is pasted text, or when a named file under resumes/ exists now -
 * the page uploads files before it sends the answers.
 */
export async function handlePostIntake({ request, db, docs, user }) {
  if (user.demo) return json({ error: "a demo account cannot send setup" }, 403);
  const body = await readJson(request);
  if (body instanceof Response) return body;

  // Write-once, whatever state the setup is in (docs/onboarding.md#why-it-is-split-this-way).
  // There is no re-send: the tracker's own config is how a search changes after
  // this, so nothing a person does can put an account back to `pending`.
  if (await db.getIntake()) return json(ALREADY_SENT, 409);

  const problem = (await answersProblem(body.answers, docs)) || scopeProblem(body.answers);
  if (problem) return json(problem, 400);

  const answers = body.answers;
  const tracks = tracksFromRoles(answers.roles);
  // The form's half of the config, written now rather than overnight: these are
  // values, and a value needs no judgement. The run's half - the prose
  // prompt.js reads - is written later through POST /api/writeup.
  const settings = {
    display_title: (answers.page_title || "").trim() || `${user.name}'s Job Search`,
    pronouns: answers.pronouns || "",
    ...Object.fromEntries(
      Object.entries(LOCATION_ANSWERS).map(([answer, setting]) => [setting, (answers[answer] || "").trim()])
    ),
    excluded_companies: JSON.stringify(namedCompanies(answers.never_work_for)),
  };

  // The answers and the config land together or not at all: the page decides
  // between the form and the tracker by whether the intake exists, and must
  // never meet an account that is half built.
  if (!(await db.createIntakeWithConfig(JSON.stringify(answers), settings, tracks))) {
    return json(ALREADY_SENT, 409);
  }
  return json({ ok: true, tracks: tracks.map((t) => t.key) });
}

/**
 * The companies someone said they would never work for, as the list
 * `excluded_companies` holds. One per line or comma-separated, since the form
 * asks for prose and people write both.
 * @param {unknown} text
 */
function namedCompanies(text) {
  if (typeof text !== "string") return [];
  return [...new Set(text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * The tracks a send creates, one per role block, in the order they were filled
 * in. A key is a slug of the role's name; a name that slugs to nothing, or to
 * one another role already took, falls back to its position, so two roles
 * called "Eng" and "eng!" are never one track.
 * @param {Array<{name: string}>} roles
 */
function tracksFromRoles(roles) {
  const taken = new Set();
  return roles.map((role, i) => {
    let key = String(role.name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, KEY_MAX);
    if (!key || taken.has(key)) key = `${key || "role"}-${i + 1}`.slice(0, KEY_MAX);
    taken.add(key);
    return { key, label: role.name.trim(), sort_order: i };
  });
}

/**
 * Whether someone gave the search somewhere to look, checked while they are
 * still on the form (docs/onboarding.md#why-it-is-split-this-way): a place to
 * search (`work_scope`) or a place ranked first (`locations_first`). An empty
 * `work_scope` then means "only the ranked places".
 *
 * The two aren't compared. Where location answers disagree the place is
 * included rather than the send refused (docs/location-settings-plan.md).
 *
 * @param {Record<string, unknown>} answers
 * @returns {{error: string, field: string}|null}
 */
function scopeProblem(answers) {
  const error = nowhereToSearchError(answers.work_scope, answers.locations_first);
  return error ? { error, field: "work_scope" } : null;
}

/**
 * The first thing wrong with a set of answers, as `{ error, field }`, or null.
 * `field` names where the page shows the message.
 * @param {unknown} answers
 * @param {import("../r2.js").Docs} docs
 */
async function answersProblem(answers, docs) {
  const bad = (field, error) => ({ error, field });
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return bad("answers", "answers must be an object");
  if (new TextEncoder().encode(JSON.stringify(answers)).length > ANSWERS_MAX_BYTES) {
    return bad("answers", "answers are larger than 256 KB");
  }
  for (const key of ANSWER_STRINGS) {
    if (answers[key] !== undefined && typeof answers[key] !== "string") {
      return bad(key === "resume_text" ? "resume" : "answers", `${key} must be text`);
    }
  }
  if (answers.pronouns !== undefined) {
    const problem = pronounsError(answers.pronouns, Object.keys(PRONOUNS));
    if (problem) return bad("answers", problem);
  }

  const roles = answers.roles;
  if (!Array.isArray(roles) || roles.length === 0) return bad("roles", "add at least one role");
  if (roles.length > ROLES_MAX) return bad("roles", `at most ${ROLES_MAX} roles`);
  for (const [i, role] of roles.entries()) {
    if (!role || typeof role !== "object" || Array.isArray(role)) return bad("roles", `role ${i + 1} must be an object`);
    for (const key of ROLE_STRINGS) {
      if (role[key] !== undefined && typeof role[key] !== "string") return bad("roles", `role ${i + 1}'s ${key} must be text`);
    }
    if (!(role.name || "").trim()) return bad("roles", `role ${i + 1} needs a name`);
    if (!(role.titles || "").trim()) return bad("roles", `role ${i + 1} needs the roles to search for`);
  }

  for (const [answer, setting] of Object.entries(LOCATION_ANSWERS)) {
    if (answers[answer] === undefined) continue;
    const error = locationSettingError(setting, answers[answer]);
    if (error) return bad(answer, error.replace(setting, answer));
  }

  const files = answers.resume_files === undefined ? [] : answers.resume_files;
  if (!Array.isArray(files) || files.some((p) => typeof p !== "string" || !p.startsWith("resumes/") || !isDocumentPath(p))) {
    return bad("resume", "resume_files must be document paths under resumes/");
  }
  if ((answers.resume_text || "").trim()) return null;
  if (files.length) {
    const stored = new Set((await docs.list()).map((d) => d.path));
    if (files.some((p) => stored.has(p))) return null;
  }
  return bad("resume", "attach a resume or paste its text");
}

/**
 * POST /api/invites - ADMIN_TOKEN. Body `{ note?, days? }` -> `201 { id, code,
 * note, created_at, expires_at }`; 400 for a note over 200 characters or days
 * outside 1-30. The code appears only in this response.
 */
export async function handleMintInvite({ request, env }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const note = body.note === undefined ? "" : body.note;
  if (typeof note !== "string" || note.length > NOTE_MAX) {
    return json({ error: `note must be at most ${NOTE_MAX} characters` }, 400);
  }
  const days = body.days === undefined ? INVITE_DAYS_DEFAULT : body.days;
  if (!Number.isInteger(days) || days < 1 || days > INVITE_DAYS_MAX) {
    return json({ error: `days must be a whole number from 1 to ${INVITE_DAYS_MAX}` }, 400);
  }
  return json(await mintInvite(env.DB, note, days), 201);
}

/**
 * GET /api/invites - ADMIN_TOKEN -> `{ invites: [{ id, note, created_at,
 * expires_at, used_at, revoked_at, user, state }] }`, newest first. `state` is
 * worked out here so no script redoes the date comparison.
 */
export async function handleListInvites({ env }) {
  return json({ invites: await listInvites(env.DB) });
}

/**
 * POST /api/invites/revoke - ADMIN_TOKEN. Body `{ id }` -> `{ id, state:
 * "revoked" }`; 404 for no such invite; 409 for one already used.
 */
export async function handleRevokeInvite({ request, env }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (!Number.isInteger(body.id)) return json({ error: "id must be an invite id" }, 400);
  const outcome = await revokeInvite(env.DB, body.id);
  if (outcome === "missing") return json({ error: "no such invite" }, 404);
  if (outcome === "used") return json({ error: "invite already used" }, 409);
  return json({ id: body.id, state: "revoked" });
}

/**
 * GET /api/intake/pending - ADMIN_TOKEN -> `{ intakes: [{ user: {id, name},
 * status, status_note, sent_at, updated_at, answers }] }`, oldest attempt first.
 */
export async function handlePendingIntakes({ env }) {
  return json({ intakes: await pendingIntakes(env.DB) });
}

/**
 * POST /api/tokens - ADMIN_TOKEN. Body `{ user }` -> `201 { token, user,
 * label: "scheduled-search", replaced }`; 404 for no such account; 403 for a
 * demo account.
 *
 * This is the one admin route that yields access to a person's own data: the
 * token reaches everything that account owns, as the nightly search's does. That
 * is what the onboarding run needs to build someone's search, and it is why
 * ADMIN_TOKEN reaches people's data rather than only creating accounts - see
 * server/README.md's security notes.
 */
export async function handleMintSearchToken({ request, env }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const outcome = await mintSearchToken(env.DB, body.user);
  if (outcome.missing) return json({ error: "no such user" }, 404);
  if (outcome.demo) return json({ error: "a demo account has no scheduled search" }, 403);
  return json({ token: outcome.token, user: outcome.user, label: SESSION_LABEL.scheduledSearch, replaced: outcome.replaced }, 201);
}

/**
 * POST /api/intake/complete - ADMIN_TOKEN. Body `{ user, status: "done"|"failed",
 * note? }`, where `user` is the account id, not its name -> `{ user, status,
 * status_note, updated_at }`; 404 for an account that never sent a setup; 409
 * once done. `note` is shown to the person as
 * written, as plain text.
 */
export async function handleCompleteIntake({ request, env }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (typeof body.user !== "string" || !body.user) return json({ error: "user must be an account id" }, 400);
  if (body.status !== "done" && body.status !== "failed") return json({ error: 'status must be "done" or "failed"' }, 400);
  const note = body.note === undefined ? "" : body.note;
  if (typeof note !== "string" || note.length > STATUS_NOTE_MAX) {
    return json({ error: `note must be at most ${STATUS_NOTE_MAX} characters` }, 400);
  }
  const outcome = await completeIntake(env.DB, body.user, body.status, note);
  if (outcome.missing) return json({ error: "no such intake" }, 404);
  if (outcome.done) return json({ error: "intake already done" }, 409);
  return json(outcome);
}
