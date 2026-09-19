/**
 * Verification matrix for the multi-user API. Run it against a LOCAL dev
 * worker only - it creates users and deletes nothing, but it writes freely
 * and assumes it can.
 *
 *   wrangler d1 migrations apply job-search-tracker-db --local
 *   echo ADMIN_TOKEN=local-admin-token-for-testing > .dev.vars
 *   wrangler dev --local --port 8787
 *   node verify-local.mjs
 *
 * Point it elsewhere with `node verify-local.mjs <base-url> <admin-token>`.
 *
 * What it's for: server/ has no unit tests, and the one property
 * that most needs checking before a deploy is that two people's data cannot
 * reach each other. Most of the checks below are one user trying to read or
 * write another's rows by id and getting a 404 - the thing that would be
 * catastrophic and silent if the user scoping in db.js ever regressed.
 *
 * Re-running against the same local database is fine - it resets the
 * passwords it uses and tolerates its fixtures already existing.
 */
const A = process.argv[2] || "http://127.0.0.1:8787";
const ADMIN = process.argv[3] || "local-admin-token-for-testing";
let pass = 0, fail = 0;

// `raw`, `type`, `ifMatch` and `bytes` are for /api/documents, the one resource
// whose body is not JSON in either direction (see src/routes/documents.js).
const req = async (method, path, { token, body, admin, raw, type, ifMatch, bytes } = {}) => {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (type) headers["content-type"] = type;
  if (ifMatch) headers["if-match"] = ifMatch;
  if (token) headers.authorization = "Bearer " + token;
  if (admin) headers.authorization = "Bearer " + ADMIN;
  const res = await fetch(A + path, {
    method,
    headers,
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
  });
  if (bytes) {
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
};

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " -- " + detail : ""}`); }
}

console.log("\n== provisioning ==");
check("admin route rejects a missing admin token",
  (await req("POST", "/api/users", { body: { name: "x", password: "aaaaaaaaaaaa" } })).status === 401);
check("password under 12 chars refused",
  (await req("POST", "/api/users", { admin: true, body: { name: "shorty", password: "short" } })).status === 400);

const aCreate = await req("POST", "/api/users", { admin: true, body: { name: "Ada", password: "ada-long-password" } });
await req("POST", "/api/users", { admin: true, body: { name: "Bo", password: "bo-long-password1" } });
// 201 the first time, 200 on a re-run against the same local database.
check("creating a user returns a guid",
  [200, 201].includes(aCreate.status) && /^[0-9a-f-]{36}$/.test(aCreate.json.id), JSON.stringify(aCreate.json));
check("names are case-insensitive, so a reset can't fork a second account",
  (await req("POST", "/api/users", { admin: true, body: { name: "ADA", password: "ada-long-password" } })).json.id === aCreate.json.id);
check("re-posting an existing name is a password reset, not a new user",
  (await req("POST", "/api/users", { admin: true, body: { name: "Ada", password: "ada-new-password-1" } })).json.created === false);

console.log("\n== login ==");
check("old password stops working after the reset",
  (await req("POST", "/api/login", { body: { name: "Ada", password: "ada-long-password" } })).status === 401);
const aLogin = await req("POST", "/api/login", { body: { name: "Ada", password: "ada-new-password-1" } });
const bLogin = await req("POST", "/api/login", { body: { name: "Bo", password: "bo-long-password1", label: "scheduled-search" } });
check("login returns a token and the user", aLogin.status === 200 && !!aLogin.json.token && aLogin.json.user.name === "Ada");
const A_TOK = aLogin.json.token, B_TOK = bLogin.json.token;
const wrongName = await req("POST", "/api/login", { body: { name: "nobody", password: "ada-new-password-1" } });
const wrongPass = await req("POST", "/api/login", { body: { name: "Ada", password: "wrong-password-xx" } });
check("unknown name and wrong password are indistinguishable",
  wrongName.status === 401 && wrongPass.status === 401 && wrongName.json.error === wrongPass.json.error);
check("a session token is not accepted as the admin token",
  (await req("POST", "/api/users", { token: A_TOK, body: { name: "sneaky", password: "aaaaaaaaaaaaa" } })).status === 401);

// Where a route sits decides who checks its token, and both lists above answer
// 401 to a session token, so only the table itself shows an operator route has
// stayed under the router's check rather than a handler's.
const routeTable = await import("./src/routes/index.js");
const routeListed = (list, method, path) => list.some(([m, p]) => m === method && String(p) === String(path));
check("provisioning an account and purging a search are admin routes, checked by the router",
  routeListed(routeTable.ADMIN_ROUTES, "POST", "/api/users") && routeListed(routeTable.ADMIN_ROUTES, "POST", "/api/purge"));
check("no public route is an operator route",
  !routeTable.PUBLIC_ROUTES.some(([, p]) => ["/api/users", "/api/purge", "/api/invites", "/api/tokens"].includes(String(p))));
check("no token at all is 401", (await req("GET", "/api/data")).status === 401);
check("a made-up token is 401", (await req("GET", "/api/data", { token: "not-a-real-token" })).status === 401);

console.log("\n== per-user config and data ==");
await req("POST", "/api/config", { token: A_TOK, body: {
  display_title: "Ada's Search", tracks: [{ key: "SWE", label: "Ada Eng", schedule_time: "08:00", role_search_line: "Backend roles", target_companies: ["Acme"] }] } });
await req("POST", "/api/config", { token: B_TOK, body: {
  display_title: "Bo's Search", tracks: [{ key: "SWE", label: "Bo Eng", schedule_time: "09:00", role_search_line: "Frontend roles", target_companies: ["Globex"] }] } });
const aCfg = await req("GET", "/api/config", { token: A_TOK });
const bCfg = await req("GET", "/api/config", { token: B_TOK });
check("two users can hold the same track key with different content",
  aCfg.json.tracks[0].label === "Ada Eng" && bCfg.json.tracks[0].label === "Bo Eng");
check("settings are per user",
  aCfg.json.settings.display_title === "Ada's Search" && bCfg.json.settings.display_title === "Bo's Search");

// A fresh url each run, so re-running against the same database still
// exercises "both users can insert this" rather than hitting the dedup.
const sharedUrl = `https://example.com/same-posting-${Date.now()}`;
await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", location: "Remote (U.S.)", url: sharedUrl }] } });
const bAdd = await req("POST", "/api/leads", { token: B_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", location: "Remote (U.S.)", url: sharedUrl }] } });
check("both users can track the same posting url independently", bAdd.json.added === 1, JSON.stringify(bAdd.json));
const aDupe = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", location: "Remote (U.S.)", url: sharedUrl }] } });
check("the same user re-posting the same url is deduped", aDupe.json.added === 0);

// The variant cases - a posting arriving under a URL that isn't byte-identical
// to the one already stored, such as a ?gh_jid= suffix or a slug. The UNIQUE
// constraint cannot see any of these.
const aVariant = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Senior Backend", url: `${sharedUrl}?gh_src=search-snippet` }] } });
check("a tracking parameter doesn't make it a new posting",
  aVariant.json.added === 0 && aVariant.json.duplicates === 1, JSON.stringify(aVariant.json));

// Two rows for one posting inside a single payload. INSERT OR IGNORE can't see
// this either, since the two urls differ as strings.
const reqUrl = `https://boards.example.com/jobs/${Date.now()}7104`;
const aBatch = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Staff Backend", url: reqUrl },
  { search: "SWE", company: "Acme", title: "Staff Backend", url: `${reqUrl}/senior-staff-backend-engineer` }] } });
check("one posting twice in one payload is inserted once",
  aBatch.json.added === 1 && aBatch.json.duplicates === 1, JSON.stringify(aBatch.json));

// The distinguishing case that stops the rule being "strip the query string":
// some boards give every posting an identical path and tell them apart only by
// a query param, so those must stay separate rows.
const sharedPath = `https://ats.example.com/careers/job/?jid=${Date.now()}`;
const aTwoJobs = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "One", url: `${sharedPath}1` },
  { search: "SWE", company: "Acme", title: "Two", url: `${sharedPath}2` }] } });
check("two postings sharing a path but not an id stay two leads",
  aTwoJobs.json.added === 2, JSON.stringify(aTwoJobs.json));

// The multi-user version of the variant case. Dedup matches "same posting",
// not "same string", and that lookup in db.js must only ever see the calling
// user's rows - so B posting a variant of a url A already tracks must still be
// a new lead for B.
// A url only A holds - `sharedUrl` above is deliberately tracked by BOTH
// users, so a variant of it is B's own duplicate and would pass this check
// while proving nothing about scoping.
const soloUrl = `https://example.com/a-only-${Date.now()}`;
await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Solo", url: soloUrl }] } });
const aSoloDupe = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Solo", url: `${soloUrl}?gh_src=search-snippet` }] } });
check("the variant is a duplicate for the user who holds the original",
  aSoloDupe.json.added === 0, JSON.stringify(aSoloDupe.json));
const bVariant = await req("POST", "/api/leads", { token: B_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Solo", url: `${soloUrl}?gh_src=search-snippet` }] } });
check("but is new for a user who does not - dedup never reaches across users",
  bVariant.json.added === 1, JSON.stringify(bVariant.json));

// Excluded companies are enforced by the API rather than left to a sentence in
// the prompt, which lets them through both as leads and as screened rows.
await req("POST", "/api/config", { token: A_TOK, body: {
  excluded_companies: ["Quillwork / Quill Industries", "Vela", "Q (formerly Quantex)"] } });
const exLead = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Vela", title: "MTS", url: `https://vela.example.com/careers/${Date.now()}` },
  { search: "SWE", company: "Acme", title: "Fine", url: `https://example.com/ok-${Date.now()}` }] } });
check("an excluded company is dropped and the rest of the batch still lands",
  exLead.json.added === 1 && exLead.json.excluded === 1, JSON.stringify(exLead.json));
// The alias case: the list entry carries two names, and the parenthetical one
// is how the live data actually spells it.
const exAlias = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Quill Industries (Quillwork)", title: "Eng", url: `https://example.com/qw-${Date.now()}` }] } });
check("an alias from the same list entry is excluded too",
  exAlias.json.added === 0 && exAlias.json.excluded === 1, JSON.stringify(exAlias.json));
// The short-alias rule. "Q (formerly Quantex)" yields the alias "q", and as a
// bare substring that would take out a large slice of any real board. It must
// only match a company named exactly "q". The second row is the token-boundary
// rule: "Vela" is on the list, "Velabyte" is a different company.
// Distinct req ids, not just distinct paths: canonicalUrl keys on the id when
// there is one, so two urls carrying the same number are one posting however
// their paths differ.
const shortStamp = Date.now();
const exShort = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Torque Interactive", title: "Eng", url: `https://example.com/jobs/${shortStamp}01` },
  { search: "SWE", company: "Velabyte", title: "Eng", url: `https://example.com/jobs/${shortStamp}02` }] } });
check("a short alias does not swallow every company containing that letter",
  exShort.json.added === 2 && exShort.json.excluded === 0, JSON.stringify(exShort.json));
// Exclusions are dropped WITHOUT a screened row - the opposite of every other
// rejected candidate. A screened row is a memo saying "considered and ruled
// out", and an exclusion is never considered.
const exScreened = await req("POST", "/api/screened", { token: A_TOK, body: { screened: [
  { search: "SWE", company: "Vela", url: `https://vela.example.com/careers/s-${Date.now()}`, reason: "excluded" }] } });
check("an excluded company leaves no screened row behind either",
  exScreened.json.added === 0 && exScreened.json.excluded === 1, JSON.stringify(exScreened.json));
// The self-renewing case: /api/coverage creates a row for any company handed
// to it, so an excluded one swept once would be served back every cycle.
const exSweep = await req("POST", "/api/coverage", { token: A_TOK, body: {
  search: "SWE", on: "2026-09-02", swept: [{ company: "Vela" }, { company: "Acme" }] } });
check("an excluded company cannot join the rotation",
  exSweep.json.recorded === 1 && exSweep.json.excluded === 1, JSON.stringify(exSweep.json));
check("and does not come back from the rotation afterwards",
  !(await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies
    .some((c) => c.company === "Vela"));
// The ordinary way an exclusion happens: the company is already in the
// rotation, and gets excluded later because a posting from it turned up. A
// guard on the write path alone would go on serving it forever.
await req("POST", "/api/config", { token: A_TOK, body: { excluded_companies: [] } });
await req("POST", "/api/coverage", { token: A_TOK, body: {
  search: "SWE", on: "", swept: [{ company: "Latecomer Ltd" }] } });
check("a company registered before it was excluded is in the rotation",
  (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies
    .some((c) => c.company === "Latecomer Ltd"));
await req("POST", "/api/config", { token: A_TOK, body: { excluded_companies: ["Latecomer Ltd"] } });
const afterEx = await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK });
check("excluding it afterwards stops it being handed to a run",
  !afterEx.json.companies.some((c) => c.company === "Latecomer Ltd"),
  JSON.stringify(afterEx.json.companies.map((c) => c.company).slice(0, 8)));
await req("POST", "/api/config", { token: A_TOK, body: { excluded_companies: [] } });

const screenedUrl = `https://example.com/screened-${Date.now()}`;
await req("POST", "/api/screened", { token: A_TOK, body: { screened: [{ search: "SWE", url: screenedUrl, reason: "out of scope" }] } });
const bScreened = await req("POST", "/api/screened", { token: B_TOK, body: { screened: [{ search: "SWE", url: screenedUrl, reason: "out of scope" }] } });
check("screened items dedup per user, not globally", bScreened.json.added === 1, JSON.stringify(bScreened.json));

const aData = await req("GET", "/api/data", { token: A_TOK });
const bData = await req("GET", "/api/data", { token: B_TOK });
// Counted by this run's own url rather than by table size, so a re-run
// against a database that still holds the last run's fixtures still means
// something.
const mine = (rows, url) => rows.filter((r) => r.url === url).length;
check("each user sees exactly their own copy of the shared posting",
  mine(aData.json.leads, sharedUrl) === 1 && mine(bData.json.leads, sharedUrl) === 1);
check("each user sees exactly their own screened item",
  mine(aData.json.screened, screenedUrl) === 1 && mine(bData.json.screened, screenedUrl) === 1);
check("/api/data reports who you are", aData.json.user.name === "Ada" && bData.json.user.name === "Bo");
const aLeadId = aData.json.leads.find((l) => l.url === sharedUrl).id;
const bLeadId = bData.json.leads.find((l) => l.url === sharedUrl).id;
check("their lead ids are genuinely different rows", aLeadId !== bLeadId);

console.log("\n== cross-user access ==");
check("B cannot read A's lead via status change",
  (await req("POST", `/api/leads/${aLeadId}/status`, { token: B_TOK, body: { status: "Applied" } })).status === 404);
check("B cannot update A's lead", (await req("POST", "/api/update", { token: B_TOK, body: { type: "lead", id: aLeadId, notes: "pwned" } })).status === 404);
await req("POST", `/api/leads/${aLeadId}/status`, { token: A_TOK, body: { status: "Applied" } });
const aApp = (await req("GET", "/api/data", { token: A_TOK })).json.applications.find((x) => x.leadId === String(aLeadId));
check("applying created A's application", !!aApp && aApp.company === "Acme");
// The lead's location has to survive becoming an application - it's the one
// carried-over field with no other source, since the lead it came from is a
// row whose posting is expected to die eventually.
check("A's application carried the lead's location",
  !!aApp && aApp.location === "Remote (U.S.)");
check("B cannot delete A's application",
  (await req("POST", "/api/delete-application", { token: B_TOK, body: { id: aApp.id } })).status === 404);
check("B cannot edit A's application through the generic update route",
  (await req("POST", "/api/update", { token: B_TOK, body: { type: "application", id: aApp.id, notes: "pwned" } })).status === 404);
check("B cannot change A's application status",
  (await req("POST", `/api/applications/${aApp.id}/status`, { token: B_TOK, body: { status: "Rejected" } })).status === 404);
const aAppAfter = (await req("GET", "/api/data", { token: A_TOK })).json.applications.find((x) => x.id === aApp.id);
check("A's application survived all of that",
  !!aAppAfter && aAppAfter.status === "Applied" && aAppAfter.notes !== "pwned");
check("B cannot fetch A's prompt for a key B also has (gets B's own)",
  (await req("GET", "/api/prompt/SWE", { token: B_TOK })).text.includes("Frontend roles"));
check("an unconfigured track key 404s",
  (await req("GET", "/api/prompt/NOPE", { token: A_TOK })).status === 404);

console.log("\n== the overnight application fill ==");
// Adding an application by pasting its URL, and the nightly run that reads the
// posting and fills the rest in. None of this is visible on the page, which is
// exactly why it needs checking here: what makes an invisible writer
// trustworthy is that it never overwrites what the person typed, that it can't
// reach another person's rows, and that every row it is handed leaves the
// queue - a row that doesn't is one it re-reads every night forever.
const urlApp = (await req("POST", "/api/update", { token: A_TOK, body: {
  type: "application", company: "", title: "", location: "", link: "https://example.com/jobs/9911",
} })).json.application;
check("a new application carries no fill state of its own",
  urlApp.autofill === "" && urlApp.autofill_note === "",
  JSON.stringify({ autofill: urlApp.autofill, note: urlApp.autofill_note }));

const aQueue = await req("GET", "/api/applications/pending", { token: A_TOK });
check("a URL-only application is picked up automatically, with the link and nothing else",
  aQueue.json.applications.some((x) => x.id === urlApp.id && x.link === urlApp.link) &&
  Object.keys(aQueue.json.applications[0]).sort().join() === "id,link",
  JSON.stringify(aQueue.json.applications));
// aApp came from a lead, so it already has company, title and location, and
// opening its posting could only confirm what is there.
check("an application that came from a lead is left alone - nothing to fill",
  !aQueue.json.applications.some((x) => x.id === aApp.id));
check("B's queue can't see A's row",
  !(await req("GET", "/api/applications/pending", { token: B_TOK }))
    .json.applications.some((x) => x.id === urlApp.id));
check("B cannot fill A's row",
  (await req("POST", "/api/applications/autofill", { token: B_TOK, body: {
    filled: [{ id: urlApp.id, company: "Pwned" }] } })).json.unmatched.length === 1);

// A day passes and the person fills the title in themselves before the run gets
// to it. The run's reading of the page must not win that.
await req("POST", "/api/update", { token: A_TOK, body: { type: "application", id: urlApp.id, title: "Staff Engineer" } });
const fillRes = await req("POST", "/api/applications/autofill", { token: A_TOK, body: {
  filled: [{ id: urlApp.id, company: "Initech", title: "SDE II", location: "Austin, TX", comp: "$1" }] } });
check("the fill is accepted", fillRes.json.filled === 1 && fillRes.json.unmatched.length === 0,
  JSON.stringify(fillRes.json));
const filled = (await req("GET", "/api/data", { token: A_TOK })).json.applications.find((x) => x.id === urlApp.id);
check("it wrote the fields that were empty",
  filled.company === "Initech" && filled.location === "Austin, TX" && filled.comp === "$1",
  JSON.stringify(filled));
check("it did not overwrite the one the person had typed",
  filled.title === "Staff Engineer", filled.title);
check("the row is flagged read, and gone from the queue",
  filled.autofill === "filled" &&
  !(await req("GET", "/api/applications/pending", { token: A_TOK }))
    .json.applications.some((x) => x.id === urlApp.id),
  filled.autofill);
check("reading it a second time changes nothing",
  (await req("POST", "/api/applications/autofill", { token: A_TOK, body: {
    filled: [{ id: urlApp.id, company: "Wrong" }] } })).json.unmatched.length === 1);

const deadApp = (await req("POST", "/api/update", { token: A_TOK, body: {
  type: "application", link: "https://example.com/jobs/gone" } })).json.application;
const failRes = await req("POST", "/api/applications/autofill", { token: A_TOK, body: {
  failed: [{ id: deadApp.id, reason: "posting has been taken down" }] } });
check("a posting that couldn't be read is recorded with its reason", failRes.json.failed === 1);
// Nothing displays that reason. It is what tells "the posting was gone" apart
// from "the nightly task stopped running" when someone asks later why a row is
// still blank.
const failed = (await req("GET", "/api/data", { token: A_TOK })).json.applications.find((x) => x.id === deadApp.id);
check("and that row is done - not retried on later nights",
  failed.autofill === "failed" && failed.autofill_note === "posting has been taken down" &&
  !(await req("GET", "/api/applications/pending", { token: A_TOK }))
    .json.applications.some((x) => x.id === deadApp.id),
  JSON.stringify({ autofill: failed.autofill, note: failed.autofill_note }));

// The partial read: a board that renders its description client-side still
// ships the role and employer in its metadata, so a run legitimately comes
// back with some fields and an explanation for the rest. That is a fill, not a
// failure - the fields are real - and the note is what tells the person why
// the row is still short.
const partApp = (await req("POST", "/api/update", { token: A_TOK, body: {
  type: "application", link: "https://example.com/jobs/jsonly" } })).json.application;
await req("POST", "/api/applications/autofill", { token: A_TOK, body: { filled: [{
  id: partApp.id, company: "Whatnot", title: "Engineering Manager",
  note: "the description needs JavaScript, so only the page metadata was readable" }] } });
const partial = (await req("GET", "/api/data", { token: A_TOK })).json.applications.find((x) => x.id === partApp.id);
check("a partial read keeps its fields, its note, and counts as read",
  partial.company === "Whatnot" && partial.title === "Engineering Manager" &&
  partial.location === "" && partial.autofill === "filled" &&
  /only the page metadata/.test(partial.autofill_note),
  JSON.stringify({ co: partial.company, loc: partial.location, flag: partial.autofill, note: partial.autofill_note }));

// A posting a run opened and got nothing usable out of still has to leave the
// queue. Refusing it would be tidier and would put that row back in every queue
// from then on, which is the one failure the flag exists to prevent.
const emptyApp = (await req("POST", "/api/update", { token: A_TOK, body: {
  type: "application", link: "https://example.com/jobs/blank" } })).json.application;
await req("POST", "/api/applications/autofill", { token: A_TOK, body: {
  filled: [{ id: emptyApp.id, company: "   " }] } });
check("a read that found nothing still marks the row read",
  !(await req("GET", "/api/applications/pending", { token: A_TOK }))
    .json.applications.some((x) => x.id === emptyApp.id));

// A row with no link would sit in the queue with nothing able to resolve it.
const linkless = (await req("POST", "/api/update", { token: A_TOK, body: {
  type: "application", company: "Typed in by hand" } })).json.application;
check("a row with no link is never queued - there is nothing to open",
  !(await req("GET", "/api/applications/pending", { token: A_TOK }))
    .json.applications.some((x) => x.id === linkless.id));
// Requeueing: the only way back into the queue, and the only route here that
// can undo the read flag. Same scoping rule as everything else - B naming A's
// id gets nothing, and is told nothing about whether it exists.
check("B cannot requeue A's row",
  (await req("POST", "/api/applications/requeue", { token: B_TOK, body: { ids: [deadApp.id] } }))
    .json.requeued === 0);
const requeued = await req("POST", "/api/applications/requeue", { token: A_TOK, body: { ids: [deadApp.id] } });
check("requeueing a failed row puts it back in the queue, note cleared",
  requeued.json.requeued === 1 &&
  (await req("GET", "/api/applications/pending", { token: A_TOK }))
    .json.applications.some((x) => x.id === deadApp.id) &&
  (await req("GET", "/api/data", { token: A_TOK })).json.applications
    .find((x) => x.id === deadApp.id).autofill_note === "",
  JSON.stringify(requeued.json));
check("requeueing nothing is a 400",
  (await req("POST", "/api/applications/requeue", { token: A_TOK, body: { ids: [] } })).status === 400);

check("an empty report is a 400, not a silent no-op",
  (await req("POST", "/api/applications/autofill", { token: A_TOK, body: {} })).status === 400);
const fillPrompt = await req("GET", "/api/prompt/_applications", { token: A_TOK });
check("the fill prompt is served as its own reserved key, not as a track",
  fillPrompt.status === 200 && fillPrompt.text.includes("/api/applications/pending"),
  fillPrompt.text.slice(0, 120));
check("the fill run reads each account's ranked places and files an area from them, copied as written",
  fillPrompt.text.includes("settings.priority_locations") && fillPrompt.text.includes('"area":"..."') &&
  fillPrompt.text.includes("copied as written") && fillPrompt.text.includes("area_cleared"));

console.log("\n== dedup endpoint (what every scheduled run fetches) ==");
const aDedup = await req("GET", "/api/dedup/SWE", { token: A_TOK });
check("returns this track's leads as {id, url, status} and nothing else",
  aDedup.status === 200 && aDedup.json.leads.every((l) => "id" in l && "url" in l && "status" in l && !("notes" in l)),
  JSON.stringify(aDedup.json).slice(0, 120));
check("screened comes back as bare urls, not whole rows",
  Array.isArray(aDedup.json.screened) && aDedup.json.screened.every((u) => typeof u === "string"));
check("it is substantially smaller than /api/data - the whole point",
  JSON.stringify(aDedup.json).length * 2 < JSON.stringify(aData.json).length);
check("B cannot read dedup data for a track key B doesn't have",
  (await req("GET", "/api/dedup/DATA", { token: B_TOK })).status === 404);
check("an unconfigured key 404s rather than returning an empty list",
  (await req("GET", "/api/dedup/GHOST", { token: A_TOK })).status === 404);

console.log("\n== dedup scoped to what a run can meet tonight ==");
// ?scope=batch trims screened[] to URLs at companies in the next two batches
// along the rotation, plus anything screened in the last few days. Its own
// account and a per-run track, so the cursor starts at 0 on every run.
const scopePw = "scope-long-password";
await req("POST", "/api/users", { admin: true, body: { name: "Scope", password: scopePw } });
const S_TOK = (await req("POST", "/api/login", { body: { name: "Scope", password: scopePw } })).json.token;
const scStamp = Date.now().toString(36);
const SC = "SC" + scStamp, SCF = SC + "F";
await req("POST", "/api/config", { token: S_TOK, body: { tracks: [
  { key: SC, label: "Scope", full_description: "the feeder", sort_order: 0 },
  { key: SCF, label: "Scope fed", full_description: "the fed tab", sort_order: 1, fed_by: SC } ] } });
// Companies of its own, enough that the far end of the list is always past the
// window. The list is shared and outlives a run, so on a database that has seen
// earlier runs it is long already - but on a freshly migrated one it can hold
// 48 companies or fewer, and then every company is inside the window.
await req("POST", "/api/coverage", { token: S_TOK, body: { search: SC, on: "",
  swept: Array.from({ length: 2 * 24 + 12 }, (_, i) => ({ company: `Scope Co ${scStamp}-${i}` })) } });
const scSlice = (await req("GET", `/api/coverage/${SC}`, { token: S_TOK })).json.companies;
const scAll = (await req("GET", `/api/coverage/${SC}?all=1`, { token: S_TOK })).json.companies;
const scUrl = (n) => `https://example.com/scope/${scStamp}/${n}`;
const scOld = "2026-01-01";
await req("POST", "/api/screened", { token: S_TOK, body: { screened: [
  { search: SC, url: scUrl("window-old"), company: scSlice[0].company, reason: "x", date: scOld },
  { search: SC, url: scUrl("far-old"), company: scAll[scAll.length - 1].company, reason: "x", date: scOld },
  { search: SC, url: scUrl("far-new"), company: scAll[scAll.length - 1].company, reason: "x" } ] } });

const scoped = await req("GET", `/api/dedup/${SC}?scope=batch`, { token: S_TOK });
const full = await req("GET", `/api/dedup/${SC}`, { token: S_TOK });
check("a scoped read keeps a screened url at a company in the window, however old it is",
  scoped.status === 200 && scoped.json.screened.includes(scUrl("window-old")), JSON.stringify(scoped.json && scoped.json.scope));
check("and a url screened in the last few days, wherever its company sits",
  scoped.json.screened.includes(scUrl("far-new")));
check("but drops an old url at a company outside the window",
  !scoped.json.screened.includes(scUrl("far-old")), JSON.stringify(scoped.json.screened));
check("scope says what it trimmed by",
  !!scoped.json.scope && scoped.json.scope.cursor === 0 &&
  scoped.json.scope.companies === Math.min(48, scAll.length) &&
  /^\d{4}-\d{2}-\d{2}$/.test(scoped.json.scope.since) &&
  scoped.json.scope.kept === scoped.json.screened.length && scoped.json.scope.of === full.json.screened.length,
  JSON.stringify(scoped.json.scope));
check("without the parameter the response is the whole list, shaped exactly as before",
  full.json.screened.includes(scUrl("far-old")) &&
  JSON.stringify(Object.keys(full.json)) === JSON.stringify(["leads", "screened"]),
  JSON.stringify(Object.keys(full.json)));
check("leads are never trimmed", JSON.stringify(scoped.json.leads) === JSON.stringify(full.json.leads));

// A fed tab's run reads the filling track's cursor, so the window comes from
// there. Moving only the feeder's cursor is what tells the two apart: the fed
// tab's own stays at 0.
const scRec = await req("POST", "/api/coverage", { token: S_TOK, body: { search: SC, on: "2026-09-10",
  swept: scSlice.map((c) => ({ company: c.company })) } });
const fedScoped = (await req("GET", `/api/dedup/${SCF}?scope=batch`, { token: S_TOK })).json;
check("a fed tab takes its window from the cursor of the track that fills it",
  scRec.json.cursor > 0 && !!fedScoped.scope && fedScoped.scope.cursor === scRec.json.cursor,
  JSON.stringify({ fed: fedScoped.scope, feeder: scRec.json.cursor }));

check("a scoped read of an unconfigured key still 404s",
  (await req("GET", "/api/dedup/GHOST?scope=batch", { token: S_TOK })).status === 404);
check("another account's scoped read of this track 404s",
  (await req("GET", `/api/dedup/${SC}?scope=batch`, { token: A_TOK })).status === 404);
const aScoped = (await req("GET", "/api/dedup/SWE?scope=batch", { token: A_TOK })).json;
check("and its own scoped read never carries this account's rows",
  !!aScoped.screened && !aScoped.screened.some((u) => u.startsWith(`https://example.com/scope/${scStamp}/`)));

console.log("\n== tonight's re-checks, chosen by the tracker ==");
// A feed group re-checks an even share of its open leads each night -
// min(20, ceil(open / 14)) - longest-unconfirmed first, New and Reviewing only.
// Its own account and per-run tracks, so nothing earlier in this file counts.
const rcPw = "recheck-long-password";
await req("POST", "/api/users", { admin: true, body: { name: "Recheck", password: rcPw } });
const RC_TOK = (await req("POST", "/api/login", { body: { name: "Recheck", password: rcPw } })).json.token;
const rcStamp = Date.now().toString(36);
const RC = "RC" + rcStamp, RCF = RC + "F", RCC = RC + "C";
await req("POST", "/api/config", { token: RC_TOK, body: { tracks: [
  { key: RC, label: "Recheck", full_description: "the feeder", sort_order: 0 },
  { key: RCF, label: "Recheck fed", full_description: "the fed tab", sort_order: 1, fed_by: RC },
  { key: RCC, label: "Recheck cap", full_description: "a large feed group", sort_order: 2 } ] } });
const rcUrl = (n) => `https://example.com/recheck/${rcStamp}/${n}`;
const rcToday = new Date().toISOString().slice(0, 10);
// Fifteen open leads, so a budget of ceil(15/14) = 2. Three are due; the second
// oldest sits on the fed tab and is Reviewing, and the third loses on date. Two
// older than all of them are Applied and Not a fit, so only their status keeps
// them out. The other twelve were confirmed today.
await req("POST", "/api/leads", { token: RC_TOK, body: { leads: [
  { search: RC, url: rcUrl("oldest"), company: "Rc A", title: "Engineer", verified: "2026-01-01" },
  { search: RCF, url: rcUrl("second"), company: "Rc B", title: "Engineer", verified: "2026-01-02" },
  { search: RC, url: rcUrl("third"), company: "Rc C", title: "Engineer", verified: "2026-01-03" },
  { search: RC, url: rcUrl("applied"), company: "Rc D", title: "Engineer", verified: "2025-12-01" },
  { search: RC, url: rcUrl("notafit"), company: "Rc E", title: "Engineer", verified: "2025-12-01" },
  ...Array.from({ length: 12 }, (_, i) => ({ search: RC, url: rcUrl(`fresh${i}`), company: `Rc F${i}`, title: "Engineer", verified: rcToday })),
] } });
const rcIdOf = Object.fromEntries([
  ...(await req("GET", `/api/dedup/${RC}`, { token: RC_TOK })).json.leads,
  ...(await req("GET", `/api/dedup/${RCF}`, { token: RC_TOK })).json.leads,
].map((l) => [l.url, l.id]));
const rcSetStatus = (n, status) => req("POST", `/api/leads/${rcIdOf[rcUrl(n)]}/status`, { token: RC_TOK, body: { status } });
await rcSetStatus("applied", "Applied");
await rcSetStatus("notafit", "Not a fit");
await rcSetStatus("second", "Reviewing");

const rcFeed = (await req("GET", `/api/dedup/${RC}?scope=batch`, { token: RC_TOK })).json;
const rcFed = (await req("GET", `/api/dedup/${RCF}?scope=batch`, { token: RC_TOK })).json;
const rcFlagged = [...rcFeed.leads, ...rcFed.leads].filter((l) => l.recheck).map((l) => l.url).sort();
check("the tracker flags the longest-unconfirmed open leads, up to the feed group's budget",
  JSON.stringify(rcFlagged) === JSON.stringify([rcUrl("oldest"), rcUrl("second")].sort()), JSON.stringify(rcFlagged));
check("the budget is an even share of the feed group's open leads over fourteen nights",
  !!rcFeed.scope && rcFeed.scope?.recheck?.eligible === 15 && rcFeed.scope?.recheck?.budget === 2 &&
  rcFeed.scope?.recheck?.after_days === 7, JSON.stringify(rcFeed.scope && rcFeed.scope.recheck));
check("each tab flags its own share of one group-wide choice",
  rcFeed.scope?.recheck?.flagged === 1 && rcFed.scope?.recheck?.flagged === 1 &&
  rcFed.scope?.recheck?.eligible === 15 && rcFed.scope?.recheck?.budget === 2,
  JSON.stringify({ feeder: rcFeed.scope?.recheck, fed: rcFed.scope?.recheck }));
check("an Applied or Not a fit lead is never flagged, however long since it was confirmed",
  !rcFeed.leads.some((l) => l.recheck && (l.url === rcUrl("applied") || l.url === rcUrl("notafit"))));
check("a lead confirmed within the week is not due",
  !rcFeed.leads.some((l) => l.recheck && l.url.includes("/fresh")));
const rcPlain = (await req("GET", `/api/dedup/${RC}`, { token: RC_TOK })).json;
check("an unscoped read carries no re-check flags",
  !rcPlain.leads.some((l) => "recheck" in l) && !("scope" in rcPlain));

// Confirming a flagged lead live sends it to the back of the queue.
await req("POST", "/api/verified", { token: RC_TOK, body: { search: RC, urls: [rcUrl("oldest")] } });
const rcAfter = (await req("GET", `/api/dedup/${RC}?scope=batch`, { token: RC_TOK })).json;
check("a lead confirmed live gives its place to the next one due",
  !rcAfter.leads.find((l) => l.url === rcUrl("oldest")).recheck &&
  !!rcAfter.leads.find((l) => l.url === rcUrl("third")).recheck,
  JSON.stringify(rcAfter.leads.filter((l) => l.recheck).map((l) => l.url)));

// Past 280 open leads the budget stops at the cap, and the cycle stretches.
for (let i = 0; i < 281; i += 90) {
  await req("POST", "/api/leads", { token: RC_TOK, body: { leads: Array.from({ length: Math.min(90, 281 - i) }, (_, j) => ({
    search: RCC, url: rcUrl(`cap${i + j}`), company: `Rc Cap ${i + j}`, title: "Engineer", verified: "2026-01-01" })) } });
}
const rcCap = (await req("GET", `/api/dedup/${RCC}?scope=batch`, { token: RC_TOK })).json;
check("past 280 open leads a run's re-checks stop at twenty",
  !!rcCap.scope && rcCap.scope?.recheck?.eligible === 281 && rcCap.scope?.recheck?.budget === 20 &&
  rcCap.leads.filter((l) => l.recheck).length === 20, JSON.stringify(rcCap.scope && rcCap.scope.recheck));
check("another account cannot read this feed group's re-check choice",
  (await req("GET", `/api/dedup/${RC}?scope=batch`, { token: A_TOK })).status === 404);

console.log("\n== runs ==");
check("recording a run works for your own track",
  (await req("POST", "/api/runs", { token: A_TOK, body: { search: "SWE", status: "ok", leadsAdded: 1, on: "2026-08-31", note: "ok" } })).status === 200);
const aAfterRun = await req("GET", "/api/config", { token: A_TOK });
const bAfterRun = await req("GET", "/api/config", { token: B_TOK });
check("A's run is recorded against A only",
  aAfterRun.json.tracks[0].last_run.note === "ok" && bAfterRun.json.tracks[0].last_run.note === "");
check("a track key nobody configured 404s",
  (await req("POST", "/api/runs", { token: A_TOK, body: { search: "GHOST", on: "2026-08-31" } })).status === 404);

// A later stamp must not wipe a board an earlier run confirmed.
console.log("\n== company coverage ==");
check("an unconfigured track key 404s rather than reading as 'never swept'",
  (await req("GET", "/api/coverage/GHOST", { token: A_TOK })).status === 404);
check("a track with no rows yet is an empty list, not an error",
  (await req("GET", "/api/coverage/SWE", { token: B_TOK })).status === 200 &&
  Array.isArray((await req("GET", "/api/coverage/SWE", { token: B_TOK })).json.companies));
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "2026-08-20",
  swept: [{ company: "Acme", board: "greenhouse" }, { company: "Globex" }] } });
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "2026-08-28",
  swept: [{ company: "Acme", note: "blocked" }] } });
// By name, not by index: this file is re-run against a database that still
// holds the last run's fixtures, and later checks add rows of their own.
// ?all=1: these two are about what the table holds, not about the slice a run
// is handed, and the default response is capped.
const cov = (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies;
const at = (name) => cov.findIndex((c) => c.company === name);
check("the table comes back in log order, whatever the sweep dates say",
  cov.every((c, i) => i === 0 || c.position > cov[i - 1].position),
  JSON.stringify(cov.map((c) => `${c.company}@${c.position}:${c.last_swept || "never"}`).slice(0, 5)));
const acme = cov[at("Acme")];
check("a later stamp keeps the board an earlier run confirmed",
  acme.board === "greenhouse" && acme.last_swept === "2026-08-28" && acme.note === "blocked",
  JSON.stringify(acme));
// Named for this run. The list is shared and outlives a run, so a fixed name
// would already be on it - and a company already on the list keeps its place.
const newcomer = `Initech ${Date.now().toString(36)}`;
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "",
  swept: [{ company: "Acme" }, { company: newcomer }] } });
const seeded = (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies;
check("registering with an empty date doesn't overwrite a real sweep",
  seeded.find((c) => c.company === "Acme").last_swept === "2026-08-28");

// `on: ""` claims no sweep. It does not mean the row says nothing: what the
// caller established about reaching the company is a fact about a website, and
// the shared list is what that is for. Dropping it silently is what left NFL
// and Fetch on the live list carrying nothing, with the Greenhouse token that
// reaches NFL's jobs sitting in one search's private note.
const undatedCo = `Undated Co ${Date.now().toString(36)}`;
const cursorBefore = (await req("GET", "/api/coverage/SWE", { token: A_TOK })).json.cursor;
const undated = await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "",
  swept: [{ company: undatedCo, board: "greenhouse", endpoint: "undated.example/careers/jobs" }] } });
const undatedRow = (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies
  .find((c) => c.company === undatedCo);
check("an undated write still shares what the row says about the website",
  undated.json.shared === 1 && !!undatedRow && !!undatedRow.known &&
  undatedRow.known.board === "greenhouse" && undatedRow.known.endpoint === "undated.example/careers/jobs",
  JSON.stringify({ shared: undated.json.shared, row: undatedRow }));
check("but it claims no sweep and moves no cursor",
  !!undatedRow && undatedRow.last_swept === "" && undated.json.cursor === cursorBefore,
  JSON.stringify({ last_swept: undatedRow && undatedRow.last_swept, cursor: undated.json.cursor, before: cursorBefore }));
const undatedWall = await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "",
  swept: [{ company: undatedCo, wall: "403 on a plain fetch" }] } });
const stillNoWall = (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json.companies
  .find((c) => c.company === undatedCo);
check("a wall without a date is refused, because a wall is dated evidence",
  undatedWall.status === 400 && /wall/i.test((undatedWall.json && undatedWall.json.error) || "") &&
  !!stillNoWall && !!stillNoWall.known && stillNoWall.known.wall === undefined,
  JSON.stringify({ status: undatedWall.status, error: undatedWall.json && undatedWall.json.error }));
// Asserted against the log as it was before the append, not against the end of
// the list: later blocks in this file add companies of their own, so "last
// overall" is a fact about the whole run rather than about where a new company
// joins.
check("a newly registered company joins past everything already in the log",
  seeded.find((c) => c.company === newcomer).position > Math.max(...cov.map((c) => c.position)),
  JSON.stringify({
    newcomer: seeded.find((c) => c.company === newcomer).position,
    highestBefore: Math.max(...cov.map((c) => c.position)),
  }));
check("recording against a track you don't have 404s",
  (await req("POST", "/api/coverage", { token: A_TOK, body: { search: "GHOST", swept: [{ company: "Acme" }] } })).status === 404);
check("an empty sweep list is refused rather than stamping nothing",
  (await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", swept: [] } })).status === 400);
// One list for every search (0011_one_company_list.sql). What B shares with A
// is membership: a company A put on the list is on B's too. What B must never
// see is A's record of it - when A last tried it, and what A noted there. A's
// Acme was swept on 2026-08-28 and noted "blocked" just above; B has never
// swept anything.
const bList = (await req("GET", "/api/coverage/SWE?all=1", { token: B_TOK })).json.companies;
const bAcme = bList.find((c) => c.company.toLowerCase() === "acme");
check("a company one account puts on the list is on every account's list",
  !!bAcme, JSON.stringify(bList.slice(0, 5).map((c) => c.company)));
check("but another account's sweep date for it does not travel",
  !!bAcme && bAcme.last_swept === "", JSON.stringify(bAcme));
check("nor does another account's note",
  !!bAcme && bAcme.note === "", JSON.stringify(bAcme));
check("every track gets the rotation steps",
  (await req("GET", "/api/prompt/SWE", { token: A_TOK })).text.includes("1c. Get this run's companies")
  && (await req("GET", "/api/prompt/SWE", { token: B_TOK })).text.includes("1c. Get this run's companies"));
// ...and not because the list happens to be non-empty. There is no gate. A
// deployment whose shared list is empty - one that never seeded any companies -
// still gets 1c, 9d and 9e, because 9d is the only step that adds a company and
// a gate withholding it until one existed could never open. The shared list is
// never empty by this point in the script, so this composes the prompt directly
// instead of asking the API.
const { buildSearchPrompt } = await import("./src/prompt.js");
const bareSteps = buildSearchPrompt({
  user: { id: "u", name: "Nobody" },
  track: { key: "T", label: "T", full_description: "t", target_companies: "[]", role_search_line: "r", resume_line: "x" },
  settings: {},
  feeds: [],
});
const listed = buildSearchPrompt({
  user: { id: "u", name: "Nobody" },
  track: { key: "T", label: "T", full_description: "t", target_companies: '["Zyqfold Robotics","Quennet Labs"]', role_search_line: "r", resume_line: "x" },
  settings: {},
  feeds: [],
});
{
  const promptFor = (track) =>
    buildSearchPrompt({
      user: { id: "u", name: "Nobody" },
      track: { key: "T", label: "T", full_description: "t", role_search_line: "r", ...track },
      settings: {},
      feeds: [],
    });
  const stepOf = (text, n) => text.split("\n").find((l) => l.startsWith(`${n}. `)) || "";

  const chosen = promptFor({ documents: JSON.stringify(["resumes/Chosen_Resume.txt"]), resume_line: "Frame it as an IC engineer." });
  check("the prompt reads the resume its documents list names, with resume_line as framing only",
    stepOf(chosen, "2").includes("`resumes/Chosen_Resume.txt`") && stepOf(chosen, "2").includes("Frame it as an IC engineer."));
  check("a search whose profile is current is not asked to rewrite it", !stepOf(chosen, "2b"));

  const stale = promptFor({
    documents: JSON.stringify(["resumes/New_Resume.txt"]),
    profile_stale_since: "2026-09-16T20:00:00Z",
    resume_was: "resumes/Old_Resume.pdf",
    doc_file: "docs/tracked_T_postings.md",
  });
  const refresh = stepOf(stale, "2b");
  check("a search with a stale profile rewrites it before searching, naming the resume it was written from",
    refresh.includes("`resumes/Old_Resume.pdf`") && refresh.includes("## Candidate Profile") && refresh.includes("docs/tracked_T_postings.md"));
  check("and is told no other doc edit survives that night",
    refresh.includes("Change nothing else in the doc tonight") && stale.indexOf("2b. ") < stale.indexOf("\n3. "));

  const fromReference = promptFor({ documents: JSON.stringify(["resumes/Word_Resume.docx", "reference/Text_Copy.txt"]) });
  check("a list with no readable resume under resumes/ still names the readable copy it has",
    stepOf(fromReference, "2").includes("`reference/Text_Copy.txt`") && !stepOf(fromReference, "2").includes(".docx"));

  const legacy = promptFor({ documents: JSON.stringify(["resumes/Only.docx"]), resume_line: "Read the resume: `resumes/Only.docx`." });
  check("a list with nothing readable leaves resume_line as it was, rather than naming nothing",
    stepOf(legacy, "2") === "2. Read the resume: `resumes/Only.docx`.");
}

{
  const plain = buildSearchPrompt({
    user: { id: "u", name: "Nobody" },
    track: { key: "T", label: "T", full_description: "t", role_search_line: "r" },
    settings: {},
    feeds: [],
  });
  const docStep = plain.split("\n").find((l) => l.startsWith("8b. ")) || "";
  check("the default doc-update step sends a fit or scope refinement to the report, not the doc",
    docStep.includes("is not a doc edit") && docStep.includes("step-10 report") && !/update the relevant section/.test(docStep));
  check("with no budget passed, step 8b states the default doc budget",
    docStep.includes("Add at most 1000 bytes to the doc in this run"));
  const withOverride = buildSearchPrompt({
    user: { id: "u", name: "Nobody" },
    track: { key: "T", label: "T", full_description: "t", role_search_line: "r", doc_update_line: "Custom doc rule." },
    settings: {},
    feeds: [],
    docBudget: 1234,
  });
  const overrideStep = withOverride.split("\n").find((l) => l.startsWith("8b. ")) || "";
  check("a track's own doc-update line still carries the budget it was given",
    overrideStep.startsWith("8b. Custom doc rule. Add at most 1234 bytes"));
  check("and asks for a doc stated as it stands, not dated notes",
    docStep.includes("correct a line in place") && docStep.includes("dated note"));
}

// ---- A lead's area: one of the places ranked first, copied exactly.
{
  const syncStep = (settings) => {
    const p = buildSearchPrompt({
      user: { id: "u", name: "Nobody" },
      track: { key: "T", label: "T", full_description: "t", role_search_line: "r" },
      settings,
      feeds: [],
    });
    return p.slice(p.indexOf("9. SYNC"), p.indexOf("\n9b."));
  };
  const withRanked = syncStep({ priority_locations: "Seattle area, Portland OR, Remote US" });
  check("step 9 asks for an area copied exactly from the ranked list, as typed",
    withRanked.includes("comp, area}") && withRanked.includes('one entry from "Seattle area, Portland OR, Remote US"') &&
    withRanked.includes("copied as written") && withRanked.includes("leave it out when the posting falls in none"));
  check("a person with nothing ranked is asked for no area",
    !/area/.test(syncStep({ priority_locations: "" })) && !/area/.test(syncStep({})));
}

// ---- Where a search looks comes from the three location lists.
//
// Printed as typed, with the order they combine in fixed by the prompt - the
// scope prose they replace is never read, so a stale copy of it can't steer a
// run.
{
  const trackOf = { key: "T", label: "T", full_description: "t", role_search_line: "r" };
  const compose = (settings) =>
    buildSearchPrompt({ user: { id: "u", name: "Nobody" }, track: trackOf, settings, feeds: [] });
  const stepOf5 = (p) => p.slice(p.indexOf("\n5. "), p.indexOf("\n6. "));
  const full = compose({
    priority_locations: "Seattle, Portland, OR",
    search_locations: "US, Greater Toronto area",
    excluded_locations: "Texas",
    location_note: "Open to relocating for the right team.",
  });
  const five = stepOf5(full);
  check("step 5 prints each location list exactly as typed",
    five.includes("always searched:** Seattle, Portland, OR") && five.includes("Also searched:** US, Greater Toronto area") &&
    five.includes("Ruled out:** Texas") && five.includes("Open to relocating for the right team."));
  check("and states the fixed order: wanted first, then ruled out, then searched",
    /wanted first always qualifies.*ruled out is out.*searched place qualifies; anywhere else is out/.test(five));
  check("and the fixed remote and relocation rules, deferring to the person's own note",
    five.includes("A remote role qualifies when it is open to someone in a place that qualifies") &&
    five.includes("unless Nobody's own words above say so"));
  check("step 7 sends location back to step 5 rather than restating it",
    full.includes("somewhere step 5 says qualifies") && full.includes("a location step 5 rules out"));
  const stale = compose({ geo_scope_line: "Only Tacoma.", scope_clause: "in Tacoma", scope_disqualifier: "outside Tacoma", location_guidance: "Old guidance." });
  check("the old scope prose and location guidance are never read",
    !/Tacoma|Old guidance/.test(stale) && stale.includes("no locations are set for this search"));
  check("with no lists, location screens nothing out", !stale.includes("step 5 rules out"));
  check("with only rule-outs, everywhere else qualifies",
    stepOf5(compose({ excluded_locations: "Texas" })).includes("anywhere else qualifies"));

  // Every form the page's tier matcher is tested over has to be one the prompt
  // teaches, or a run writes locations the page can't rank.
  const { readFileSync } = await import("node:fs");
  const formsPath = new URL("../client/src/domain/location-forms.json", import.meta.url);
  let forms = null;
  try { forms = JSON.parse(readFileSync(formsPath, "utf8")); } catch { forms = null; }
  const written = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") { if (typeof v.written === "string") written.push(v.written); Object.values(v).forEach(walk); }
  };
  walk(forms);
  const formOf = (w) =>
    w.includes("; ") ? "; " : /^Remote \(/.test(w) ? "Remote (" : /, [A-Z]{2}$/.test(w) ? "City, ST" : /, [A-Z][a-z]/.test(w) ? "City, Country" : null;
  const untaught = [...new Set(written)].filter((w) => !formOf(w) || !stepOf6(full).includes(formOf(w)));
  check("client/src/domain/location-forms.json exists and lists the forms runs write",
    written.length > 0, String(formsPath));
  check("every form in it is one step 6 teaches", untaught.length === 0, untaught.join(" | "));
}
function stepOf6(p) {
  return (p.split("\n").find((l) => l.startsWith("6. ")) || "");
}

check("a company list stored on a track never reaches the prompt",
  !listed.includes("Zyqfold Robotics") && !listed.includes("Quennet Labs") && !listed.includes("drawn from"));
check("the default doc-update step never asks a run to keep company groups",
  !/expanded net|"core"/i.test(listed));
check("a deployment with an empty company list still gets every rotation step",
  bareSteps.includes("1c. Get this run's companies")
  && bareSteps.includes("9d. RECORD WHAT YOU COVERED")
  && bareSteps.includes("9e. REPLACE THE COMPANIES YOU COULDN'T READ"));

// The runner passes the doc budget it enforces; the route must print it, and
// must never fail a night's prompt over a bad value.
const budgetStep = (t) => t.split("\n").find((l) => l.startsWith("8b. ")) || "";
check("GET /api/prompt passes ?doc_budget into step 8b",
  budgetStep((await req("GET", "/api/prompt/SWE?doc_budget=1000", { token: A_TOK })).text).includes("at most 1000 bytes")
  && budgetStep((await req("GET", "/api/prompt/SWE?doc_budget=2500", { token: A_TOK })).text).includes("at most 2500 bytes"));
check("a doc_budget that isn't a whole number in range falls back to the default rather than failing the request",
  (await Promise.all(["abc", "-5", "12.5", "50", "99999", ""].map((v) =>
    req("GET", `/api/prompt/SWE?doc_budget=${encodeURIComponent(v)}`, { token: A_TOK }))))
    .every((r) => r.status === 200 && budgetStep(r.text).includes("at most 1000 bytes")));

// ---- Every call the nightly run has to make, still reachable from the text.
//
// A prompt that loses a step does not error - it produces a quieter search.
// A run that never learns to record its sweeps covers the same twelve
// companies every night; one that never learns step 9c looks, on the page,
// exactly like a search that stopped firing. Both are invisible until someone
// notices weeks of nothing, which is why the shape of the prompt is asserted
// here rather than left to a reading of the diff.
//
// Commands rather than endpoints: the run reaches /api/leads by invoking
// `./tracker leads` (scripts/tracker.ps1), so that is what has to survive an
// edit. Every prompt carries the rotation pair too.
const sweSteps = (await req("GET", "/api/prompt/SWE", { token: A_TOK })).text;
const boSteps = (await req("GET", "/api/prompt/SWE", { token: B_TOK })).text;
for (const cmd of [
  "./tracker dedup",
  "./tracker verified live.json",
  "./tracker delist dead.json",
  "./tracker leads leads.json",
  "./tracker screened screened.json",
  "./tracker run --status ok",
  "./tracker companies",
  "./tracker known",
  "./tracker swept swept.json",
]) {
  check(`the prompt still reaches the tracker via \`${cmd}\``, sweSteps.includes(cmd));
}
check("the prompt says where the helper is and how to run it if the shim won't execute",
  sweSteps.includes("-File tracker.ps1"));
// The one instruction a shorter prompt is most tempting to soften, and the
// premise everything else rests on: a search-snippet URL is not a finding.
check("step 4 still requires every candidate URL to be opened and confirmed",
  /MANDATORY VERIFICATION: fetch every candidate URL directly and confirm it renders an actual job description/
    .test(sweSteps) && /A search-snippet URL is a lead, not a finding, until opened and confirmed/.test(sweSteps));
// There is no track without a rotation: B has never swept a company and still
// gets both commands. Gating them on a track's own rows would leave a track
// with none unable to ever start.
check("a track that has never swept anything still gets both rotation commands",
  boSteps.includes("./tracker companies") && boSteps.includes("./tracker swept"));
// Step 9d has to name every field a run can send, or the field reaches no run.
// `wall` is the one whose absence costs most: an obstacle with nowhere shared
// to go is rediscovered by every search.
check("step 9d names every field a sweep can carry, wall included",
  sweSteps.includes("{company, board, endpoint, url_shape, wall, note}"));
// A reported board or endpoint clears a company's wall for every search
// (companies.js upsertCompanyFetch, `works`), and companies.json hands every run the
// board it already knows. tracker.ps1 drops those fields from a row that also
// reports a wall, but a failed fetch with no wall recorded is caught by one
// sentence only - this one. Without it, echoing a known board on a night the
// fetch failed deletes a true wall, and nothing downstream can tell.
check("step 9d forbids echoing a known board or endpoint back from companies.json",
  /Never copy `board`, `endpoint` or `url_shape` out of `companies\.json`/.test(sweSteps));
// The cap has to hold on a freshly seeded list, where every row is
// never-swept, and it has to be the *server's* cap, not one the prompt describes.
// Seeded as A, never as B - B is the account that has never swept anything.
// Company names are unique per run, and there are enough of them that stamping
// one batch still leaves a full batch of never-swept behind: that's what makes
// the last check below true on a re-run against a database that kept the last
// run's rows.
const runId = Date.now().toString(36);
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "", swept:
  Array.from({ length: 40 }, (_, i) => ({ company: `Co-${runId}-${String(i).padStart(2, "0")}` })) } });
const due = (await req("GET", "/api/coverage/SWE", { token: A_TOK })).json;
const all = (await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK })).json;
// COVERAGE_BATCH in routes/coverage.js.
check("a run is handed a capped slice, not the whole list",
  due.companies.length === 24 && due.batch === 24 && due.total > 24,
  JSON.stringify({ n: due.companies.length, total: due.total, batch: due.batch }));
check("?all=1 returns the whole table, for seeding and for looking",
  all.companies.length === all.total && all.total === due.total);
const positions = all.companies.map((c) => c.position);
check("the log is a dense sequence, so the cursor cannot skip or repeat",
  new Set(positions).size === positions.length &&
  positions.every((p, i) => i === 0 || p > positions[i - 1]),
  JSON.stringify(positions.slice(0, 15)));
// ?all=1 looks up the shared facts for every company it returns, and D1 refuses
// a statement with more than 100 bound parameters, so the read has to chunk.
// Put this run past the cap first.
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: "", swept:
  Array.from({ length: 100 }, (_, i) => ({ company: `Wide-${runId}-${String(i).padStart(3, "0")}` })) } });
const wide = await req("GET", "/api/coverage/SWE?all=1", { token: A_TOK });
check("the whole list reads back past D1's 100-parameter cap",
  wide.status === 200 && wide.json.total > 100 && wide.json.companies.length === wide.json.total,
  JSON.stringify({ status: wide.status, total: wide.json && wide.json.total }));
const today = "2026-09-01";
await req("POST", "/api/coverage", { token: A_TOK, body: { search: "SWE", on: today,
  swept: due.companies.map((c) => ({ company: c.company })) } });
const next = (await req("GET", "/api/coverage/SWE", { token: A_TOK })).json.companies;
check("what a run covers goes to the back of the queue, not round again",
  next.every((c) => c.last_swept !== today),
  JSON.stringify(next.map((c) => `${c.company}:${c.last_swept}`).slice(0, 4)));

console.log("\n== the rotation is a log with a cursor ==");
// Why selection is by position and cursor: migrations/0008_sweep_cursor.sql.
await req("POST", "/api/users", { admin: true, body: { name: "Cursor", password: "cursor-long-password" } });
const C_TOK = (await req("POST", "/api/login", { body: { name: "Cursor", password: "cursor-long-password" } })).json.token;
// A per-run track: these rows persist, and re-running against the same
// database would otherwise leave the cursor and the log length carrying over
// from the last run, which is exactly what the assertions below are about.
const rotN = 14, rotStamp = Date.now(), ROT = "ROT" + rotStamp;
await req("POST", "/api/config", { token: C_TOK, body: { tracks: [{ key: ROT, label: "Rot" }] } });
await req("POST", "/api/coverage", { token: C_TOK, body: { search: ROT, on: "",
  swept: Array.from({ length: rotN }, (_, i) => ({ company: `Rot ${rotStamp}-${String(i).padStart(2, "0")}` })) } });

// Seeding order must not become cycle order. A seeded list is written by a
// person and is nearly always alphabetical, so positions in arrival order would
// put the same tail last every cycle.
const seedOrder = (await req("GET", `/api/coverage/${ROT}?all=1`, { token: C_TOK })).json.companies;
// The list is shared, so this track's ?all=1 holds every company on it; the
// fourteen seeded here are the ones named for this run.
const seededHere = seedOrder.filter((c) => c.company.startsWith(`Rot ${rotStamp}-`));
check("a seeded list is shuffled, not stored in the order it was posted",
  seededHere.map((c) => c.company).join() !==
  Array.from({ length: rotN }, (_, i) => `Rot ${rotStamp}-${String(i).padStart(2, "0")}`).join(),
  JSON.stringify(seededHere.map((c) => c.company.split("-").pop()).join(",")));
check("but every seeded company is present exactly once",
  seededHere.length === rotN && new Set(seededHere.map((c) => c.position)).size === rotN,
  JSON.stringify({ found: seededHere.length, of: rotN }));

const c0 = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json;
check("seeding registers companies without moving the cursor",
  c0.cursor === 0 && c0.total >= rotN, JSON.stringify({ cursor: c0.cursor, total: c0.total }));
const day = "2026-09-11";
const rec1 = await req("POST", "/api/coverage", { token: C_TOK, body: { search: ROT, on: day,
  swept: c0.companies.map((c) => ({ company: c.company })) } });
check("recording a slice advances the cursor past it",
  rec1.json.cursor === Math.max(...c0.companies.map((c) => c.position)) + 1,
  JSON.stringify({ cursor: rec1.json.cursor, highestInSlice: Math.max(...c0.companies.map((c) => c.position)) }));

// The replacement case: a run reading again after recording its slice.
const c1 = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json;
check("reading again continues along the log instead of round again",
  c1.companies.every((c) => !c0.companies.some((p) => p.company === c.company)) === false ||
  c1.companies[0].company !== c0.companies[0].company,
  JSON.stringify({ firstBefore: c0.companies[0].company, firstAfter: c1.companies[0].company }));
check("and the two companies left in this cycle come first",
  c1.companies.slice(0, 2).every((c) => !c0.companies.some((p) => p.company === c.company)),
  JSON.stringify(c1.companies.slice(0, 3).map((c) => c.company)));

// Wrapping: everything is reached once before anything is reached twice.
await req("POST", "/api/coverage", { token: C_TOK, body: { search: ROT, on: day,
  swept: c1.companies.slice(0, 2).map((c) => ({ company: c.company })) } });
const c2 = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json;
// Walk a whole cycle of the shared list the way nightly runs do: read a slice,
// record all of it, repeat, noting each company the first time it is served. Every company must be reached before any is served a
// second time - including across the slice that runs off the end of the log
// and back round to the front, which a real rotation hits once every cycle.
const cycleTotal = (await req("GET", `/api/coverage/${ROT}?all=1`, { token: C_TOK })).json.total;
const reached = new Set();
let servedTwiceEarly = 0;
// Enough slices to walk the whole list, plus room for the wrap, rather than a
// flat count: the list is shared and a local database that has been verified
// against for a while holds thousands of companies, which a fixed 200 slices
// cannot reach - and the check would then report a broken rotation when what
// ran out was the loop.
const cycleSlices = Math.ceil(cycleTotal / 24) + 5;
for (let guard = 0; guard < cycleSlices && reached.size < cycleTotal; guard++) {
  const s = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json;
  for (const c of s.companies) {
    if (reached.size === cycleTotal) break;
    if (reached.has(c.company)) servedTwiceEarly++;
    reached.add(c.company);
  }
  await req("POST", "/api/coverage", { token: C_TOK, body: { search: ROT, on: day,
    swept: s.companies.map((c) => ({ company: c.company })) } });
}
// Wrapping happens at the read, not the write: record the company furthest
// along the log and the cursor is left past its end; the next read finds
// nothing at or after it and starts again at the front.
const whole = (await req("GET", `/api/coverage/${ROT}?all=1`, { token: C_TOK })).json.companies;
const furthest = whole.reduce((a, c) => (c.position > a.position ? c : a));
// Only a served company moves the cursor, so read along to the slice holding
// the end of the log and record it up to that company.
let endSlice = [];
for (let guard = 0; guard < cycleSlices; guard++) {
  endSlice = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json.companies;
  if (endSlice.some((c) => c.company === furthest.company)) break;
  await req("POST", "/api/coverage", { token: C_TOK, body: { search: ROT, on: day,
    swept: endSlice.map((c) => ({ company: c.company })) } });
}
const pastEnd = await req("POST", "/api/coverage", { token: C_TOK, body: { search: ROT, on: day,
  swept: endSlice.slice(0, endSlice.findIndex((c) => c.company === furthest.company) + 1)
    .map((c) => ({ company: c.company })) } });
const fromFront = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json;
check("once past the end, the next slice starts again at the front of the log",
  pastEnd.json.cursor > furthest.position &&
  fromFront.companies[0].position === Math.min(...whole.map((c) => c.position)),
  JSON.stringify({ cursor: pastEnd.json.cursor, furthest: furthest.position, firstServed: fromFront.companies[0].position }));
check("and a full cycle reached every company before repeating any",
  reached.size === cycleTotal && servedTwiceEarly === 0,
  JSON.stringify({ reached: reached.size, of: cycleTotal, servedTwiceEarly }));

// Resilience: a run that dies before reporting must not skip its slice.
const before = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json;
const again = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json;
check("reading never moves the cursor, so a run that dies re-reads its slice",
  before.cursor === again.cursor &&
  JSON.stringify(before.companies.map((c) => c.company)) === JSON.stringify(again.companies.map((c) => c.company)));

// The cursor is a position, not an index into the filtered list. Those differ
// the moment a company is excluded: with position 0 excluded, eligible[4] is
// position 5, so reading a cursor of 4 as an index steps over position 4. The
// skip needs the excluded company before the cursor, so that is where it goes.
const EX = ROT + "X";
await req("POST", "/api/config", { token: C_TOK, body: {
  tracks: [{ key: ROT, label: "Rot" }, { key: EX, label: "Ex" }], excluded_companies: [] } });
await req("POST", "/api/coverage", { token: C_TOK, body: { search: EX, on: "",
  swept: Array.from({ length: 10 }, (_, i) => ({ company: `Ex ${rotStamp}-${i}` })) } });
const exLog = (await req("GET", `/api/coverage/${EX}?all=1`, { token: C_TOK })).json.companies;
const victim = exLog.find((c) => c.position === 0).company;
await req("POST", "/api/config", { token: C_TOK, body: { excluded_companies: [victim] } });
const exSlice = (await req("GET", `/api/coverage/${EX}`, { token: C_TOK })).json.companies.slice(0, 3);
await req("POST", "/api/coverage", { token: C_TOK, body: { search: EX, on: day,
  swept: exSlice.map((c) => ({ company: c.company })) } });
const exNext = (await req("GET", `/api/coverage/${EX}`, { token: C_TOK })).json.companies;
const highestSwept = Math.max(...exSlice.map((c) => c.position));
const shouldBeNext = exLog
  .filter((c) => c.company !== victim && c.position > highestSwept)
  .sort((a, b) => a.position - b.position)[0];
check("an excluded company before the cursor does not cause a skip",
  exNext[0].position === shouldBeNext.position,
  JSON.stringify({ expected: shouldBeNext.position, actual: exNext[0].position, excludedAt: 0 }));
await req("POST", "/api/config", { token: C_TOK, body: { excluded_companies: [] } });

// Only the served slice moves the cursor. On one shared list the company
// discovery turns up is usually one another search's run already added, and it
// can sit anywhere along the log: counting it would move the cursor past it,
// leaving everything between the slice and that company unswept for the cycle.
const bSlice = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json;
const outsideSlice = (await req("GET", `/api/coverage/${ROT}?all=1`, { token: C_TOK })).json.companies
  .filter((c) => !bSlice.companies.some((s) => s.company === c.company));
const farAhead = outsideSlice.filter((c) => c.position >= bSlice.cursor).pop() || outsideSlice[0];
const dayAfter = "2026-09-12";
const recAhead = await req("POST", "/api/coverage", { token: C_TOK, body: { search: ROT, on: dayAfter,
  swept: [bSlice.companies[0], farAhead].map((c) => ({ company: c.company })) } });
const farRow = (await req("GET", `/api/coverage/${ROT}?all=1`, { token: C_TOK })).json.companies
  .find((c) => c.company === farAhead.company);
check("a listed company outside the served slice is recorded but does not move the cursor",
  recAhead.json.cursor === bSlice.companies[0].position + 1 && farRow.last_swept === dayAfter,
  JSON.stringify({ cursor: recAhead.json.cursor, expected: bSlice.companies[0].position + 1,
    farAhead: farAhead.position, last_swept: farRow.last_swept }));
// A company re-sent after it was recorded sits just behind the cursor, nearly a
// whole lap along from it - counted, it would outrank the replacements reported
// beside it, and they would be served again the next day.
const nextSlice = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json.companies;
const resentRec = await req("POST", "/api/coverage", { token: C_TOK, body: { search: ROT, on: dayAfter,
  swept: [bSlice.companies[0], nextSlice[0], nextSlice[1]].map((c) => ({ company: c.company })) } });
check("a company re-sent from behind the cursor does not hold it back",
  resentRec.json.cursor === nextSlice[1].position + 1,
  JSON.stringify({ cursor: resentRec.json.cursor, expected: nextSlice[1].position + 1 }));

// Discovery appends rather than jumping the queue or landing behind the cursor.
const found = `Rot ${rotStamp}-discovered`;
await req("POST", "/api/coverage", { token: C_TOK, body: { search: ROT, on: day,
  swept: [{ company: found }] } });
const rotAll = (await req("GET", `/api/coverage/${ROT}?all=1`, { token: C_TOK })).json.companies;
check("a company found by discovery appends to the end of the log",
  rotAll[rotAll.length - 1].company === found &&
  rotAll[rotAll.length - 1].position > Math.max(...rotAll.slice(0, -1).map((c) => c.position)),
  JSON.stringify({ last: rotAll[rotAll.length - 1].company, total: rotAll.length }));
check("positions stay dense and unique after an append",
  new Set(rotAll.map((c) => c.position)).size === rotAll.length,
  JSON.stringify(rotAll.map((c) => c.position).slice(-4)));

console.log("\n== a new search starts at the companies its person named ==");
// Seeded companies append past the end of the shared list and a new track's
// cursor is 0, so without start_here a new person's own companies are the last
// ones their search reaches - a cycle of nights away (docs/onboarding-plan.md).
const rotCursorBefore = (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json.cursor;
const NEW = ROT + "N", OLD = ROT + "O", AGAIN = ROT + "A";
await req("POST", "/api/config", { token: C_TOK, body: { tracks: [
  { key: ROT, label: "Rot" }, { key: EX, label: "Ex" },
  { key: NEW, label: "New" }, { key: OLD, label: "Old" }, { key: AGAIN, label: "Again" }] } });

// The control first: a new search seeded the ordinary way starts at the front
// of the shared list, which is what this flag exists to change.
const oldNames = ["Ash", "Birch", "Cedar"].map((n) => `Old ${rotStamp}-${n}`);
await req("POST", "/api/coverage", { token: C_TOK, body: { search: OLD, on: "",
  swept: oldNames.map((company) => ({ company })) } });
const oldFirst = (await req("GET", `/api/coverage/${OLD}`, { token: C_TOK })).json;
const listLow = Math.min(...(await req("GET", `/api/coverage/${OLD}?all=1`, { token: C_TOK })).json.companies
  .map((c) => c.position));
check("seeded without the flag, a new search starts at the front of the shared list",
  oldFirst.cursor === 0 && oldFirst.companies[0].position === listLow &&
  !oldNames.includes(oldFirst.companies[0].company),
  JSON.stringify({ cursor: oldFirst.cursor, firstServed: oldFirst.companies[0].position, listLow }));

const named = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((n) => `New ${rotStamp}-${n}`);
const seedRes = await req("POST", "/api/coverage", { token: C_TOK, body: { search: NEW, on: "",
  start_here: true, swept: named.map((company) => ({ company })) } });
const newAll = (await req("GET", `/api/coverage/${NEW}?all=1`, { token: C_TOK })).json.companies;
const seededPos = newAll.filter((c) => named.includes(c.company)).map((c) => c.position);
check("seeding with start_here sets the new search's cursor to the first company it added",
  seedRes.json.added === named.length && seededPos.length === named.length &&
  seedRes.json.cursor === Math.min(...seededPos),
  JSON.stringify({ added: seedRes.json.added, cursor: seedRes.json.cursor, seeded: seededPos.sort((a, b) => a - b) }));
const firstNight = (await req("GET", `/api/coverage/${NEW}`, { token: C_TOK })).json;
check("so night one serves the companies the person named, before the rest of the list",
  firstNight.cursor === seedRes.json.cursor &&
  firstNight.companies.slice(0, named.length).every((c) => named.includes(c.company)),
  JSON.stringify({ served: firstNight.companies.slice(0, named.length + 1).map((c) => c.company) }));
// The rotation wraps, so starting late skips nothing: the companies before the
// seeded block are reached after it, not never.
check("and the rest of the list follows rather than being skipped",
  firstNight.companies.length > named.length &&
  firstNight.companies[named.length].position < Math.min(...seededPos),
  JSON.stringify({ afterTheNamed: firstNight.companies[named.length], seededFrom: Math.min(...seededPos) }));

// Two rules moving one number is two answers to one question: a dated report
// advances the cursor past what it swept, and this flag sets it backwards.
const datedStart = await req("POST", "/api/coverage", { token: C_TOK, body: { search: NEW, on: day,
  start_here: true, swept: [{ company: named[0] }] } });
const afterRefusal = (await req("GET", `/api/coverage/${NEW}?all=1`, { token: C_TOK })).json;
check("start_here sent with a date is refused, not quietly ignored",
  datedStart.status === 400 && /start_here/.test(datedStart.json.error || ""),
  JSON.stringify({ status: datedStart.status, error: datedStart.json.error }));
check("and the refused call records no sweep and leaves the cursor where it was",
  afterRefusal.cursor === seedRes.json.cursor &&
  afterRefusal.companies.find((c) => c.company === named[0]).last_swept === "",
  JSON.stringify({ cursor: afterRefusal.cursor, expected: seedRes.json.cursor }));

// Every name already on the shared list: there is no block to start at, since
// those companies sit wherever the list already put them.
const againRes = await req("POST", "/api/coverage", { token: C_TOK, body: { search: AGAIN, on: "",
  start_here: true, swept: named.map((company) => ({ company })) } });
check("start_here with nothing new to add leaves the cursor alone, and `added: 0` says why",
  againRes.json.added === 0 && againRes.json.cursor === 0,
  JSON.stringify({ added: againRes.json.added, cursor: againRes.json.cursor }));
check("and starting one search where its person's companies are does not move another's",
  (await req("GET", `/api/coverage/${ROT}`, { token: C_TOK })).json.cursor === rotCursorBefore,
  JSON.stringify({ before: rotCursorBefore }));

console.log("\n== branched tracks ==");
// One search, several tabs: a track with fed_by is a tab the named sibling's
// run fills. The failure this guards against is a tab nothing ever fills or
// records a run against - which looks like a working, quiet search.
check("fed_by naming a track that isn't in the list is refused",
  (await req("POST", "/api/config", { token: A_TOK, body: { tracks: [
    { key: "SWE", label: "Ada Eng" },
    { key: "LEAD", label: "Ada Lead", fed_by: "NOPE" }] } })).status === 400);
check("a track cannot feed itself",
  (await req("POST", "/api/config", { token: A_TOK, body: { tracks: [
    { key: "SWE", label: "Ada Eng" },
    { key: "LEAD", label: "Ada Lead", fed_by: "LEAD" }] } })).status === 400);
const branched = await req("POST", "/api/config", { token: A_TOK, body: { tracks: [
  { key: "SWE", label: "Ada Eng", sort_order: 0, schedule_time: "08:00",
    role_search_line: "Backend roles", target_companies: ["Acme"],
    full_description: "a hands-on backend role" },
  { key: "LEAD", label: "Ada Lead", sort_order: 1, fed_by: "SWE",
    full_description: "a role leading a team" },
  // An independent track, not part of the SWE feed group - the contrast that
  // makes the dedup-scope checks below mean something.
  { key: "DATA", label: "Ada Data", sort_order: 2,
    role_search_line: "Data roles", target_companies: ["Globex"] }] } });
check("a fed track posts fine alongside the track that feeds it", branched.status === 200, branched.text.slice(0, 120));

// Dedup follows the *search*, not the tab. SWE and LEAD are one search filling
// two tabs, so one posting cannot sit in both: a run that filed it under LEAD
// yesterday and sorts it into SWE today would otherwise add it twice, which is
// the duplicate this whole filter exists to stop arriving by another door.
const groupUrl = `https://boards.example.com/jobs/${Date.now()}31`;
const across = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Shared", url: groupUrl },
  { search: "LEAD", company: "Acme", title: "Shared", url: groupUrl }] } });
check("one posting cannot land in two tabs of the same branched search",
  across.json.added === 1 && across.json.duplicates === 1, JSON.stringify(across.json));
// ...while two genuinely separate searches tracking one posting stay two rows,
// as UNIQUE(user_id, search, url) allows.
const indieUrl = `https://boards.example.com/jobs/${Date.now()}32`;
const indie = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Shared", url: indieUrl },
  { search: "DATA", company: "Acme", title: "Shared", url: indieUrl }] } });
check("but two independent tracks may each hold it",
  indie.json.added === 2, JSON.stringify(indie.json));
const fedPrompt = await req("GET", "/api/prompt/LEAD", { token: A_TOK });
check("a fed track has no prompt of its own, and the refusal names the one to run",
  fedPrompt.status === 409 && /"SWE"/.test(fedPrompt.json.error), fedPrompt.text.slice(0, 120));
const feedPrompt = (await req("GET", "/api/prompt/SWE", { token: A_TOK })).text;
// `./tracker dedup` merges the fed tabs itself, so a run learns the fed tab
// exists only from the header and the filing step.
check("the feeding track's prompt covers both tabs",
  /# Also fills: LEAD /.test(feedPrompt) &&
  feedPrompt.includes("a role leading a team") &&
  feedPrompt.includes('`"LEAD"`'));
check("and says its one dedup command covers them together",
  /covers all 2 tabs this run fills/.test(feedPrompt) &&
  !/\/api\/dedup\//.test(feedPrompt));
// The filing step's tie-break. The feeding track is whichever tab owns the
// scheduled search, not a general-purpose one, so a tie has to resolve among
// the tabs a posting reads as, and the feeding key is named as not a default.
check("a tie in the filing step resolves among the tabs a posting reads as, not to the feeding tab",
  feedPrompt.includes("whichever of *those* tabs comes first in the list above") &&
  /already ruled out is never the answer/.test(feedPrompt) &&
  !/reads more than one way after checking, file it under `SWE`/.test(feedPrompt));
// The fan-out is one transaction, so a run record either exists for every tab
// the run fills or for none. A half-written fan-out would leave a tab that had
// just been searched reading as never-run - the exact state search_runs exists
// to make visible.
const fanDay = "2026-12-01";
await req("POST", "/api/runs", { token: A_TOK, body: { search: "SWE", status: "ok", on: fanDay, note: "before" } });
const beforeFan = (await req("GET", "/api/config", { token: A_TOK })).json.tracks
  .filter((t) => ["SWE", "LEAD"].includes(t.key)).map((t) => t.last_run.note);
check("a fan-out writes a record for the posted track and every tab it feeds",
  beforeFan.length === 2 && beforeFan.every((n) => n === "before"), JSON.stringify(beforeFan));
check("and the fed tab's record is not the feeding track's row copied over",
  (await req("GET", "/api/config", { token: A_TOK })).json.tracks
    .find((t) => t.key === "LEAD").last_run.on === fanDay);

check("a fed track still accepts a run record - that's what keeps its tab from reading stale",
  (await req("POST", "/api/runs", { token: A_TOK, body: { search: "LEAD", on: "2026-08-31", note: "filed by SWE" } })).status === 200);

console.log("\n== leads and screened must name a configured track ==");
// The orphan-row failure, from the write side: a row under an unconfigured key
// is stored, invisible, and raises no error. Ada's tracks here are SWE, LEAD
// (fed by SWE) and DATA.
const ghostLead = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "GHOST", company: "Acme", title: "Nowhere", url: `https://boards.example.com/jobs/${Date.now()}41` }] } });
check("a lead naming an unconfigured track is refused, and the error names the key",
  ghostLead.status === 404 && /GHOST/.test(ghostLead.json.error), ghostLead.text.slice(0, 140));
const ghostScreened = await req("POST", "/api/screened", { token: A_TOK, body: { screened: [
  { search: "GHOST", url: `https://boards.example.com/jobs/${Date.now()}42`, reason: "out of scope" }] } });
check("and so is a screened row naming one",
  ghostScreened.status === 404 && /GHOST/.test(ghostScreened.json.error), ghostScreened.text.slice(0, 140));

// The half-applied payload is the case worth holding onto: the run reads
// `added`, reports it, and stops looking for those postings. So a payload that
// is one-third wrong must file none of it - checked from outside by asking
// whether the good row's url is anywhere in the data afterwards.
const mixedUrl = `https://boards.example.com/jobs/${Date.now()}43`;
const mixed = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Valid one", url: mixedUrl },
  { search: "GHOST", company: "Acme", title: "Drifted one", url: `${mixedUrl}-b` }] } });
check("a payload mixing a valid key with an unknown one is rejected whole",
  mixed.status === 404, mixed.text.slice(0, 140));
const afterMixed = await req("GET", "/api/data", { token: A_TOK });
check("and the valid row in that payload was not inserted",
  !afterMixed.json.leads.some((l) => l.url === mixedUrl));
const mixedScreenUrl = `https://boards.example.com/jobs/${Date.now()}44`;
check("same for screened - one bad key, nothing filed",
  (await req("POST", "/api/screened", { token: A_TOK, body: { screened: [
    { search: "SWE", url: mixedScreenUrl, reason: "wrong level" },
    { search: "GHOST", url: `${mixedScreenUrl}-b`, reason: "wrong level" }] } })).status === 404 &&
  !(await req("GET", "/api/data", { token: A_TOK })).json.screened.some((s) => s.url === mixedScreenUrl));

// A fed key must keep working. It is a track row like any other, and a
// branched run files into the tab it feeds by name - a check that only allowed
// "tracks that run their own search" would break every branched run on the
// first night.
const fedLead = await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "LEAD", company: "Acme", title: "Fed tab", url: `https://boards.example.com/jobs/${Date.now()}45` }] } });
check("a fed (fed_by) key is still accepted by /api/leads", fedLead.status === 200 && fedLead.json.added === 1,
  fedLead.text.slice(0, 140));
const fedScreenUrl = `https://boards.example.com/jobs/${Date.now()}46`;
const fedScreened = await req("POST", "/api/screened", { token: A_TOK, body: { screened: [
  { search: "LEAD", url: fedScreenUrl, reason: "wrong level" }] } });
check("and by /api/screened, which then rewrites it to the feed root",
  fedScreened.status === 200 && fedScreened.json.added === 1, fedScreened.text.slice(0, 140));
check("the rewrite still happened - the row is filed under SWE, not LEAD",
  (await req("GET", "/api/data", { token: A_TOK })).json.screened
    .find((s) => s.url === fedScreenUrl)?.search === "SWE");

// Another user's track key is an unconfigured key here, which is the property
// this shares with the rest of the cross-user matrix. "DATA" is one of Ada's
// tabs and none of Bo's, and the refusal Bo gets is the ordinary unknown-track
// 404 - the same answer a typo gets, saying nothing about whether anyone else
// has such a track.
check("one user cannot file a lead into another user's track key",
  (await req("POST", "/api/leads", { token: B_TOK, body: { leads: [
    { search: "DATA", company: "Acme", title: "Not yours", url: `https://boards.example.com/jobs/${Date.now()}47` }] } })).status === 404);

console.log("\n== dates and counts line up ==");
// The bug this catches: /api/screened accepts a local `on`, and a run record
// counts a day's screened rows by `date = on`. If the caller sends `on` to
// /api/runs but not to /api/screened, the rows get the worker's UTC date and
// the run truthfully records having screened nothing. It only diverges when
// the two dates differ, which a same-day test cannot produce - so this sends a
// date that is nobody's "today" and checks the counts still find each other.
const farDay = "2026-11-14";
// Distinct req ids, not a shared stem with different suffixes: canonicalUrl
// keys on the number and ignores the rest of the path, so urls built by
// appending to one stem are all the same posting.
const dStamp = Date.now();
// Deltas, not absolutes: this file is re-run against the same local database,
// and a previous run's rows are still sitting on that date.
const base = (await req("POST", "/api/runs", { token: A_TOK, body: {
  search: "SWE", status: "ok", on: farDay, note: "baseline" } })).json.run;
await req("POST", "/api/leads", { token: A_TOK, body: { on: farDay, leads: [
  { search: "SWE", company: "Acme", title: "Dated", url: `https://dates.example.com/jobs/${dStamp}10` }] } });
await req("POST", "/api/screened", { token: A_TOK, body: { search: "SWE", on: farDay, screened: [
  { search: "SWE", url: `https://dates.example.com/jobs/${dStamp}11`, reason: "below target level" },
  { search: "SWE", url: `https://dates.example.com/jobs/${dStamp}12`, reason: "outside scope: London, UK" }] } });
const dated = await req("POST", "/api/runs", { token: A_TOK, body: {
  search: "SWE", status: "ok", on: farDay, note: "dates" } });
check("a lead posted with a top-level `on` is stamped and counted on that date",
  dated.json.run.leads_added - base.leads_added === 1, JSON.stringify(dated.json.run));
check("screened rows posted with the same `on` are counted on it too",
  dated.json.run.screened_added - base.screened_added === 2, JSON.stringify(dated.json.run));
// DELISTED_REASON is the server's marker for "a lead we tracked came down".
// A run screening a dead-on-arrival candidate would describe it the same way
// in English, and that row must not be counted as a delisting.
await req("POST", "/api/screened", { token: A_TOK, body: { search: "SWE", on: farDay, screened: [
  { search: "SWE", url: `https://dates.example.com/jobs/${dStamp}13`, reason: "posting taken down" }] } });
const reasoned = await req("POST", "/api/runs", { token: A_TOK, body: { search: "SWE", status: "ok", on: farDay } });
check("a screened row cannot claim the reason that means 'delisted'",
  reasoned.json.run.delisted === base.delisted &&
  reasoned.json.run.screened_added - base.screened_added === 3,
  JSON.stringify(reasoned.json.run));

console.log("\n== url-keyed routes ==");
// These routes find a lead by url rather than by id, so
// they do not inherit the protection every other cross-user check in this file
// relies on - an id that simply doesn't resolve for the wrong user. A
// `WHERE url IN (...)` missing its user_id would match the other person's row
// perfectly, and one of these routes deletes. Hence the two checks below.
const bothUrl = `https://careers.example.com/jobs/${Date.now()}4210`;
for (const tok of [A_TOK, B_TOK]) {
  await req("POST", "/api/leads", { token: tok, body: { leads: [
    { search: "SWE", company: "Acme", title: "Shared", url: bothUrl, verified: "2026-01-01" }] } });
}
// Sent as a variant, to prove the canonical match is what resolves it.
const bStamp = await req("POST", "/api/verified", { token: B_TOK, body: {
  search: "SWE", on: "2026-09-02", urls: [`${bothUrl}?gh_src=search-snippet`] } });
check("a url variant re-confirms the lead it names", bStamp.json.stamped === 1, JSON.stringify(bStamp.json));
const aRow = (await req("GET", "/api/data", { token: A_TOK })).json.leads.find((l) => l.url === bothUrl);
check("and stamping it did not touch the other user's copy",
  aRow && aRow.verified === "2026-01-01", JSON.stringify(aRow && aRow.verified));

const bDel = await req("POST", "/api/delist", { token: B_TOK, body: {
  search: "SWE", on: "2026-09-02", urls: [bothUrl] } });
check("delisting removes the caller's lead", bDel.json.removed === 1, JSON.stringify(bDel.json));
const aData2 = await req("GET", "/api/data", { token: A_TOK });
const bData2 = await req("GET", "/api/data", { token: B_TOK });
check("and leaves the other user's lead for the same posting alone",
  aData2.json.leads.some((l) => l.url === bothUrl) && !bData2.json.leads.some((l) => l.url === bothUrl));

// A date that isn't a date is not a report of anything, and what this triggers
// is a permanent delete - so it is refused for the whole batch, before
// anything is removed.
const liveUrl = `https://careers.example.com/jobs/${Date.now()}5511`;
await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Still live", url: liveUrl }] } });
const badOn = await req("POST", "/api/delist", { token: A_TOK, body: { search: "SWE", on: "today", urls: [liveUrl] } });
check("delist refuses a non-date and deletes nothing",
  badOn.status === 400 &&
  (await req("GET", "/api/data", { token: A_TOK })).json.leads.some((l) => l.url === liveUrl),
  badOn.text.slice(0, 100));
const noMatch = await req("POST", "/api/delist", { token: A_TOK, body: {
  search: "SWE", on: "2026-09-02", urls: ["https://example.com/nothing-tracks-this"] } });
check("a url nothing tracks is reported back as a raw url, not a count",
  noMatch.json.unmatched === 1 && noMatch.json.unmatchedUrls[0] === "https://example.com/nothing-tracks-this",
  JSON.stringify(noMatch.json));

console.log("\n== moving a lead between tabs ==");
const moved = await req("POST", "/api/update", { token: A_TOK, body: { type: "lead", id: aLeadId, search: "LEAD" } });
check("a lead moves to another of your own tabs", moved.status === 200 && moved.json.lead.search === "LEAD", moved.text.slice(0, 120));
check("moving to a track you don't have is a 404, not a lost lead",
  (await req("POST", "/api/update", { token: A_TOK, body: { type: "lead", id: aLeadId, search: "GHOST" } })).status === 404);
check("B cannot move A's lead into one of B's tabs",
  (await req("POST", "/api/update", { token: B_TOK, body: { type: "lead", id: aLeadId, search: "SWE" } })).status === 404);
// Its own url rather than the shared fixture: a second row for that one would
// quietly break the "A's leads survive their track being removed" count below.
//
// The destination is DATA, an independent track, not LEAD. Since dedup follows
// the search rather than the tab, one posting cannot be filed into two
// tabs of the same branched search at all - so a genuine UNIQUE collision on
// move can only be built out of two separate searches.
const conflictUrl = `https://example.com/in-both-tabs-${Date.now()}`;
await req("POST", "/api/leads", { token: A_TOK, body: { leads: [
  { search: "SWE", company: "Acme", title: "Staff Backend", location: "Remote (U.S.)", url: conflictUrl },
  { search: "DATA", company: "Acme", title: "Staff Backend", location: "Remote (U.S.)", url: conflictUrl }] } });
const dupId = (await req("GET", "/api/data", { token: A_TOK })).json.leads
  .find((l) => l.url === conflictUrl && l.search === "SWE").id;
check("moving onto a url the destination tab already holds is a 409, not a 500",
  (await req("POST", "/api/update", { token: A_TOK, body: { type: "lead", id: dupId, search: "DATA" } })).status === 409);

console.log("\n== sessions ==");
const aSecond = await req("POST", "/api/login", { body: { name: "Ada", password: "ada-new-password-1", label: "browser" } });
check("logging out revokes only the token used",
  (await req("POST", "/api/logout", { token: A_TOK })).status === 200
  && (await req("GET", "/api/me", { token: A_TOK })).status === 401
  && (await req("GET", "/api/me", { token: aSecond.json.token })).status === 200);
check("B's session is untouched by A's logout", (await req("GET", "/api/me", { token: B_TOK })).status === 200);

console.log("\n== config writes ==");
check("an empty tracks array is refused rather than wiping the list",
  (await req("POST", "/api/config", { token: B_TOK, body: { tracks: [] } })).status === 400);
// Posting {key, label} to rename a tab must not blank the track's search
// config - the prompt would quietly fall back to its generic defaults.
await req("POST", "/api/config", { token: B_TOK, body: { tracks: [{ key: "SWE", label: "Renamed" }] } });
const bKept = (await req("GET", "/api/config", { token: B_TOK })).json.tracks[0];
check("a partial track post keeps the fields it didn't mention",
  bKept.label === "Renamed" && bKept.role_search_line === "Frontend roles" && bKept.schedule_time === "09:00",
  JSON.stringify({ label: bKept.label, role: bKept.role_search_line, time: bKept.schedule_time }));
check("a field sent as empty string still clears",
  (await req("POST", "/api/config", { token: B_TOK, body: { tracks: [{ key: "SWE", label: "Renamed", search_note: "" }] } })).status === 200);

console.log("\n== replaceTracks isolation ==");
await req("POST", "/api/config", { token: aSecond.json.token, body: { tracks: [{ key: "DATA", label: "Ada Data" }] } });
const bStill = await req("GET", "/api/config", { token: B_TOK });
check("A replacing their whole track list leaves B's tracks alone",
  bStill.json.tracks.length === 1 && bStill.json.tracks[0].key === "SWE");
check("A's old track is gone for A", (await req("GET", "/api/config", { token: aSecond.json.token })).json.tracks[0].key === "DATA");
check("A's leads survive their track being removed",
  mine((await req("GET", "/api/data", { token: aSecond.json.token })).json.leads, sharedUrl) === 1);

console.log("\n== removing postings by hand ==");
// The third way a lead leaves the board, after delisting and purging. What
// these check is the part that makes it different from both: the reason is
// the caller's, it reaches the screened row, and that row is what stops the
// removal undoing itself on the next run.
const rmTok = aSecond.json.token; // A_TOK is revoked by the sessions section above
// The varying part has to be the 5+ digit run itself. url.js treats such a
// run as the posting's identity and ignores everything around it, so
// `remove-me-1-<ts>` and `remove-me-2-<ts>` are the SAME posting to it - a
// fixture written that way silently gets one lead instead of three.
const rmStamp = Date.now();
const rmUrl = (n) => `https://example.com/remove-me-${rmStamp + n}`;
const rmUrls = [rmUrl(1), rmUrl(2), rmUrl(3)];
// Whatever track A has right now, not a hard-coded "SWE": the replaceTracks
// section just above swaps A's track list out, so assuming a key here would
// make this section depend on the order the file happens to run in.
const rmTrack = (await req("GET", "/api/config", { token: rmTok })).json.tracks[0].key;
const rmAdd = await req("POST", "/api/leads", { token: rmTok, body: { leads: rmUrls.map((u, i) => (
  { search: rmTrack, company: `Removable ${i}`, title: "Engineer", location: "Austin, TX", url: u })) } });
const rmData = await req("GET", "/api/data", { token: rmTok });
const rmLeads = rmUrls.map((u) => rmData.json.leads.find((l) => l.url === u));
check("fixtures for removal exist", rmLeads.every(Boolean), `track=${rmTrack} add=${rmAdd.text.slice(0,120)} data=${rmData.status}/${(rmData.json.leads||[]).length}`);

check("removing without a reason is refused",
  (await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [rmLeads[0].id] } })).status === 400);
check("a blank reason is refused too",
  (await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [rmLeads[0].id], reason: "   " } })).status === 400);
check("an over-long reason is refused",
  (await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [rmLeads[0].id], reason: "x".repeat(201) } })).status === 400);
check("no ids is refused",
  (await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [], reason: "outside target locations" } })).status === 400);

const rmOne = await req("POST", "/api/delete-leads",
  { token: rmTok, body: { ids: [rmLeads[0].id, rmLeads[1].id], reason: "outside target locations" } });
check("removing two leads reports both", rmOne.status === 200 && rmOne.json.removed === 2, rmOne.text.slice(0, 140));
const afterRm = await req("GET", "/api/data", { token: rmTok });
check("the removed leads are gone from the board",
  !afterRm.json.leads.some((l) => l.id === rmLeads[0].id || l.id === rmLeads[1].id));
check("each removal left a screened row carrying the caller's reason",
  rmUrls.slice(0, 2).every((u) => afterRm.json.screened.some(
    (sc) => sc.url === u && sc.reason === "outside target locations")),
  JSON.stringify(afterRm.json.screened.filter((sc) => rmUrls.includes(sc.url))));
check("the screened row is what stops tomorrow's run re-adding it",
  (await req("GET", `/api/dedup/${rmTrack}`, { token: rmTok })).json.screened.includes(rmUrls[0]));
check("removing an id twice is unmatched, not an error",
  (await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [rmLeads[0].id], reason: "again" } }))
    .json.unmatched.length === 1);

// The applied-to guard, tested through the application row rather than the
// status, because that is what the handler checks.
await req("POST", `/api/leads/${rmLeads[2].id}/status`, { token: rmTok, body: { status: "Applied" } });
const rmApplied = await req("POST", "/api/delete-leads",
  { token: rmTok, body: { ids: [rmLeads[2].id], reason: "outside target locations" } });
check("a lead an application points at is kept, not removed",
  rmApplied.json.removed === 0 && rmApplied.json.kept.includes(rmLeads[2].id), rmApplied.text.slice(0, 140));
check("that lead is still on the board",
  (await req("GET", "/api/data", { token: rmTok })).json.leads.some((l) => l.id === rmLeads[2].id));

// The delisting marker is reserved: countRunActivity splits a day's screened
// rows on that exact string, so a person typing it into the reason box would
// be counted as a delisting rather than a rejection.
const rmSentUrl = `https://example.com/remove-me-${rmStamp + 90}`;
await req("POST", "/api/leads", { token: rmTok, body: { leads: [
  { search: rmTrack, company: "Sentinel Co", title: "Engineer", location: "Austin, TX", url: rmSentUrl }] } });
const rmSent = (await req("GET", "/api/data", { token: rmTok })).json.leads.find((l) => l.url === rmSentUrl);
await req("POST", "/api/delete-leads", { token: rmTok, body: { ids: [rmSent.id], reason: "Posting Taken Down" } });
const rmSentRow = (await req("GET", "/api/data", { token: rmTok })).json.screened.find((sc) => sc.url === rmSentUrl);
check("a reason equal to the delisting marker is rewritten, not stored as typed",
  rmSentRow && rmSentRow.reason === "removed by hand", JSON.stringify(rmSentRow));

// Isolation: the whole reason this file exists.
const bTargets = (await req("GET", "/api/data", { token: B_TOK })).json.leads[0];
const crossRm = await req("POST", "/api/delete-leads",
  { token: rmTok, body: { ids: [bTargets.id], reason: "should not work" } });
check("one user cannot remove another's lead",
  crossRm.json.removed === 0 && crossRm.json.unmatched.length === 1, crossRm.text.slice(0, 140));
check("B's lead is still there afterwards",
  (await req("GET", "/api/data", { token: B_TOK })).json.leads.some((l) => l.id === bTargets.id));
check("and no screened row was invented in B's data",
  !(await req("GET", "/api/data", { token: B_TOK })).json.screened.some((sc) => sc.reason === "should not work"));

console.log("\n== a person's pruning is not the search's work ==");
// Run counts derive from rows, and a person removing a posting writes a
// screened row so it isn't rediscovered. Without added_by, that pruning would
// be reported as the night's search work.
const attrDay = new Date().toISOString().slice(0, 10);
const aStamp = Date.now();
const amk = (n) => ({ search: "SWE", company: "Acme", title: "Attr" + n, url: `https://attr.example.com/jobs/${aStamp}${n}` });
await req("POST", "/api/leads", { token: B_TOK, body: { on: attrDay, leads: [amk(41), amk(42), amk(43)] } });
await req("POST", "/api/screened", { token: B_TOK, body: { search: "SWE", on: attrDay, screened: [
  { search: "SWE", url: `https://attr.example.com/jobs/${aStamp}44`, reason: "below target level" }] } });
const attrBase = (await req("POST", "/api/runs", { token: B_TOK, body: { search: "SWE", status: "ok", on: attrDay } })).json.run;

const attrLeads = (await req("GET", "/api/data", { token: B_TOK })).json.leads
  .filter((l) => l.url.startsWith(`https://attr.example.com/jobs/${aStamp}`));
const handDel = await req("POST", "/api/delete-leads", { token: B_TOK, body: {
  ids: [attrLeads[0].id], reason: "not interested" } });
check("a hand removal deletes the lead and screens its url", handDel.json.removed === 1, JSON.stringify(handDel.json));
const attrAfter = (await req("POST", "/api/runs", { token: B_TOK, body: { search: "SWE", status: "ok", on: attrDay } })).json.run;
check("it does not turn up in the run's screened count",
  attrAfter.screened_added === attrBase.screened_added,
  JSON.stringify({ before: attrBase.screened_added, after: attrAfter.screened_added }));
check("nor in its delisted count",
  attrAfter.delisted === attrBase.delisted,
  JSON.stringify({ before: attrBase.delisted, after: attrAfter.delisted }));

// `added_by` must be a closed set: every write path sets it explicitly, so ''
// means exactly "written before the column existed" and nothing else. A new ''
// appearing is a code path that forgot, and the column stops meaning anything.
const attrRows = (await req("GET", "/api/data", { token: B_TOK })).json.screened
  .filter((s) => s.url.startsWith(`https://attr.example.com/jobs/${aStamp}`));
check("both write paths stamp added_by - '' stays a closed historical set",
  attrRows.length === 2 && attrRows.every((s) => s.added_by === "run" || s.added_by === "hand"),
  JSON.stringify(attrRows.map((s) => ({ by: s.added_by, reason: s.reason.slice(0, 24) }))));
check("the search's row is 'run' and the person's is 'hand'",
  attrRows.some((s) => s.added_by === "run" && s.reason === "below target level") &&
  attrRows.some((s) => s.added_by === "hand" && s.reason === "not interested"),
  JSON.stringify(attrRows.map((s) => s.added_by + ":" + s.reason.slice(0, 20))));
// The Overview's weekly found chart counts removed postings by this date
// (migrations/0014_screened_found.sql).
check("a hand removal keeps the lead's found date; a screened-out posting has none",
  attrRows.some((s) => s.added_by === "hand" && s.found === attrLeads[0].found && s.found === attrDay) &&
  attrRows.some((s) => s.added_by === "run" && s.found === ""),
  JSON.stringify(attrRows.map((s) => s.added_by + ":" + s.found)));

// Why addedBy is refused rather than defaulted: deleteLeadAndScreen in src/db.js.
const attrDb = await import("./src/db.js");
let threw = "";
try {
  await new attrDb.Db({}, "u").deleteLeadAndScreen({ id: 1, search: "SWE", url: "u" }, "r", null);
} catch (e) { threw = e.message; }
check("deleteLeadAndScreen refuses a missing added_by instead of guessing 'run'",
  /addedBy must be 'run' or 'hand'/.test(threw), JSON.stringify(threw.slice(0, 90)));
for (const bad of ["", "RUN", "person", null]) {
  let m = "";
  try { await new attrDb.Db({}, "u").deleteLeadAndScreen({ id: 1, search: "SWE", url: "u" }, "r", null, bad); }
  catch (e) { m = e.message; }
  check(`and refuses ${JSON.stringify(bad)}`, /addedBy must be/.test(m), JSON.stringify(m.slice(0, 60)));
}

// A delisting report is a run's work and must still count as delisted.
const delUrl = `https://attr.example.com/jobs/${aStamp}51`;
await req("POST", "/api/leads", { token: B_TOK, body: { on: attrDay, leads: [
  { search: "SWE", company: "Acme", title: "Doomed", url: delUrl }] } });
await req("POST", "/api/delist", { token: B_TOK, body: { search: "SWE", on: attrDay, urls: [delUrl] } });
const attrDelisted = (await req("POST", "/api/runs", { token: B_TOK, body: { search: "SWE", status: "ok", on: attrDay } })).json.run;
check("a delisting reported by the search still counts as delisted",
  attrDelisted.delisted === attrBase.delisted + 1,
  JSON.stringify({ before: attrBase.delisted, after: attrDelisted.delisted }));
const delRow = (await req("GET", "/api/data", { token: B_TOK })).json.screened.find((s) => s.url === delUrl);
check("a delisted lead's screened row keeps its found date",
  !!delRow && delRow.found === attrDay, JSON.stringify(delRow && { found: delRow.found }));

console.log("\n== purging a retired search ==");
// A's track list is now just DATA (above), so SWE is retired for A and its
// rows are eligible. B still has a live SWE, which is what makes the
// cross-user and still-configured guards testable in the same breath.
const A2 = aSecond.json.token;
check("a session token cannot reach the purge route, only the admin secret",
  (await req("POST", "/api/purge", { token: A2, body: { user: "Ada", search: "SWE" } })).status === 401);
check("no token at all is 401",
  (await req("POST", "/api/purge", { body: { user: "Ada", search: "SWE" } })).status === 401);
check("an unknown user is 404, not a silent no-op",
  (await req("POST", "/api/purge", { admin: true, body: { user: "Nobody", search: "SWE" } })).status === 404);
const liveGuard = await req("POST", "/api/purge", { admin: true, body: { user: "Bo", search: "SWE" } });
check("purging a key that is still a configured track is refused",
  liveGuard.status === 409 && /configured track/.test(liveGuard.json.error), liveGuard.text.slice(0, 140));

const dry = await req("POST", "/api/purge", { admin: true, body: { user: "Ada", search: "SWE", dryRun: true } });
check("dryRun reports what it would remove and removes nothing",
  dry.json.dryRun === true && dry.json.wouldPurge.leads > 0 &&
  (await req("GET", "/api/data", { token: A2 })).json.leads.some((l) => l.search === "SWE"),
  JSON.stringify(dry.json));

// An application pointing at a lead that is about to be deleted. The record of
// having applied is the least recoverable thing here - the posting is gone
// from the internet too - so it must survive with its pointer cleared.
const appLead = (await req("GET", "/api/data", { token: A2 })).json.leads.find((l) => l.search === "SWE");
await req("POST", `/api/leads/${appLead.id}/status`, { token: A2, body: { status: "Applied" } });
const appsBefore = (await req("GET", "/api/data", { token: A2 })).json.applications;
const linked = appsBefore.find((a) => String(a.leadId) === String(appLead.id));
check("the fixture application is linked to a lead about to be purged", !!linked);

const purged = await req("POST", "/api/purge", { admin: true, body: { user: "Ada", search: "SWE" } });
check("purging removes the retired search's leads and screened rows",
  purged.json.purged.leads > 0 && purged.json.purged.screened >= 0, JSON.stringify(purged.json));
const afterPurge = await req("GET", "/api/data", { token: A2 });
check("nothing is left under that search",
  !afterPurge.json.leads.some((l) => l.search === "SWE") &&
  !afterPurge.json.screened.some((s) => s.search === "SWE"));
check("the application survived, un-pointed rather than deleted",
  afterPurge.json.applications.length === appsBefore.length &&
  afterPurge.json.applications.find((a) => a.id === linked.id).leadId === "",
  JSON.stringify(afterPurge.json.applications.find((a) => a.id === linked.id) || null));
check("B's identically-keyed live track is untouched",
  (await req("GET", "/api/data", { token: B_TOK })).json.leads.some((l) => l.search === "SWE"));
const twice = await req("POST", "/api/purge", { admin: true, body: { user: "Ada", search: "SWE" } });
check("purging again is a no-op, not an error",
  twice.status === 200 && twice.json.purged.leads === 0, twice.text.slice(0, 120));


// Why the current password is required and the scheduled search's session
// survives: POST /api/password in src/routes/accounts.js.
console.log("\n== changing your own password ==");
const PW_RUN = Date.now().toString(36);
const pwName = `Pip ${PW_RUN}`;
await req("POST", "/api/users", { admin: true, body: { name: pwName, password: "pip-first-password" } });

// Three sessions: the browser doing the change, another browser, and the
// long-lived one a scheduled search would hold.
const pwHere = (await req("POST", "/api/login", { body: { name: pwName, password: "pip-first-password", label: "browser" } })).json.token;
const pwOther = (await req("POST", "/api/login", { body: { name: pwName, password: "pip-first-password", label: "browser" } })).json.token;
const pwSearch = (await req("POST", "/api/login", { body: { name: pwName, password: "pip-first-password", label: "scheduled-search" } })).json.token;

check("changing a password needs a session at all",
  (await req("POST", "/api/password", { body: { currentPassword: "pip-first-password", newPassword: "pip-second-password" } })).status === 401);
check("the current password is required, not just the token",
  (await req("POST", "/api/password", { token: pwHere, body: { newPassword: "pip-second-password" } })).status === 400);
check("a wrong current password is refused",
  (await req("POST", "/api/password", { token: pwHere, body: { currentPassword: "not-my-password", newPassword: "pip-second-password" } })).status === 403);
check("and that refusal does not change anything",
  (await req("POST", "/api/login", { body: { name: pwName, password: "pip-first-password" } })).status === 200);
check("a new password under 12 characters is refused",
  (await req("POST", "/api/password", { token: pwHere, body: { currentPassword: "pip-first-password", newPassword: "short" } })).status === 400);
check("the length rule is checked before the current password, so the two answers can't be confused",
  (await req("POST", "/api/password", { token: pwHere, body: { currentPassword: "wrong-entirely", newPassword: "short" } })).status === 400);
check("re-setting the same password is refused rather than silently doing nothing",
  (await req("POST", "/api/password", { token: pwHere, body: { currentPassword: "pip-first-password", newPassword: "pip-first-password" } })).status === 400);

// The default: no revocation at all, matching what POST /api/users does.
const pwPlain = await req("POST", "/api/password", {
  token: pwHere, body: { currentPassword: "pip-first-password", newPassword: "pip-second-password" } });
check("a valid change succeeds", pwPlain.status === 200 && pwPlain.json.ok === true, pwPlain.text.slice(0, 120));
check("and signs nobody out unless asked", pwPlain.json.signedOut === 0);
check("the new password works", (await req("POST", "/api/login", { body: { name: pwName, password: "pip-second-password" } })).status === 200);
check("the old one doesn't", (await req("POST", "/api/login", { body: { name: pwName, password: "pip-first-password" } })).status === 401);
check("every existing session still works - a change is not a logout",
  (await req("GET", "/api/me", { token: pwHere })).status === 200 &&
  (await req("GET", "/api/me", { token: pwOther })).status === 200 &&
  (await req("GET", "/api/me", { token: pwSearch })).status === 200);

// Opting in. The one that must not take the search's token with it.
const pwSwept = await req("POST", "/api/password", {
  token: pwHere, body: { currentPassword: "pip-second-password", newPassword: "pip-third-password", signOutOthers: true } });
// Not asserted as an exact number. Several checks above prove a password by
// logging in with it, and every one of those mints a real `browser` session -
// so the honest count here is "the one opened as pwOther, plus however many
// assertions logged in". What actually matters is checked on its own three
// lines below.
check("signing out other browsers reports how many",
  pwSwept.status === 200 && typeof pwSwept.json.signedOut === "number" && pwSwept.json.signedOut >= 1,
  pwSwept.text.slice(0, 120));
check("the other browser is signed out", (await req("GET", "/api/me", { token: pwOther })).status === 401);
check("the browser that made the change is not", (await req("GET", "/api/me", { token: pwHere })).status === 200);
check("**the scheduled search's token survives**", (await req("GET", "/api/me", { token: pwSearch })).status === 200);
check("and it is still that person's", (await req("GET", "/api/me", { token: pwSearch })).json.name === pwName);

// A fixture of its own rather than Ada's token: by this point in the file Ada
// has been logged out and re-logged-in several times, and a revoked token
// would answer 401 at the routing layer - passing this check for entirely the
// wrong reason, and never exercising the handler at all.
await req("POST", "/api/users", { admin: true, body: { name: `Quill ${PW_RUN}`, password: "quill-long-password" } });
const pwStranger = (await req("POST", "/api/login", { body: { name: `Quill ${PW_RUN}`, password: "quill-long-password" } })).json.token;
check("a live session belonging to someone else cannot change this person's password",
  (await req("POST", "/api/password", { token: pwStranger, body: { currentPassword: "pip-third-password", newPassword: "stolen-password-x" } })).status === 403);
check("and Pip's password is untouched by that attempt",
  (await req("POST", "/api/login", { body: { name: pwName, password: "pip-third-password" } })).status === 200);

console.log("\n== unscreening: the way back from a wrong delist ==");
// Runs against B, whose SWE track the purge section just proved is
// untouched. A screened row is a standing instruction to skip a url forever -
// dropKnownUrls honours it for leads too - so a lead delisted by mistake is
// not merely off the board, it is unrediscoverable. This is the undo.
const unUrl = `https://apply.example.com/careers/job/${Date.now()}?utm_source=x`;
const unBare = unUrl.split("?")[0];
await req("POST", "/api/screened", { token: B_TOK, body: { on: "2026-09-08", screened: [
  { search: "SWE", url: unUrl, company: "Example", reason: "posting taken down" } ] } });
const beforeUn = await req("GET", "/api/dedup/SWE", { token: B_TOK });
check("the screened row is there to begin with",
  beforeUn.json.screened.some((u) => u.startsWith(unBare)));
const blocked = await req("POST", "/api/leads", { token: B_TOK, body: { leads: [
  { search: "SWE", url: unUrl, company: "Example", title: "Senior Engineer" } ] } });
check("a screened url cannot be re-added as a lead - the trap being undone",
  (blocked.json.added || 0) === 0, JSON.stringify(blocked.json));

check("unscreen without a search is 400",
  (await req("POST", "/api/unscreen", { token: B_TOK, body: { urls: [unUrl] } })).status === 400);
check("unscreen without urls is 400",
  (await req("POST", "/api/unscreen", { token: B_TOK, body: { search: "SWE" } })).status === 400);
check("unscreen on an unknown track is 404, not a silent no-op",
  (await req("POST", "/api/unscreen", { token: B_TOK, body: { search: "nope", urls: [unUrl] } })).status === 404);
check("unscreen with no token is 401",
  (await req("POST", "/api/unscreen", { body: { search: "SWE", urls: [unUrl] } })).status === 401);

// Matched on canonical url: a caller working from a report rarely has the
// tracking params the row was stored with.
const undone = await req("POST", "/api/unscreen", { token: B_TOK, body: {
  search: "SWE", urls: [unBare, "https://example.com/never-screened"] } });
check("removes the row despite differing tracking params",
  undone.json.removed === 1, JSON.stringify(undone.json));
check("reports a url that matched nothing rather than swallowing it",
  undone.json.unmatched.length === 1, JSON.stringify(undone.json));
const afterUn = await req("GET", "/api/dedup/SWE", { token: B_TOK });
check("the screened row is gone",
  !afterUn.json.screened.some((u) => u.startsWith(unBare)));
const readd = await req("POST", "/api/leads", { token: B_TOK, body: { leads: [
  { search: "SWE", url: unUrl, company: "Example", title: "Senior Engineer" } ] } });
check("the posting is addable again - the recovery actually recovers",
  (readd.json.added || 0) === 1, JSON.stringify(readd.json));

// The guard that matters most: this route deletes rows, so it must be as
// user-scoped as every other one.
const aScreenUrl = `https://apply.example.com/careers/job/${Date.now()}9`;
await req("POST", "/api/screened", { token: A2, body: { on: "2026-09-08", screened: [
  { search: "DATA", url: aScreenUrl, company: "Example", reason: "no" } ] } });
const crossUn = await req("POST", "/api/unscreen", { token: B_TOK, body: {
  search: "SWE", urls: [aScreenUrl] } });
check("one user cannot unscreen another user's row",
  crossUn.json.removed === 0, JSON.stringify(crossUn.json));
check("the other user's row is still there afterwards",
  (await req("GET", "/api/dedup/DATA", { token: A2 })).json.screened.includes(aScreenUrl));

// The case that a fed_by rewrite alone misses. Screened rows reach the table
// by two writers that disagree about the key: a run's rejections are rewritten
// to the feeder, but a delisted lead's row is written under the tab the lead
// lived in. Unscreening has to span the group or it silently recovers half.
// Its own user, because by this point Ada's fed pair has been retired above.
const fedPw = "fed-undo-long-password";
await req("POST", "/api/users", { admin: true, body: { name: "FedUndo", password: fedPw } });
const F_TOK = (await req("POST", "/api/login", { body: { name: "FedUndo", password: fedPw } })).json.token;
await req("POST", "/api/config", { token: F_TOK, body: { tracks: [
  { key: "ENG", label: "Eng", full_description: "the feeder", sort_order: 0 },
  { key: "ENG-SENIOR", label: "Senior", full_description: "the fed tab", sort_order: 1, fed_by: "ENG" } ] } });

const fedUrl = `https://boards.example.com/jobs/${Date.now()}fed`;
await req("POST", "/api/leads", { token: F_TOK, body: { leads: [
  { search: "ENG-SENIOR", url: fedUrl, company: "Example", title: "Principal Engineer" } ] } });
check("a lead can be filed onto the fed tab",
  (await req("GET", "/api/data", { token: F_TOK })).json.leads.some((l) => l.url === fedUrl));
// Delisted by the feeder's name, the way a branched run reports - the row
// still lands under the fed tab, because delistLead writes it under the
// lead's own search.
await req("POST", "/api/delist", { token: F_TOK, body: {
  search: "ENG", on: "2026-09-08", urls: [fedUrl] } });
check("delisting it leaves a screened row behind",
  (await req("GET", "/api/dedup/ENG-SENIOR", { token: F_TOK })).json.screened.includes(fedUrl));
// Asked by the FEEDER's name, while the row sits under the fed key. Resolving
// through fed_by would look under ENG only and report 0.
const undoFed = await req("POST", "/api/unscreen", { token: F_TOK, body: {
  search: "ENG", urls: [fedUrl] } });
check("a delisted fed-tab row is reachable when asking by the feeder's name",
  undoFed.json.removed === 1, JSON.stringify(undoFed.json));
check("and the posting can go back on the board",
  ((await req("POST", "/api/leads", { token: F_TOK, body: { leads: [
    { search: "ENG-SENIOR", url: fedUrl, company: "Example", title: "Principal Engineer" } ] } })).json.added || 0) === 1);

console.log("\n== documents ==");
// The resumes and per-track baseline docs, which live in R2 rather than D1 (see
// src/r2.js). `wrangler dev --local` gives these a local bucket, so this needs
// no cloud R2 and no account with R2 enabled.
// A_TOK was revoked by the logout check in the sessions section, and a dead
// token here fails the writes while the "is it gone?" reads still pass - which
// looks like a partial feature rather than a dead credential.
const D_TOK = (await req("POST", "/api/login", {
  body: { name: "Ada", password: "ada-new-password-1" } })).json.token;
check("a fresh session for the document checks", !!D_TOK);

// Unique per run, like the shared-posting urls above. The cross-user check
// below asserts Bo has *no* document at this path, and re-running against the
// same local bucket would otherwise find the copy Bo wrote last time - a pass
// turning into a failure on the second run, for no change in the code.
const DOC = `docs/tracked_ENG_${Date.now()}_postings.md`;
const put1 = await req("PUT", `/api/documents/${DOC}`, {
  token: D_TOK, raw: "# Baseline\nAda's notes.", type: "text/markdown" });
check("a document can be written", put1.status === 200 && !!put1.json.etag, JSON.stringify(put1.json));

const index = await req("GET", "/api/documents", { token: D_TOK });
const row = (index.json.documents || []).find((d) => d.path === DOC);
check("it appears in the index with kind derived from its folder",
  !!row && row.kind === "docs" && row.content_type === "text/markdown", JSON.stringify(row));
check("the index reports the same etag and size the write did",
  row && row.etag === put1.json.etag && row.bytes === put1.json.bytes, JSON.stringify(row));
check("the index carries no bodies",
  row && !("body" in row) && !("content" in row), JSON.stringify(row));
check("reading it back returns what was written",
  (await req("GET", `/api/documents/${DOC}`, { token: D_TOK })).text === "# Baseline\nAda's notes.");

// The cross-user check that matters most here: a resume is the most private
// thing this deployment holds, and `Docs` prefixes every key with the caller's
// id, so Bo naming Ada's exact path reaches an object that isn't there.
check("another user gets 404 for the same document path",
  (await req("GET", `/api/documents/${DOC}`, { token: B_TOK })).status === 404);
await req("PUT", `/api/documents/${DOC}`, { token: B_TOK, raw: "BO", type: "text/markdown" });
check("and their write of that path is a separate object",
  (await req("GET", `/api/documents/${DOC}`, { token: D_TOK })).text === "# Baseline\nAda's notes.");
check("which they can read as their own",
  (await req("GET", `/api/documents/${DOC}`, { token: B_TOK })).text === "BO");

// Byte-identical round trip. Every byte value 0-255, because the failure this
// guards against - a body decoded as UTF-8 somewhere in the middle - corrupts
// exactly the high bytes a .docx or .pdf is full of and leaves ASCII intact.
const blob = new Uint8Array(256).map((_, i) => i);
await req("PUT", "/api/documents/resumes/Someone_Resume.pdf", {
  token: D_TOK, raw: blob, type: "application/pdf" });
const back = await req("GET", "/api/documents/resumes/Someone_Resume.pdf", { token: D_TOK, bytes: true });
check("a binary round-trips byte-identical",
  back.body.length === 256 && back.body.every((b, i) => b === i),
  `got ${back.body.length} bytes`);
check("and comes back with the content type it was stored with",
  back.headers.get("content-type") === "application/pdf");

// The conditional write the nightly run depends on. A run reads the doc at the
// start of a turn lasting many minutes and hands back an edited copy at the
// end; without this, anything written in between is erased by a copy made
// before it existed.
const stale = put1.json.etag;
const put2 = await req("PUT", `/api/documents/${DOC}`, {
  token: D_TOK, raw: "# Baseline v2", type: "text/markdown", ifMatch: stale });
check("a conditional write with the current etag succeeds", put2.status === 200);
const clobber = await req("PUT", `/api/documents/${DOC}`, {
  token: D_TOK, raw: "# CLOBBER", type: "text/markdown", ifMatch: stale });
check("the same etag a second time is 412", clobber.status === 412, JSON.stringify(clobber.json));
check("and the 412 wrote nothing",
  (await req("GET", `/api/documents/${DOC}`, { token: D_TOK })).text === "# Baseline v2");
// curl users echo back the quoted header spelling; the property form is bare.
// A mismatch between the two would look exactly like a real conflict.
check("a quoted etag is accepted as If-Match",
  (await req("PUT", `/api/documents/${DOC}`, { token: D_TOK, raw: "# v3",
    type: "text/markdown", ifMatch: `"${put2.json.etag}"` })).status === 200);

// The runner writes these paths to a real directory, so a path that escapes the
// three known folders is a write-anywhere primitive on that machine. Note the
// two refusal codes: `..` is normalised out of the URL before routing and 404s
// on no matching route, while an encoded or malformed path reaches the
// validator and 400s. Both refuse; asserting only one would miss a regression
// in the other.
for (const bad of ["docs/sub/nested.md", "wat/x.md", "docs/.hidden", "docs/", "docs/..%2Fx.md"]) {
  check(`"${bad}" is refused by the path validator`,
    (await req("PUT", `/api/documents/${bad}`, { token: D_TOK, raw: "x" })).status === 400);
}

// Names Windows will not store as given. These are not traversal - they are
// accepted-then-renamed, which is worse, because the runner materializes each
// document to a real file and decides what to send back by hashing what it
// finds there. A name the filesystem alters is a document that comes back under
// a different path, silently, leaving the original orphaned.
for (const hostile of ["docs/trailing_space.md ", "docs/trailing_dot.md."]) {
  check(`"${hostile}" is refused - Windows would rename it`,
    (await req("PUT", `/api/documents/${encodeURI(hostile)}`, { token: D_TOK, raw: "x" })).status === 400);
}
// Stricter than Windows strictly needs: a name ending in a hyphen is legal
// there, and the rule refuses it anyway because "starts and ends with a word
// character" is one condition rather than a list of characters to remember.
check('"docs/ends-with-hyphen-" is refused',
  (await req("PUT", "/api/documents/docs/ends-with-hyphen-", { token: D_TOK, raw: "x" })).status === 400);
// DOS device names, with and without an extension, in either case. On Windows
// these resolve to a device rather than a file: the write appears to succeed
// and the file is then reported as not existing.
for (const dev of ["docs/CON", "docs/PRN.md", "docs/aux.txt", "docs/com1.md", "docs/LPT9.md"]) {
  check(`"${dev}" is refused as a reserved device name`,
    (await req("PUT", `/api/documents/${dev}`, { token: D_TOK, raw: "x" })).status === 400);
}
// The near-misses, so the device rule cannot quietly widen into real names.
for (const ok of ["docs/console.md", "docs/auxiliary.md", "docs/company1.md", "docs/prnt.md",
                  "docs/name-.md", "docs/a.md", "docs/x"]) {
  check(`"${ok}" is still accepted`,
    (await req("PUT", `/api/documents/${ok}`, { token: D_TOK, raw: "x", type: "text/markdown" })).status === 200);
}

// Size. Every document is re-downloaded by every nightly run and every backup,
// so an unbounded upload is a cost paid twice a day rather than a storage bill.
const under = await req("PUT", "/api/documents/resumes/under_cap.pdf", {
  token: D_TOK, raw: new Uint8Array(1024 * 1024), type: "application/pdf" });
check("a 1 MB document is accepted", under.status === 200, JSON.stringify(under.json));
const over = await req("PUT", "/api/documents/resumes/over_cap.pdf", {
  token: D_TOK, raw: new Uint8Array(9 * 1024 * 1024), type: "application/pdf" });
check("a 9 MB document is refused with 413", over.status === 413, `got ${over.status}`);
check("and the oversized document was not stored",
  (await req("GET", "/api/documents/resumes/over_cap.pdf", { token: D_TOK })).status === 404);
for (const bad of ["../secrets.md", "docs/../../etc/passwd"]) {
  check(`"${bad}" never reaches a handler`,
    (await req("PUT", `/api/documents/${bad}`, { token: D_TOK, raw: "x" })).status === 404);
}

check("deleting a document works",
  (await req("DELETE", `/api/documents/${DOC}`, { token: D_TOK })).status === 200);
check("it is gone from the index",
  !((await req("GET", "/api/documents", { token: D_TOK })).json.documents || []).some((d) => d.path === DOC));
// R2's delete is happy to remove a key that was never there. Reporting success
// would tell a caller its cleanup worked when it was aiming at the wrong path.
check("deleting it again is 404",
  (await req("DELETE", `/api/documents/${DOC}`, { token: D_TOK })).status === 404);
check("the other user's copy survived that delete",
  (await req("GET", `/api/documents/${DOC}`, { token: B_TOK })).text === "BO");

// The preflight has to advertise PUT and DELETE, or a browser refuses the call
// before it is ever routed.
const preflight = await req("OPTIONS", "/api/documents");
const allowed = preflight.headers.get("access-control-allow-methods") || "";
check("the preflight advertises PUT and DELETE",
  allowed.includes("PUT") && allowed.includes("DELETE"), allowed);
check("and allows the If-Match header",
  (preflight.headers.get("access-control-allow-headers") || "").includes("If-Match"));

console.log("\n== shared company fetch intel ==");
// The shared table with no user_id (migrations/0010_company_fetch.sql). These
// checks are the boundary: website facts pool, search facts do not.
//
// Two throwaway users, deliberately. Ada and Bo carry controls other sections
// depend on - Bo is the account that has never swept anything, which the
// company coverage checks use to show another account's sweep dates and notes
// do not reach it - and coverage rows outlive a DELETE FROM users, so sweeping
// as Bo here would break that on the next run against the same database.
const ciPw = "company-intel-long-password";
const ciTok = {};
for (const n of ["IntelOne", "IntelTwo"]) {
  await req("POST", "/api/users", { admin: true, body: { name: n, password: ciPw } });
  ciTok[n] = (await req("POST", "/api/login", { body: { name: n, password: ciPw } })).json.token;
  await req("POST", "/api/config", { token: ciTok[n], body: { tracks: [
    { key: "ENG", label: "Eng", full_description: "x", sort_order: 0 } ] } });
}
const T1 = ciTok.IntelOne, T2 = ciTok.IntelTwo;

// A company named for this run. The list is shared and outlives a run, so a
// fixed name would carry the last run's sweep dates into this run's checks.
const ciRun = Date.now().toString(36);
const F5 = `F5 Networks ${ciRun}`;
const ciA = await req("POST", "/api/coverage", { token: T1, body: { search: "ENG",
  on: "2026-09-08", swept: [
    { company: F5, board: "workday cxs", endpoint: "ffive.wd5/f5jobs",
      note: "private note that must not travel" } ] } });
check("recording a sweep also writes a shared row", ciA.json.shared === 1, JSON.stringify(ciA.json));

await req("POST", "/api/coverage", { token: T2, body: { search: "ENG",
  on: "", swept: [{ company: F5.toLowerCase() }] } });
// ?all=1: the list is long, and F5 need not be in the slice this search is
// handed tonight. These checks are about what travels with it, not where it sits.
const bF5 = (await req("GET", "/api/coverage/ENG?all=1", { token: T2 }))
  .json.companies.find((c) => c.company.toLowerCase() === F5.toLowerCase());
check("another user's rotation receives the shared endpoint",
  bF5 && bF5.known && bF5.known.endpoint === "ffive.wd5/f5jobs", JSON.stringify(bF5));
check("company name matching is normalize()d, not exact",
  bF5 && bF5.known.board === "workday cxs");
check("the private note does NOT travel between users",
  bF5 && !JSON.stringify(bF5.known).includes("must not travel"), JSON.stringify(bF5.known));
check("no contributor identity is exposed",
  bF5 && !("verified_by" in bF5.known) && !JSON.stringify(bF5.known).includes("IntelOne"));
check("the other user's own sweep dates stay their own",
  bF5 && bF5.last_swept === "", JSON.stringify(bF5));

await req("POST", "/api/coverage", { token: T2, body: { search: "ENG",
  on: "2026-09-09", swept: [{ company: F5 }] } });
const stillThere = (await req("GET", "/api/coverage/ENG?all=1", { token: T2 }))
  .json.companies.find((c) => c.company.toLowerCase() === F5.toLowerCase());
check("a terse later sweep does not blank an established endpoint",
  stillThere.known && stillThere.known.endpoint === "ffive.wd5/f5jobs",
  JSON.stringify(stillThere.known));

// Named for this run, like F5 above: a fixed name is already on the shared list
// from earlier runs, carrying whatever those runs left on it.
const seededCo = `Seeded Co ${ciRun}`;
await req("POST", "/api/coverage", { token: T1, body: { search: "ENG",
  on: "", swept: [{ company: seededCo, board: "greenhouse" }] } });
const allView = (await req("GET", "/api/coverage/ENG?all=1", { token: T1 })).json.companies;
const seededRow = allView.find((c) => c.company === seededCo);
check("seeding (on: \"\") shares the board it was given, and still stamps no sweep",
  !!seededRow && !!seededRow.known && seededRow.known.board === "greenhouse" && seededRow.last_swept === "",
  JSON.stringify(seededRow));
check("the ?all=1 view carries intel too",
  allView.find((c) => c.company === F5).known.board === "workday cxs");

console.log("\n== one company list, and a wall that expires ==");
// 0011_one_company_list.sql. Membership is shared across accounts; each
// search's record of a company is not. A wall is a shared fact that has to be
// earned on two separate dates, and goes stale seven days after the last.
const olRun = Date.now().toString(36);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const sharedCo = `Shared Co ${olRun}`;
await req("POST", "/api/coverage", { token: T1, body: { search: "ENG", on: daysAgo(0),
  swept: [{ company: sharedCo, note: "IntelOne was here" }] } });
const t2Shared = (await req("GET", "/api/coverage/ENG?all=1", { token: T2 })).json.companies
  .find((c) => c.company === sharedCo);
check("a company one account sweeps joins every account's list",
  !!t2Shared, JSON.stringify(t2Shared));
check("but it is not stamped as swept for any other account",
  !!t2Shared && t2Shared.last_swept === "", JSON.stringify(t2Shared));
check("and the sweeping account's note stays with it",
  !!t2Shared && t2Shared.note === "", JSON.stringify(t2Shared));
check("a company nothing is known about carries no `known`",
  !!t2Shared && !("known" in t2Shared), JSON.stringify(t2Shared));

const wallCo = `Wall Co ${olRun}`;
const reportWall = (tok, on, extra) => req("POST", "/api/coverage", { token: tok, body: { search: "ENG", on,
  swept: [{ company: wallCo, ...extra }] } });
const wallRow = async () => (await req("GET", "/api/coverage/ENG?all=1", { token: T1 })).json.companies
  .find((c) => c.company === wallCo);
const servedWall = async () => { const r = await wallRow(); return r && r.known ? r.known.wall : undefined; };

await reportWall(T1, daysAgo(1), { wall: "403 on a plain fetch" });
check("a wall recorded on one date is not served yet", (await servedWall()) === undefined);
await reportWall(T2, daysAgo(1), { wall: "403 on a plain fetch" });
check("a second report on the same date is still one date, not two", (await servedWall()) === undefined);
await reportWall(T2, daysAgo(0), { wall: "403 on a plain fetch" });
check("a wall recorded on two separate dates is served to every search",
  (await servedWall()) === "403 on a plain fetch", JSON.stringify(await wallRow()));
const earned = await wallRow();
check("meeting a wall does not mark the row verified",
  !!earned && !!earned.known && earned.known.verified_on === "", JSON.stringify(earned && earned.known));
await reportWall(T1, daysAgo(0), { board: "greenhouse" });
check("a reported board clears the wall", (await servedWall()) === undefined, JSON.stringify(await wallRow()));

// A wall beside a board or endpoint in one row contradicts itself, and neither
// half can be trusted: a board copied from companies.json on a night the fetch
// failed would delete a true wall, and a wall kept over a board that really
// worked would have every search skip a reachable company. The row shares
// nothing; the sweep is still recorded.
const contraCo = `Contra Co ${olRun}`;
const reportContra = (tok, on, extra) => req("POST", "/api/coverage", { token: tok, body: { search: "ENG", on,
  swept: [{ company: contraCo, ...extra }] } });
await reportContra(T1, daysAgo(1), { wall: "403 on a plain fetch" });
await reportContra(T2, daysAgo(0), { wall: "403 on a plain fetch" });
const contra = await reportContra(T1, daysAgo(0), { wall: "403 on a plain fetch", board: "greenhouse", note: "Contra note" });
const contraRow = (await req("GET", "/api/coverage/ENG?all=1", { token: T1 })).json.companies
  .find((c) => c.company === contraCo);
check("a row reporting a wall beside a board shares neither, and counts as withheld",
  contra.json.withheld === 1 && !!contraRow && !!contraRow.known &&
  contraRow.known.wall === "403 on a plain fetch" && !contraRow.known.board,
  JSON.stringify({ withheld: contra.json.withheld, row: contraRow }));
check("but its sweep and note are still recorded",
  !!contraRow && contraRow.last_swept === daysAgo(0) && contraRow.note === "Contra note",
  JSON.stringify(contraRow));

// url_shape is not a route to the listings. Step 9e sends a run at a specific
// posting when the listing is walled, and a posting that loads beside a walled
// listing is both true at once - so that row shares as normal.
const shapeCo = `Shape Co ${olRun}`;
const shapeReport = { company: shapeCo, wall: "listing renders client-side", url_shape: "shapeco.example/jobs/<id>" };
await req("POST", "/api/coverage", { token: T2, body: { search: "ENG", on: daysAgo(1), swept: [shapeReport] } });
const shapeRes = await req("POST", "/api/coverage", { token: T1, body: { search: "ENG", on: daysAgo(0), swept: [shapeReport] } });
const shapeRow = (await req("GET", "/api/coverage/ENG?all=1", { token: T1 })).json.companies
  .find((c) => c.company === shapeCo);
check("a wall beside a url_shape is not a contradiction, and both are shared",
  shapeRes.json.withheld === 0 && !!shapeRow && !!shapeRow.known &&
  shapeRow.known.wall === "listing renders client-side" && shapeRow.known.url_shape === "shapeco.example/jobs/<id>",
  JSON.stringify({ withheld: shapeRes.json.withheld, row: shapeRow }));

// A demo account's companies are invented, and the list is shared, so the
// account is marked when it is provisioned, and the one route that writes the
// list refuses it - swept or seeded.
check("an account created without saying is a person", aCreate.json.demo === false, JSON.stringify(aCreate.json));
const demoName = `Demo ${olRun}`;
const demoCreate = await req("POST", "/api/users", { admin: true, body: { name: demoName, password: "demo-long-password", demo: true } });
check("POST /api/users marks an account as a demo", demoCreate.status === 201 && demoCreate.json.demo === true,
  JSON.stringify(demoCreate.json));
const demoReset = await req("POST", "/api/users", { admin: true, body: { name: demoName, password: "demo-long-password" } });
check("and a password reset that does not say leaves the mark alone", demoReset.json.demo === true, JSON.stringify(demoReset.json));
const DEMO_TOK = (await req("POST", "/api/login", { body: { name: demoName, password: "demo-long-password" } })).json.token;
await req("POST", "/api/config", { token: DEMO_TOK, body: { tracks: [{ key: "ENG", label: "Eng" }] } });
const inventedCo = `Invented Co ${olRun}`;
const demoSwept = await req("POST", "/api/coverage", { token: DEMO_TOK, body: { search: "ENG", on: daysAgo(0),
  swept: [{ company: inventedCo, board: "greenhouse" }] } });
const demoSeeded = await req("POST", "/api/coverage", { token: DEMO_TOK, body: { search: "ENG", on: "",
  swept: [{ company: inventedCo }] } });
check("a demo account cannot write to the company list, swept or seeded",
  demoSwept.status === 403 && demoSeeded.status === 403, JSON.stringify([demoSwept.status, demoSeeded.status]));
check("and nothing it sent reached anyone's list",
  !(await req("GET", "/api/coverage/ENG?all=1", { token: T1 })).json.companies.some((c) => c.company === inventedCo));
const demoRead = await req("GET", "/api/coverage/ENG?all=1", { token: DEMO_TOK });
check("but a demo account still reads the shared list",
  demoRead.status === 200 && demoRead.json.total > 0, JSON.stringify({ status: demoRead.status, total: demoRead.json && demoRead.json.total }));

const staleCo = `Stale Wall ${olRun}`;
for (const on of [daysAgo(20), daysAgo(19)]) {
  await req("POST", "/api/coverage", { token: T1, body: { search: "ENG", on,
    swept: [{ company: staleCo, wall: "empty JS shell" }] } });
}
const staleWall = (await req("GET", "/api/coverage/ENG?all=1", { token: T1 })).json.companies
  .find((c) => c.company === staleCo);
check("an earned wall last seen more than seven days ago is not served, so the next run re-tests it",
  !!staleWall && (!staleWall.known || staleWall.known.wall === undefined), JSON.stringify(staleWall));

console.log("\n== invites and signup ==");
// A new person's only credential is an invite code, and the two routes that take
// one are public and unthrottled - so this is about what a code, or a guess at
// one, can and cannot do.
const invRun = Date.now().toString(36);
const invAdmin = (method, path, body) => req(method, path, { admin: true, body });
check("minting an invite needs ADMIN_TOKEN: no token is refused",
  (await req("POST", "/api/invites", { body: {} })).status === 401);
check("and so is a session token",
  (await req("POST", "/api/invites", { token: A_TOK, body: {} })).status === 401);
check("and so is a wrong admin token",
  (await req("GET", "/api/invites", { token: ADMIN + "x" })).status === 401);
const minted = await invAdmin("POST", "/api/invites", { note: `verify ${invRun}` });
check("an invite is minted with a 43-character code, open for 14 days",
  minted.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(minted.json.code) &&
  Math.round((Date.parse(minted.json.expires_at) - Date.parse(minted.json.created_at)) / 86400000) === 14,
  JSON.stringify(minted.json));
check("days outside 1-30 are refused with the documented message",
  (await invAdmin("POST", "/api/invites", { days: 31 })).json.error === "days must be a whole number from 1 to 30");
check("a note over 200 characters is refused",
  (await invAdmin("POST", "/api/invites", { note: "x".repeat(201) })).json.error === "note must be at most 200 characters");
check("an open invite checks as valid",
  (await req("GET", `/api/invite/${minted.json.code}`)).json.valid === true);
// The right length and alphabet, never minted.
const guess = minted.json.code.slice(0, 42) + (minted.json.code.endsWith("A") ? "B" : "A");
check("a wrong code of the right shape is refused as invalid",
  JSON.stringify((await req("GET", `/api/invite/${guess}`)).json) === JSON.stringify({ valid: false, reason: "invalid" }));
const guessSignup = await req("POST", "/api/signup", { body: { code: guess, name: `Guess ${invRun}`, password: "guess-long-password" } });
check("and signing up with it creates nothing",
  guessSignup.status === 410 && guessSignup.json.reason === "invalid" &&
  (await req("POST", "/api/login", { body: { name: `Guess ${invRun}`, password: "guess-long-password" } })).status !== 200,
  JSON.stringify(guessSignup.json));

const existingName = `Existing ${invRun}`;
await req("POST", "/api/users", { admin: true, body: { name: existingName, password: "existing-long-password" } });
const takenName = existingName.toUpperCase();
const taken = await req("POST", "/api/signup", { body: { code: minted.json.code, name: takenName, password: "takeover-long-password" } });
check("signup cannot take an existing name, in any case, and says so in the page's words",
  taken.status === 409 && taken.json.field === "name" &&
  taken.json.error === `The name “${takenName}” is already taken here — pick another.`, JSON.stringify(taken.json));
check("and it does not reset that account's password",
  (await req("POST", "/api/login", { body: { name: existingName, password: "existing-long-password" } })).status === 200 &&
  (await req("POST", "/api/login", { body: { name: existingName, password: "takeover-long-password" } })).status !== 200);
check("a taken name leaves the invite open for another try",
  (await req("GET", `/api/invite/${minted.json.code}`)).json.valid === true);
const newName = `New ${invRun}`;
const shortPw = await req("POST", "/api/signup", { body: { code: minted.json.code, name: newName, password: "short" } });
check("a short password is refused beside its field, and spends nothing",
  shortPw.status === 400 && shortPw.json.field === "password" &&
  (await req("GET", `/api/invite/${minted.json.code}`)).json.valid === true);
const signed = await req("POST", "/api/signup", { body: { code: minted.json.code, name: newName, password: "new-long-password" } });
check("an open invite and a free name make an account, signed in",
  signed.status === 201 && !!signed.json.token && signed.json.user.name === newName &&
  (await req("GET", "/api/me", { token: signed.json.token })).json.name === newName, JSON.stringify(signed.json));
const N_TOK = signed.json.token, N_ID = signed.json.user.id;
check("a spent invite checks as used",
  JSON.stringify((await req("GET", `/api/invite/${minted.json.code}`)).json) === JSON.stringify({ valid: false, reason: "used" }));
const spentAgain = await req("POST", "/api/signup", { body: { code: minted.json.code, name: `Second ${invRun}`, password: "second-long-password" } });
check("and signing up with it again fails, creating nothing",
  spentAgain.status === 410 && spentAgain.json.reason === "used" &&
  (await req("POST", "/api/login", { body: { name: `Second ${invRun}`, password: "second-long-password" } })).status !== 200);

// Three signups racing one invite: one account, however they interleave.
const raceCode = (await invAdmin("POST", "/api/invites", { note: `race ${invRun}` })).json.code;
const racers = await Promise.all([1, 2, 3].map((i) =>
  req("POST", "/api/signup", { body: { code: raceCode, name: `Racer ${invRun}-${i}`, password: "racer-long-password" } })));
const raceLogins = await Promise.all([1, 2, 3].map((i) =>
  req("POST", "/api/login", { body: { name: `Racer ${invRun}-${i}`, password: "racer-long-password" } })));
check("signups racing one invite make exactly one account",
  racers.filter((r) => r.status === 201).length === 1 &&
  racers.filter((r) => r.status === 410 && r.json.reason === "used").length === 2 &&
  raceLogins.filter((r) => r.status === 200).length === 1,
  JSON.stringify(racers.map((r) => [r.status, r.json && r.json.reason])));

const revokable = (await invAdmin("POST", "/api/invites", { note: `revoke ${invRun}` })).json;
const revoked = await invAdmin("POST", "/api/invites/revoke", { id: revokable.id });
check("an unused invite can be revoked, and revoking it again is harmless",
  revoked.status === 200 && revoked.json.state === "revoked" &&
  (await invAdmin("POST", "/api/invites/revoke", { id: revokable.id })).status === 200);
check("a revoked invite checks as revoked and signs nobody up",
  (await req("GET", `/api/invite/${revokable.code}`)).json.reason === "revoked" &&
  (await req("POST", "/api/signup", { body: { code: revokable.code, name: `Revoked ${invRun}`, password: "revoked-long-password" } })).json.reason === "revoked");
check("a used invite cannot be revoked",
  (await invAdmin("POST", "/api/invites/revoke", { id: minted.json.id })).status === 409);
const noSuchInvite = await invAdmin("POST", "/api/invites/revoke", { id: 999999999 });
check("revoking an unknown invite 404s with the documented message",
  noSuchInvite.status === 404 && noSuchInvite.json.error === "no such invite");

const ledger = (await invAdmin("GET", "/api/invites")).json.invites;
const ledgerRow = (id) => ledger.find((i) => i.id === id);
check("the ledger shows each invite's fate and the account it made, newest first",
  ledgerRow(minted.json.id)?.state === "used" && ledgerRow(minted.json.id)?.user?.name === newName &&
  ledgerRow(revokable.id)?.state === "revoked" && ledgerRow(revokable.id)?.user === null &&
  ledger.every((i, k) => k === 0 || i.created_at <= ledger[k - 1].created_at),
  JSON.stringify(ledgerRow(minted.json.id)));
check("and never a code",
  !JSON.stringify(ledger).includes(minted.json.code) && ledger.every((i) => !("code" in i) && !("code_hash" in i)));

console.log("\n== first-run setup ==");
const intakeRole = { name: "Engineering", titles: "Senior Software Engineer", company_kinds: "", rule_outs: "", min_pay: "" };
const baseAnswers = {
  page_title: `${newName}'s Job Search`, pronouns: "", resume_text: "Ten years of backend engineering.",
  resume_files: [], location_limits: "Texas ", locations_first: " Seattle, Portland, OR, Remote",
  location_note: "open to relocating",
  // Sent by a page built before the lists were stored as typed; ignored now.
  priority_locations: [{ label: "Seattle", anyOf: ["seattle"] }],
  roles: [intakeRole], never_work_for: "", preferences: "", work_scope: "Seattle, or remote in the US",
};
const postIntake = (tok, answers) => req("POST", "/api/intake", { token: tok, body: { answers } });
check("a new account has no setup yet",
  JSON.stringify((await req("GET", "/api/intake", { token: N_TOK })).json) === JSON.stringify({ intake: null }));
check("setup needs at least one role",
  (await postIntake(N_TOK, { ...baseAnswers, roles: [] })).json.field === "roles");
check("and each role needs the roles to search for",
  (await postIntake(N_TOK, { ...baseAnswers, roles: [{ ...intakeRole, titles: " " }] })).json.field === "roles");
check("setup needs a resume the run can find, and a named file that doesn't exist is not one",
  (await postIntake(N_TOK, { ...baseAnswers, resume_text: "", resume_files: ["resumes/missing.pdf"] })).json.field === "resume");
// The location answers are stored as typed (docs/location-settings-plan.md), so
// the only refusals are text that isn't text, or too much of it - named by the
// answer, which is where the form shows it.
for (const [why, answers, field] of [
  // Caught by the check every text answer gets, which names the answers as a whole.
  ["a list sent as anything but text", { locations_first: ["Seattle"] }, "answers"],
  ["a list longer than 4000 characters", { work_scope: "x".repeat(4001) }, "work_scope"],
  ["a note longer than 1000 characters", { location_note: "x".repeat(1001) }, "location_note"],
]) {
  check(`a location answer is refused: ${why}`,
    (await postIntake(N_TOK, { ...baseAnswers, ...answers })).json.field === field);
}
check("a refused setup stores nothing",
  (await req("GET", "/api/intake", { token: N_TOK })).json.intake === null);

// The scope check runs on the send, while the person is still on the form,
// rather than overnight (docs/instant-setup-plan.md).
check("setup needs somewhere the person can work",
  (await postIntake(N_TOK, { ...baseAnswers, work_scope: "  " })).json.field === "work_scope");
// Where location answers disagree the place is included rather than the send
// refused (docs/location-settings-plan.md).
const outsideScope = await postIntake(N_TOK, { ...baseAnswers, work_scope: "Berlin only" });
check("a scope that names none of the places ranked first is accepted, not refused",
  outsideScope.status === 200 && outsideScope.json?.ok === true, JSON.stringify(outsideScope.json));
check("a refused setup stores nothing and builds no tracks",
  (await req("GET", "/api/intake", { token: B_TOK })).json.intake === null &&
  (await req("GET", "/api/config", { token: B_TOK })).json.tracks.every((t) => t.key !== "engineering"));

// The account above sent successfully, so the rest of the send's effects are
// checked on a second one - the send is write-once.
const instInvite = await invAdmin("POST", "/api/invites", { note: `instant ${invRun}` });
const instName = `Instant ${invRun}`;
const instSignup = await req("POST", "/api/signup", {
  body: { code: instInvite.json.code, name: instName, password: "instant-long-password" } });
const I_TOK = instSignup.json.token, I_ID = instSignup.json.user.id;
const instAnswers = {
  ...baseAnswers, page_title: "", pronouns: "she/her", never_work_for: "Bad Corp, Worse Inc",
  roles: [intakeRole, { ...intakeRole, name: "Product & Design" }],
};
const built = await postIntake(I_TOK, instAnswers);
check("a sent setup answers with the tracks it built, not the tracker",
  built.status === 200 && built.json.ok === true &&
  JSON.stringify(built.json?.tracks) === JSON.stringify(["engineering", "product-design"]),
  JSON.stringify(built.json));
const builtConfig = (await req("GET", "/api/config", { token: I_TOK })).json;
check("the tracker exists the moment setup is sent: tabs, in form order, labelled as typed",
  builtConfig.tracks?.length === 2 &&
  builtConfig.tracks?.[0]?.key === "engineering" && builtConfig.tracks?.[0]?.label === "Engineering" &&
  builtConfig.tracks?.[1]?.label === "Product & Design" && builtConfig.tracks?.[1]?.sort_order === 1,
  JSON.stringify(builtConfig.tracks.map((t) => ({ key: t.key, label: t.label, sort_order: t.sort_order }))));
check("and the settings the form owns, with a title defaulted from the name",
  builtConfig.settings?.display_title === `${instName}'s Job Search` &&
  builtConfig.settings?.pronouns === "she/her" &&
  JSON.stringify(builtConfig.settings?.excluded_companies) === JSON.stringify(["Bad Corp", "Worse Inc"]),
  JSON.stringify(builtConfig.settings));
check("the location answers become the location settings, as typed and trimmed at the ends",
  builtConfig.settings?.search_locations === "Seattle, or remote in the US" &&
  builtConfig.settings?.excluded_locations === "Texas" &&
  builtConfig.settings?.priority_locations === "Seattle, Portland, OR, Remote" &&
  builtConfig.settings?.location_note === "open to relocating",
  JSON.stringify(builtConfig.settings));
check("nothing the run owns is written on send",
  builtConfig.tracks?.every((t) => t.role_search_line === "" && t.fit_clause === "" && t.schedule_time === "") &&
  !builtConfig.settings?.geo_scope_line, JSON.stringify(builtConfig.tracks[0]));
check("a second send is refused whatever the state - there is no re-send",
  (await postIntake(I_TOK, instAnswers)).status === 409);
check("one person's setup is invisible to another",
  (await req("GET", "/api/intake", { token: B_TOK })).json.intake === null);

// A half-built search must not run: prompt.js would otherwise compose one
// around its "roles matching the resume" default and a run would carry it out
// all night and report success.
const unwritten = await req("GET", "/api/prompt/engineering", { token: I_TOK });
check("a track with no role_search_line has no prompt, and the refusal names the field",
  unwritten.status === 409 && unwritten.json.field === "role_search_line", JSON.stringify(unwritten.json));

// The ownership split, in the direction the run could break it.
const formFieldWrite = await req("POST", "/api/writeup", { token: I_TOK, body: {
  search: "engineering", label: "Renamed", role_search_line: "engineering manager roles" } });
check("the write-up route refuses a form-owned field, naming it, rather than dropping it",
  formFieldWrite.status === 400 && formFieldWrite.json.field === "label", JSON.stringify(formFieldWrite.json));
check("and nothing in that call was written",
  (await req("GET", "/api/config", { token: I_TOK })).json.tracks?.[0]?.role_search_line === "");
const writeUp = await req("POST", "/api/writeup", { token: I_TOK, body: {
  search: "engineering", role_search_line: "engineering manager roles", fit_clause: "must be remote",
  schedule_time: "01:00", geo_scope_line: "Search the US." } });
check("the run writes its own fields, per-track and per-account, in one call",
  writeUp.status === 200 && writeUp.json.written?.includes("role_search_line") &&
  writeUp.json.written?.includes("geo_scope_line"), JSON.stringify(writeUp.json));
const afterWriteUp = (await req("GET", "/api/config", { token: I_TOK })).json;
check("and the form's fields come through it untouched",
  afterWriteUp.tracks?.[0]?.label === "Engineering" && afterWriteUp.tracks?.[0]?.sort_order === 0 &&
  afterWriteUp.settings?.display_title === `${instName}'s Job Search` &&
  afterWriteUp.settings?.priority_locations === "Seattle, Portland, OR, Remote" &&
  afterWriteUp.settings?.search_locations === "Seattle, or remote in the US",
  JSON.stringify({ label: afterWriteUp.tracks?.[0]?.label, title: afterWriteUp.settings?.display_title }));
check("a written-up track has a prompt again",
  (await req("GET", "/api/prompt/engineering", { token: I_TOK })).status === 200);
check("writing up a track twice is ordinary, since a retry night works on one that exists",
  (await req("POST", "/api/writeup", { token: I_TOK, body: {
    search: "engineering", role_search_line: "engineering roles, second pass" } })).status === 200);
check("the write-up route 404s an unknown track, and 400s a missing one",
  (await req("POST", "/api/writeup", { token: I_TOK, body: { search: "nope", fit_clause: "x" } })).status === 404 &&
  (await req("POST", "/api/writeup", { token: I_TOK, body: { fit_clause: "x" } })).status === 400);

// The other direction: an account whose tracks were built by the setup skill
// before it ever saw the form. Its send must not blank the config it has.
const preInvite = await invAdmin("POST", "/api/invites", { note: `preconfigured ${invRun}` });
const preName = `Preconfigured ${invRun}`;
const P_TOK = (await req("POST", "/api/signup", {
  body: { code: preInvite.json.code, name: preName, password: "preconfigured-password" } })).json.token;
await req("POST", "/api/config", { token: P_TOK, body: {
  tracks: [{ key: "engineering", label: "Set up by hand", role_search_line: "roles someone wrote", sort_order: 0 }] } });
await postIntake(P_TOK, baseAnswers);
const preAfter = (await req("GET", "/api/config", { token: P_TOK })).json;
check("a send relabels a track that already exists and leaves its write-up alone",
  preAfter.tracks?.[0]?.label === "Engineering" && preAfter.tracks?.[0]?.role_search_line === "roles someone wrote",
  JSON.stringify(preAfter.tracks[0]));

await req("PUT", `/api/documents/resumes/${invRun}.txt`, { token: N_TOK, raw: "Resume as a file.", type: "text/plain" });
const resumeFileInvite = await invAdmin("POST", "/api/invites", { note: `resume file ${invRun}` });
const RF_TOK = (await req("POST", "/api/signup", {
  body: { code: resumeFileInvite.json.code, name: `Resume file ${invRun}`, password: "resume-file-password" } })).json.token;
await req("PUT", `/api/documents/resumes/${invRun}.txt`, { token: RF_TOK, raw: "Resume as a file.", type: "text/plain" });
check("a resume file counts once it exists under resumes/",
  (await postIntake(RF_TOK, { ...baseAnswers, resume_text: "", resume_files: [`resumes/${invRun}.txt`] })).status === 200);

const demoIntake = await req("POST", "/api/users", { admin: true, body: { name: `Demo intake ${invRun}`, password: "demo-intake-password", demo: true } });
const DI_TOK = (await req("POST", "/api/login", { body: { name: `Demo intake ${invRun}`, password: "demo-intake-password" } })).json.token;
check("a demo account cannot send setup", (await postIntake(DI_TOK, baseAnswers)).status === 403);

const queue = await invAdmin("GET", "/api/intake/pending");
const queued = queue.json.intakes.find((i) => i.user.id === N_ID);
check("the onboarding run sees the waiting setup with its answers",
  queue.status === 200 && !!queued && queued.user.name === newName && queued.status === "pending" &&
  queued.answers.roles[0].titles === "Senior Software Engineer", JSON.stringify(queued));

const failedRun = await invAdmin("POST", "/api/intake/complete", { user: N_ID, status: "failed", note: "We couldn't read your resume." });
const afterFail = (await req("GET", "/api/intake", { token: N_TOK })).json.intake;
check("a failed run's note reaches the person as written",
  failedRun.status === 200 && afterFail.status === "failed" && afterFail.status_note === "We couldn't read your resume.");
// A failure is retried by the run with the same answers, not fixed by the
// person: nothing they could retype reaches the search.
check("a failed setup cannot be sent again, and stays in the run's queue for its retry",
  (await postIntake(N_TOK, baseAnswers)).status === 409 &&
  (await invAdmin("GET", "/api/intake/pending")).json.intakes.some((i) => i.user.id === N_ID));
// The give-up rule drops a failed setup three days after its attempt began.
// Only the near side is reachable here - nothing lets a test move `sent_at` -
// so this checks a fresh failure is still offered, and the rule's other side
// lives in the query.

// The page stops promising another night at `retries_end_at`, so it has to be
// the same instant the queue's rule stops offering the setup. The rule is a
// pure function of `sent_at` and the clock, so both sides of that instant are
// checked here directly.
const { retriesEndAt, retryCutoff, RETRY_NIGHTS } = await import("./src/onboarding.js");
check("the setup says when its retries end: sent_at plus the retry window, exactly",
  afterFail.retries_end_at === new Date(Date.parse(afterFail.sent_at) + RETRY_NIGHTS * 86400000).toISOString(),
  JSON.stringify({ sent_at: afterFail.sent_at, retries_end_at: afterFail.retries_end_at }));
const retryEnd = Date.parse(afterFail.retries_end_at);
check("the queue still offers the setup one millisecond before retries_end_at",
  afterFail.sent_at > retryCutoff(retryEnd - 1));
check("and has stopped offering it at retries_end_at itself",
  !(afterFail.sent_at > retryCutoff(retryEnd)));
check("a setup with no sent_at has no retry end",
  retriesEndAt("") === "" && retriesEndAt(undefined) === "" && retriesEndAt("not a date") === "");

check("marking a setup done closes it",
  (await invAdmin("POST", "/api/intake/complete", { user: N_ID, status: "done" })).status === 200 &&
  (await postIntake(N_TOK, baseAnswers)).status === 409);
check("done is final: completing it again is refused",
  (await invAdmin("POST", "/api/intake/complete", { user: N_ID, status: "failed", note: "late" })).status === 409);
check("completing an account that never sent a setup 404s",
  (await invAdmin("POST", "/api/intake/complete", { user: "00000000-0000-4000-8000-000000000000", status: "done" })).status === 404);
check("a done setup leaves the run's queue",
  !(await invAdmin("GET", "/api/intake/pending")).json.intakes.some((i) => i.user.id === N_ID));

const searchTok1 = await invAdmin("POST", "/api/tokens", { user: N_ID });
check("a search token is minted for the account, labelled scheduled-search",
  searchTok1.status === 201 && searchTok1.json.label === "scheduled-search" && searchTok1.json.replaced === 0 &&
  (await req("GET", "/api/me", { token: searchTok1.json.token })).json.name === newName,
  JSON.stringify({ ...searchTok1.json, token: undefined }));
const searchTok2 = await invAdmin("POST", "/api/tokens", { user: N_ID });
check("minting again replaces the last search token rather than adding to it",
  searchTok2.json.replaced === 1 &&
  (await req("GET", "/api/me", { token: searchTok1.json.token })).status === 401 &&
  (await req("GET", "/api/me", { token: searchTok2.json.token })).status === 200);
check("and leaves the person's browser session alone",
  (await req("GET", "/api/me", { token: N_TOK })).status === 200);
check("no search token for an account that doesn't exist, or a demo account",
  (await invAdmin("POST", "/api/tokens", { user: "00000000-0000-4000-8000-000000000000" })).status === 404 &&
  (await invAdmin("POST", "/api/tokens", { user: demoIntake.json.id })).status === 403);

for (const [method, path] of [
  ["POST", "/api/invites"], ["GET", "/api/invites"], ["POST", "/api/invites/revoke"],
  ["GET", "/api/intake/pending"], ["POST", "/api/intake/complete"], ["POST", "/api/tokens"],
]) {
  check(`${method} ${path} refuses a session token`,
    (await req(method, path, { token: N_TOK, body: method === "POST" ? {} : undefined })).status === 401);
}

console.log("\n== deleting an account ==");
// What a test account, or a person who asks to be forgotten, leaves behind.
// Nothing else can remove it: /api/purge works a track at a time, and
// POST /api/config refuses an empty track list, so retiring the last track
// leaves a placeholder behind.
const delRun = Date.now();
const goneInvite = await invAdmin("POST", "/api/invites", { note: `delete check ${delRun}` });
const goneName = `Gone ${delRun}`;
const goneSignup = await req("POST", "/api/signup", {
  body: { code: goneInvite.json.code, name: goneName, password: "gone-long-password-1" } });
const GONE_ID = goneSignup.json.user.id, GONE_TOK = goneSignup.json.token;
// A neighbour, created the same way, whose rows must be untouched by the delete.
const stayInvite = await invAdmin("POST", "/api/invites", { note: `delete neighbour ${delRun}` });
const stayName = `Stay ${delRun}`;
const staySignup = await req("POST", "/api/signup", {
  body: { code: stayInvite.json.code, name: stayName, password: "stay-long-password-1" } });
const STAY_ID = staySignup.json.user.id, STAY_TOK = staySignup.json.token;

// Give each of them a row in every table an account owns, so "everything went"
// is a claim about the whole schema rather than the two tables a test remembers.
const delSeedAccount = async (token, tag) => {
  const key = `DEL${tag}`;
  await req("POST", "/api/config", { token, body: {
    tracks: [{ key, label: "Delete me" }], page_title: `${tag}'s page` } });
  await req("POST", "/api/leads", { token, body: { leads: [
    { search: key, company: "Delete Co", title: "Engineer", url: `https://del.example.com/${tag}/${delRun}` }] } });
  const lead = (await req("GET", "/api/data", { token })).json.leads[0];
  await req("POST", `/api/leads/${lead.id}/status`, { token, body: { status: "Applied" } });
  // The seed sends the setup form too, so the account has two tracks: the one
  // posted here and the one that send built.
  // A different id, not just a different path: canonicalUrl keys on the ids in
  // a url, so a screened row sharing the lead's id reads as the same posting.
  await req("POST", "/api/screened", { token, body: { screened: [{ search: key,
      url: `https://del.example.com/${tag}/screened-${delRun + 1}`, company: "Screened Co", reason: "not a fit" }] } });
  await req("POST", "/api/runs", { token, body: { search: key, leads_added: 1, screened_added: 1 } });
  await req("POST", "/api/coverage", { token, body: { search: key, on: "",
    swept: [{ company: `Del Sweep ${delRun}` }] } });
  await req("POST", "/api/intake", { token, body: { answers: {
    resume_text: "a resume", work_scope: "Remote US", roles: [{ name: "Eng", titles: "Engineer" }] } } });
  await req("PUT", `/api/documents/resumes/${tag}_${delRun}.txt`, {
    token, raw: "resume text", type: "text/plain" });
  return key;
};
await delSeedAccount(GONE_TOK, "gone");
await delSeedAccount(STAY_TOK, "stay");

const delListLength = async () =>
  (await req("GET", `/api/coverage/DELstay?all=1`, { token: STAY_TOK })).json.total;
const delSharedBefore = await delListLength();

const delAdmin = (method, path, body) => req(method, path, { admin: true, body });
check("deleting an account refuses a session token, whoever it belongs to",
  (await req("DELETE", `/api/users/${GONE_ID}`, { token: GONE_TOK, body: { name: goneName } })).status === 401);
check("an id nobody has is a 404, and a missing name a 400",
  (await delAdmin("DELETE", "/api/users/00000000-0000-4000-8000-000000000000", { name: "x" })).status === 404 &&
  (await delAdmin("DELETE", `/api/users/${GONE_ID}`, {})).status === 400);
// The two references are the whole safety story: an id alone never deletes.
const mismatched = await delAdmin("DELETE", `/api/users/${GONE_ID}`, { name: stayName });
check("the right id with another account's name is refused, and removes nothing",
  mismatched.status === 409 &&
  (await req("GET", "/api/me", { token: GONE_TOK })).status === 200,
  JSON.stringify({ status: mismatched.status }));

const dryDel = await delAdmin("DELETE", `/api/users/${GONE_ID}`, { name: goneName, dryRun: true });
check("a dry run counts what would go, and goes through with nothing",
  dryDel.json.dryRun === true && dryDel.json.wouldDelete?.tracks === 2 && dryDel.json.wouldDelete?.leads === 1 &&
  dryDel.json.wouldDelete?.documents === 1 &&
  (await req("GET", "/api/me", { token: GONE_TOK })).status === 200,
  JSON.stringify(dryDel.json));

// The state a run that died between the two halves leaves: documents gone,
// rows still there. Deleting again has to finish it rather than refuse.
await req("DELETE", `/api/documents/resumes/gone_${delRun}.txt`, { token: GONE_TOK });
const delResult = await delAdmin("DELETE", `/api/users/${GONE_ID}`, { name: goneName });
check("a delete that follows a half-finished one completes it",
  delResult.status === 200 && delResult.json.deleted?.documents === 0 && delResult.json.deleted?.tracks === 2,
  JSON.stringify(delResult.json));
check("it reports what it removed, per table, the way /api/purge does",
  delResult.json.deleted?.leads === 1 && delResult.json.deleted?.applications === 1 &&
  delResult.json.deleted?.screened === 1 && delResult.json.deleted?.search_runs === 2 &&
  delResult.json.deleted?.company_sweeps === 1 && delResult.json.deleted?.intake === 1 &&
  delResult.json.deleted?.meta >= 1 && delResult.json.deleted?.sessions === 1,
  JSON.stringify(delResult.json.deleted));
check("the account is gone: its token is dead and its name can't sign in",
  (await req("GET", "/api/me", { token: GONE_TOK })).status === 401 &&
  (await req("POST", "/api/login", { body: { name: goneName, password: "gone-long-password-1" } })).status === 401);
check("and deleting it again is a 404, since there is nothing left to delete",
  (await delAdmin("DELETE", `/api/users/${GONE_ID}`, { name: goneName })).status === 404);

// The point of the whole feature, checked the way the isolation checks are:
// one account's deletion is invisible to another.
const delStayData = await req("GET", "/api/data", { token: STAY_TOK });
const delStayDocs = await req("GET", "/api/documents", { token: STAY_TOK });
check("the other account still has its session, rows and documents",
  delStayData.status === 200 && delStayData.json.leads?.length === 1 &&
  (delStayDocs.json?.documents || []).some((d) => d.path === `resumes/stay_${delRun}.txt`),
  JSON.stringify({ leads: delStayData.json.leads?.length, docs: (delStayDocs.json?.documents || []).length }));
check("the shared company list is untouched - those facts are everyone's",
  (await delListLength()) === delSharedBefore,
  JSON.stringify({ before: delSharedBefore, after: await delListLength() }));

// The delLedger outlives the account: an operator can still see who was invited
// and when, without the deleted person's name or id surviving in it.
const delLedger = (await invAdmin("GET", "/api/invites")).json.invites;
const delGoneRow = (delLedger || []).find((i) => i.note === `delete check ${delRun}`);
check("the invite that made it keeps its ledger row, used, with no account",
  !!delGoneRow && delGoneRow.state === "used" && !!delGoneRow.used_at && delGoneRow.user === null,
  JSON.stringify(delGoneRow));

console.log("\n== each search gets only its own documents ==");
// A person with two searches: each run should read its own tracking doc and
// resume, never the other search's (migrations/0017_track_documents.sql).
const sdRun = Date.now();
const sdUser = async (tag) => {
  const name = `Docs ${tag} ${sdRun}`;
  await req("POST", "/api/users", { admin: true, body: { name, password: `docs-${tag}-long-password` } });
  const token = (await req("POST", "/api/login", { body: { name, password: `docs-${tag}-long-password` } })).json.token;
  await req("POST", "/api/config", { token, body: { tracks: [
    { key: "SWE", label: "SWE", doc_file: "docs/tracked_swe_postings.md" },
    { key: "swe-ai", label: "AI", fed_by: "SWE" },
    { key: "CPM", label: "CPM", doc_file: "docs/tracked_cpm_postings.md" },
  ] } });
  return token;
};
const SD = await sdUser("a"), SD_B = await sdUser("b");
for (const path of ["docs/tracked_swe_postings.md", "docs/tracked_cpm_postings.md", "resumes/swe.txt", "resumes/cpm.txt", "reference/extra.txt"]) {
  await req("PUT", `/api/documents/${path}`, { token: SD, raw: `contents of ${path}`, type: "text/plain" });
}
const forSearch = (token, key) => req("GET", `/api/documents?search=${encodeURIComponent(key)}`, { token });
const paths = (res) => (res.json?.documents || []).map((d) => d.path).sort().join();

const unlisted = await forSearch(SD, "SWE");
check("a search with no documents listed is refused, naming the field",
  unlisted.status === 409 && unlisted.json?.field === "documents", JSON.stringify(unlisted.json));

const listedViaRun = await req("POST", "/api/writeup", { token: SD, body: {
  search: "SWE", documents: ["resumes/swe.txt", "resumes/swe.txt"] } });
check("the overnight run writes a search's documents through the write-up route",
  listedViaRun.status === 200 && (listedViaRun.json?.written || []).includes("documents"), JSON.stringify(listedViaRun.json));
const sweDocs = await forSearch(SD, "SWE");
check("a search is served its own tracking doc and resume, and nothing else of its person's",
  sweDocs.status === 200 && sweDocs.json?.search === "SWE" &&
  paths(sweDocs) === "docs/tracked_swe_postings.md,resumes/swe.txt" && sweDocs.json?.missing?.length === 0,
  JSON.stringify(sweDocs.json));
check("a tab another search fills is served that search's list",
  paths(await forSearch(SD, "swe-ai")) === "docs/tracked_swe_postings.md,resumes/swe.txt" &&
  (await forSearch(SD, "swe-ai")).json?.search === "SWE");
const configTracks = (await req("GET", "/api/config", { token: SD })).json?.tracks || [];
check("the config serves the list as a list, stored once however often it was named",
  JSON.stringify(configTracks.find((t) => t.key === "SWE")?.documents) === JSON.stringify(["resumes/swe.txt"]),
  JSON.stringify(configTracks.find((t) => t.key === "SWE")?.documents));

// The setup skill writes config through POST /api/config, reading it first; a
// track posted back as it was read has to be accepted.
const roundTrip = await req("POST", "/api/config", { token: SD, body: { tracks: configTracks.map((t) =>
  t.key === "CPM" ? { ...t, documents: ["resumes/cpm.txt", "resumes/not-uploaded.txt"] } : t) } });
check("config read and posted back is accepted, list included",
  roundTrip.status === 200, JSON.stringify(roundTrip.json));
const cpmDocs = await forSearch(SD, "CPM");
check("a listed document the tracker doesn't have is named in missing, not dropped",
  paths(cpmDocs) === "docs/tracked_cpm_postings.md,resumes/cpm.txt" &&
  JSON.stringify(cpmDocs.json?.missing) === JSON.stringify(["resumes/not-uploaded.txt"]), JSON.stringify(cpmDocs.json));
check("without a search, the listing is still everything - for the backup and the import",
  (await req("GET", "/api/documents", { token: SD })).json?.documents?.length === 5);

for (const [why, list] of [
  ["a path outside the document folders", ["../tracker.json"]],
  ["a string rather than a list", "resumes/swe.txt"],
  ["more than twenty", Array.from({ length: 21 }, (_, i) => `resumes/r${i}.txt`)],
]) {
  check(`a documents list is refused: ${why}`,
    (await req("POST", "/api/writeup", { token: SD, body: { search: "SWE", documents: list } })).json?.field === "documents" &&
    (await req("POST", "/api/config", { token: SD, body: { tracks: [{ key: "SWE", label: "SWE", documents: list }] } })).status === 400);
}
check("a refused list leaves the stored one as it was",
  paths(await forSearch(SD, "SWE")) === "docs/tracked_swe_postings.md,resumes/swe.txt");

check("another person's search of the same name is served nothing of this person's",
  (await forSearch(SD_B, "SWE")).status === 409 &&
  (await req("GET", "/api/documents", { token: SD_B })).json?.documents?.length === 0);
check("a search this person doesn't have is a 404",
  (await forSearch(SD, "NOPE")).status === 404);

console.log("\n== run logs ==");
// A search uploads its run's log as its last act, so a night's record doesn't
// live only on the machine that ran it. Two accounts share a track key here on
// purpose: a store keyed by track alone would hand one of them the other's log,
// and "unknown track" would hide that.
const logRun = Date.now();
const logUser = async (tag) => {
  const name = `Log ${tag} ${logRun}`;
  await req("POST", "/api/users", { admin: true, body: { name, password: `log-${tag}-long-password` } });
  const token = (await req("POST", "/api/login", { body: { name, password: `log-${tag}-long-password` } })).json.token;
  await req("POST", "/api/config", { token, body: { tracks: [{ key: "LOGS", label: "Logs" }] } });
  return { name, token };
};
const logA = await logUser("a"), logB = await logUser("b");
const earlier = "2026-09-15T08-00-01Z", later = "2026-09-16T08-00-01Z";
const putLog = (who, track, started, text) =>
  req("PUT", `/api/logs/${track}/${started}`, { token: who.token, raw: text, type: "text/plain" });

const firstPut = await putLog(logA, "LOGS", earlier, "===== starting LOGS =====\nfirst night\n");
check("a run's log is stored under its track and start time",
  firstPut.status === 200 && firstPut.json?.started === earlier && firstPut.json?.bytes > 0,
  JSON.stringify(firstPut.json));
await putLog(logA, "LOGS", later, "===== starting LOGS =====\nsecond night\n");
const logList = await req("GET", "/api/logs/LOGS", { token: logA.token });
check("a track's logs list newest first",
  logList.status === 200 && (logList.json?.logs?.map((l) => l.started) || []).join() === `${later},${earlier}`,
  JSON.stringify(logList.json));
const oneLog = await req("GET", `/api/logs/LOGS/${earlier}`, { token: logA.token });
check("and a log reads back exactly as it was written",
  oneLog.status === 200 && oneLog.text === "===== starting LOGS =====\nfirst night\n" &&
  (oneLog.headers.get("content-type") || "").startsWith("text/plain"), oneLog.text);

// An upload retried after a lost response must leave one log, not two.
await putLog(logA, "LOGS", earlier, "===== starting LOGS =====\nfirst night, sent again\n");
const afterRetry = await req("GET", "/api/logs/LOGS", { token: logA.token });
check("uploading the same run again replaces its log rather than adding one",
  afterRetry.json?.logs?.length === 2 &&
  ((await req("GET", `/api/logs/LOGS/${earlier}`, { token: logA.token })).text || "").includes("sent again"),
  JSON.stringify(afterRetry.json?.logs));

check("B, with a track of the same name, sees none of A's logs",
  (await req("GET", "/api/logs/LOGS", { token: logB.token })).json?.logs?.length === 0 &&
  (await req("GET", `/api/logs/LOGS/${earlier}`, { token: logB.token })).status === 404);
await putLog(logB, "LOGS", earlier, "B's own night\n");
check("and B writing a log with A's track and time leaves A's untouched",
  ((await req("GET", `/api/logs/LOGS/${earlier}`, { token: logA.token })).text || "").includes("sent again") &&
  (await req("GET", `/api/logs/LOGS/${earlier}`, { token: logB.token })).text === "B's own night\n");

check("a log for a track this person doesn't have is a 404",
  (await putLog(logA, "NOPE", earlier, "x")).status === 404 &&
  (await req("GET", "/api/logs/NOPE", { token: logA.token })).status === 404);
check("a start time in the wrong shape is a 400, before anything is written",
  (await putLog(logA, "LOGS", "2026-09-16 08:00", "x")).status === 400 &&
  (await putLog(logA, "LOGS", "..%2F..%2Fdocs", "x")).status === 400);
check("a log over the size cap is refused whole",
  (await putLog(logA, "LOGS", "2026-09-17T08-00-01Z", "x".repeat(2 * 1024 * 1024 + 1))).status === 413 &&
  !(await req("GET", "/api/logs/LOGS", { token: logA.token })).json?.logs?.some((l) => l.started === "2026-09-17T08-00-01Z"));
check("logs require a session",
  (await req("GET", "/api/logs/LOGS")).status === 401 &&
  (await req("PUT", `/api/logs/LOGS/${earlier}`, { raw: "x", type: "text/plain" })).status === 401);

// A log is not a document: it must not appear in the list the backup copies and
// the documents routes edit. A real document is put first, so an empty list
// can't pass for a correct one.
await req("PUT", `/api/documents/docs/tracked_LOGS_${logRun}_postings.md`, { token: logA.token, raw: "# Baseline", type: "text/markdown" });
const logDocs = (await req("GET", "/api/documents", { token: logA.token })).json.documents || [];
check("logs never appear among a person's documents",
  logDocs.length === 1 && logDocs[0].path === `docs/tracked_LOGS_${logRun}_postings.md`,
  JSON.stringify(logDocs.map((d) => d.path)));

const logAId = (await req("GET", "/api/me", { token: logA.token })).json.id;
const logDry = await req("DELETE", `/api/users/${logAId}`, { admin: true, body: { name: logA.name, dryRun: true } });
const logGone = await req("DELETE", `/api/users/${logAId}`, { admin: true, body: { name: logA.name } });
check("deleting an account counts its logs and takes them with it",
  logDry.json.wouldDelete?.logs === 2 && logGone.json.deleted?.logs === 2,
  JSON.stringify({ dry: logDry.json.wouldDelete?.logs, deleted: logGone.json.deleted?.logs }));
check("and leaves the other account's logs alone",
  (await req("GET", "/api/logs/LOGS", { token: logB.token })).json?.logs?.length === 1);

console.log("\n== Word resumes are read on upload ==");
// docs/word-resumes-plan.md. The fixtures are real zip files built byte by byte
// here, so the worker's own reader and its DecompressionStream do the opening -
// including the two shapes Word and zip tools really write: an entry streamed
// with its sizes only in the central directory, and an entry stored uncompressed.
const { crc32, deflateRawSync } = await import("node:zlib");
function zipOf(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data: text, stored, streamed } of files) {
    const data = Buffer.from(text, "utf8");
    const body = stored ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const flags = streamed ? 0x8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    // A streamed entry's local header carries no sizes; they follow the data.
    local.writeUInt32LE(streamed ? 0 : crc, 14);
    local.writeUInt32LE(streamed ? 0 : body.length, 18); local.writeUInt32LE(streamed ? 0 : data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const descriptor = streamed ? Buffer.alloc(16) : Buffer.alloc(0);
    if (streamed) {
      descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(body.length, 8); descriptor.writeUInt32LE(data.length, 12);
    }
    locals.push(local, nameBytes, body, descriptor);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8); entry.writeUInt16LE(stored ? 0 : 8, 10); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length + descriptor.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
const wordXml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const contentTypes = { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types/>` };
const summary = "Staff engineer with twelve years building payment systems, data pipelines and the teams that run them. " +
  "Led the rewrite of a settlement service handling four million transactions a day, cut incident volume by half, " +
  "and mentored eleven engineers into senior roles across three product groups in two countries.";
const plainDocx = (extra = "") => zipOf([contentTypes, { name: "word/document.xml", streamed: true,
  data: wordXml(para("Jane Example") + para("Seattle &amp; remote") + para(summary + extra)) }]);
const plainText = `Jane Example\nSeattle & remote\n${summary}`;
const tableDocx = zipOf([contentTypes, { name: "word/document.xml", stored: true, data: wordXml(para(summary) +
  `<w:tbl><w:tr><w:tc>${para("Skill")}${para("set")}</w:tc><w:tc>${para("Years")}</w:tc></w:tr>` +
  `<w:tr><w:tc>${para("Go")}</w:tc><w:tc>${para("5")}</w:tc></w:tr></w:tbl>`) }]);
const imageDocx = zipOf([contentTypes, { name: "word/document.xml",
  data: wordXml(`<w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p>`) }]);

const wordUser = async (tag) => {
  const name = `Word ${tag} ${Date.now()}`;
  await req("POST", "/api/users", { admin: true, body: { name, password: `word-${tag}-long-password` } });
  return { name, token: (await req("POST", "/api/login", { body: { name, password: `word-${tag}-long-password` } })).json.token };
};
const W = await wordUser("a"), WB = await wordUser("b");
const putDoc = (who, path, body, type, ifMatch) => req("PUT", `/api/documents/${path}`, { token: who.token, raw: body, type, ifMatch });
const getText = async (who, path) => (await req("GET", `/api/documents/${path}`, { token: who.token })).text;
const wordPaths = async (who) => ((await req("GET", "/api/documents", { token: who.token })).json?.documents || []).map((d) => d.path).sort();
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const plain = await putDoc(W, "resumes/Jane_Resume.docx", plainDocx(), DOCX_TYPE);
check("a Word resume is read on upload, and the reply says which file and how many words",
  plain.status === 200 && plain.json?.text_path === "resumes/Jane_Resume.txt" &&
  plain.json?.words === plainText.split(/\s+/).filter(Boolean).length && !!plain.json?.etag,
  JSON.stringify(plain.json));
check("the text is paragraphs in order, one per line, entities decoded - from a streamed entry",
  (await getText(W, "resumes/Jane_Resume.txt")) === plainText, JSON.stringify(await getText(W, "resumes/Jane_Resume.txt")));
check("the Word file itself is stored as sent",
  (await wordPaths(W)).join() === "resumes/Jane_Resume.docx,resumes/Jane_Resume.txt");

const table = await putDoc(W, "resumes/Table_Resume.docx", tableDocx, DOCX_TYPE);
check("a table reads as a line per row with its cells tab-joined, a cell's paragraphs kept together - from a stored entry",
  table.status === 200 && (await getText(W, "resumes/Table_Resume.txt")).endsWith("\nSkill set\tYears\nGo\t5"),
  JSON.stringify(await getText(W, "resumes/Table_Resume.txt")));

const image = await putDoc(W, "resumes/Scanned_Resume.docx", imageDocx, DOCX_TYPE);
check("a Word file with no text in it - a scanned image - is refused, saying so, and nothing is stored",
  image.status === 422 && image.json?.words === 0 && image.json?.field === "resume" && /scanned image/.test(image.json?.error || "") &&
  !(await wordPaths(W)).some((p) => p.startsWith("resumes/Scanned_Resume")), JSON.stringify(image.json));
const notZip = await putDoc(W, "resumes/Renamed.docx", "this is plain text with a .docx name", DOCX_TYPE);
check("a file that isn't really a .docx is refused with a reason, and nothing is stored",
  notZip.status === 422 && /Renamed\.docx/.test(notZip.json?.error || "") &&
  !(await wordPaths(W)).some((p) => p.startsWith("resumes/Renamed")), JSON.stringify(notZip.json));
const oldWord = await putDoc(W, "resumes/Old_Resume.doc", "not really a doc", "application/msword");
check("an older Word file is refused, asking for .docx or PDF",
  oldWord.status === 415 && oldWord.json?.field === "resume" && /Save it as \.docx or PDF and attach that/.test(oldWord.json?.error || ""), JSON.stringify(oldWord.json));

const handEdit = await putDoc(W, "resumes/Jane_Resume.txt", "a hand-edited replacement", "text/plain");
check("writing the text directly is refused, naming the Word file it is read from",
  handEdit.status === 409 && handEdit.json?.paired_with === "resumes/Jane_Resume.docx" && handEdit.json?.field === "resume" &&
  handEdit.json?.error === "This text is read from Jane_Resume.docx - replace that file instead.", JSON.stringify(handEdit.json));
check("and so is a name differing only in case, which is the same file on the disk a run uses",
  (await putDoc(W, "resumes/jane_resume.txt", "sneaky", "text/plain")).status === 409 &&
  (await getText(W, "resumes/Jane_Resume.txt")) === plainText);
check("removing the text on its own is refused the same way",
  (await req("DELETE", "/api/documents/resumes/Jane_Resume.txt", { token: W.token })).status === 409);

const staleWrite = await putDoc(W, "resumes/Jane_Resume.docx", plainDocx(" Also speaks Portuguese."), DOCX_TYPE, "not-the-etag");
check("a Word upload with a stale If-Match writes neither file",
  staleWrite.status === 412 && (await getText(W, "resumes/Jane_Resume.txt")) === plainText);
const replaced = await putDoc(W, "resumes/Jane_Resume.docx", plainDocx(" Also speaks Portuguese."), DOCX_TYPE, plain.json?.etag);
check("replacing the Word file replaces its text",
  replaced.status === 200 && (await getText(W, "resumes/Jane_Resume.txt")).endsWith("Also speaks Portuguese.") &&
  replaced.json?.words === plain.json?.words + 3, JSON.stringify(replaced.json));

// A text file already stored under another case of the name is the same file
// on a run's disk; the Word upload takes it over rather than leaving two.
await putDoc(W, "resumes/cased_resume.txt", "an older pasted resume", "text/plain");
const cased = await putDoc(W, "resumes/Cased_Resume.docx", plainDocx(), DOCX_TYPE);
check("a Word upload replaces a text file of the same name in another case",
  cased.status === 200 && (await wordPaths(W)).includes("resumes/Cased_Resume.txt") &&
  !(await wordPaths(W)).includes("resumes/cased_resume.txt"), JSON.stringify(await wordPaths(W)));

check("a .docx outside resumes/ is stored as a file and not read",
  (await putDoc(W, "reference/Notes.docx", plainDocx(), DOCX_TYPE)).json?.text_path === undefined &&
  !(await wordPaths(W)).includes("reference/Notes.txt"));
check("another person's resume text isn't paired with this person's Word file",
  (await putDoc(WB, "resumes/Jane_Resume.txt", "someone else's resume", "text/plain")).status === 200 &&
  (await getText(W, "resumes/Jane_Resume.txt")).endsWith("Also speaks Portuguese."));

const removed = await req("DELETE", "/api/documents/resumes/Jane_Resume.docx", { token: W.token });
check("removing the Word file removes its text with it",
  removed.status === 200 && JSON.stringify(removed.json?.removed) === JSON.stringify(["resumes/Jane_Resume.txt"]) &&
  !(await wordPaths(W)).some((p) => p.startsWith("resumes/Jane_Resume")), JSON.stringify(removed.json));
check("and a text file left unpaired can then be written directly",
  (await putDoc(W, "resumes/Jane_Resume.txt", "pasted instead", "text/plain")).status === 200);

const wordId = (await req("GET", "/api/me", { token: W.token })).json.id;
const beforeDelete = (await wordPaths(W)).length;
const wordGone = await req("DELETE", `/api/users/${wordId}`, { admin: true, body: { name: W.name } });
check("deleting the account takes every Word file and its text with it",
  wordGone.status === 200 && wordGone.json?.deleted?.documents === beforeDelete && beforeDelete >= 5,
  JSON.stringify({ before: beforeDelete, deleted: wordGone.json?.deleted?.documents }));


console.log("\n== choosing a search's resume ==");
// The account panel's resume section (docs/account-settings-plan.md#your-resume):
// which searches read which file, pointing a search at another one, and the
// profile mark its next run clears (migrations/0018_profile_stale.sql).
const rsUser = async (tag) => {
  const name = `Resumes ${tag} ${Date.now()}`;
  await req("POST", "/api/users", { admin: true, body: { name, password: `resumes-${tag}-long-password` } });
  const token = (await req("POST", "/api/login", { body: { name, password: `resumes-${tag}-long-password` } })).json.token;
  await req("POST", "/api/config", { token, body: { tracks: [
    { key: "SWE", label: "Eng - Gaming", doc_file: "docs/tracked_swe_postings.md" },
    { key: "swe-ai", label: "Eng - AI", fed_by: "SWE" },
    { key: "CPM", label: "Program", doc_file: "docs/tracked_cpm_postings.md" },
  ] } });
  return { name, token };
};
const R = await rsUser("a"), RB = await rsUser("b");
const sixtyWords = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
for (const [path, raw, type] of [
  ["docs/tracked_swe_postings.md", "# SWE\n## Candidate Profile\nold", "text/markdown"],
  ["docs/tracked_cpm_postings.md", "# CPM", "text/markdown"],
  ["resumes/Engineering.pdf", "%PDF-1.4 not really", "application/pdf"],
  ["resumes/Pasted.txt", sixtyWords, "text/plain"],
  ["resumes/Headshot.png", "not an image", "image/png"],
  ["reference/notes.txt", "reference notes", "text/plain"],
]) await putDoc(R, path, raw, type);
await putDoc(R, "resumes/AI_Roles.docx", plainDocx(), DOCX_TYPE);
await req("POST", "/api/writeup", { token: R.token, body: { search: "SWE", role_search_line: "engineering roles", documents: ["resumes/Engineering.pdf", "reference/notes.txt"] } });
await req("POST", "/api/writeup", { token: R.token, body: { search: "CPM", role_search_line: "program roles", documents: ["resumes/Engineering.pdf"] } });

const listing = async (who) => (await req("GET", "/api/documents", { token: who.token })).json?.documents || [];
const entry = async (who, path) => (await listing(who)).find((d) => d.path === path);
const usage = (d) => JSON.stringify((d?.used_by || []).map((u) => [u.search, u.tabs.join("+"), u.state]));
const settings = (who, body) => req("POST", "/api/settings", { token: who.token, body });
const searchDocs = async (who, key) => (await req("GET", `/api/documents?search=${key}`, { token: who.token })).json;

for (const [why, list, pattern] of [
  ["an empty list", [], /at least one document/],
  ["a Word file, which a run can't read", ["resumes/AI_Roles.docx"], /list the \.txt read from it/],
  ["a list with nothing a run can read", ["resumes/Headshot.png"], /none of these documents can be read/],
]) {
  const viaRun = await req("POST", "/api/writeup", { token: R.token, body: { search: "SWE", documents: list } });
  const viaConfig = await req("POST", "/api/config", { token: R.token, body: { tracks: [
    { key: "SWE", label: "Eng - Gaming", documents: list }, { key: "swe-ai", label: "Eng - AI", fed_by: "SWE" }, { key: "CPM", label: "Program" }] } });
  check(`a search left without a readable resume is refused on both write paths: ${why}`,
    viaRun.status === 400 && viaRun.json?.field === "documents" && pattern.test(viaRun.json?.error || "") &&
    viaConfig.status === 400 && pattern.test(viaConfig.json?.error || ""), JSON.stringify([viaRun.json, viaConfig.json]));
}
const readBack = (await req("GET", "/api/config", { token: R.token })).json?.tracks || [];
check("config read and posted back is accepted, a fed tab's empty list included",
  (await req("POST", "/api/config", { token: R.token, body: { tracks: readBack } })).status === 200);

const pdf = await entry(R, "resumes/Engineering.pdf");
check("the listing says which searches read a resume, with the tabs each fills",
  usage(pdf) === JSON.stringify([["SWE", "SWE+swe-ai", "reads"], ["CPM", "CPM", "reads"]]) && pdf?.readable === true && pdf?.words === null,
  JSON.stringify(pdf));
const pasted = await entry(R, "resumes/Pasted.txt");
check("a text resume carries its word count, and one no search lists is used by none",
  pasted?.words === 60 && pasted?.readable === true && usage(pasted) === "[]", JSON.stringify(pasted));
const word = await entry(R, "resumes/AI_Roles.docx"), wordText = await entry(R, "resumes/AI_Roles.txt");
check("a Word resume names its text and word count, and its text names the Word file",
  word?.text_path === "resumes/AI_Roles.txt" && word?.readable === true && word?.words === plain.json?.words &&
  wordText?.paired_with === "resumes/AI_Roles.docx" && wordText?.readable === false, JSON.stringify([word, wordText]));
check("a file no search can read is not offered",
  (await entry(R, "resumes/Headshot.png"))?.readable === false);
check("documents outside resumes/ carry no resume fields",
  (await entry(R, "reference/notes.txt"))?.used_by === undefined);

for (const [why, body, status, pattern] of [
  ["a key the panel doesn't own", { role_search_line: "anything" }, 400, /not a setting this page can change/],
  ["a search this person doesn't have", { resumes: { NOPE: "resumes/Pasted.txt" } }, 404, /unknown search/],
  ["a tab another search fills", { resumes: { "swe-ai": "resumes/Pasted.txt" } }, 400, /Eng - AI is filled by the Eng - Gaming search/],
  ["a file outside resumes/", { resumes: { SWE: "reference/notes.txt" } }, 400, /under resumes\//],
  ["a file that isn't stored", { resumes: { SWE: "resumes/Nothing.pdf" } }, 404, /no resume named Nothing\.pdf/],
  ["a file a search can't read", { resumes: { SWE: "resumes/Headshot.png" } }, 422, /can't read Headshot\.png/],
]) {
  const res = await settings(R, body);
  check(`choosing a resume is refused: ${why}`,
    res.status === status && pattern.test(res.json?.error || ""), JSON.stringify(res.json));
}
const halfBad = await settings(R, { resumes: { SWE: "resumes/AI_Roles.docx", CPM: "resumes/Nothing.pdf" } });
check("one refused search refuses the whole save, naming it, and changes nothing",
  halfBad.status === 404 && halfBad.json?.search === "CPM" && halfBad.json?.field === "resume" &&
  JSON.stringify((await searchDocs(R, "SWE"))?.documents?.map((d) => d.path)) ===
    JSON.stringify(["docs/tracked_swe_postings.md", "resumes/Engineering.pdf", "reference/notes.txt"]) &&
  (await searchDocs(R, "SWE"))?.profile_stale === null, JSON.stringify(halfBad.json));

const chose = await settings(R, { resumes: { SWE: "resumes/AI_Roles.docx", CPM: "resumes/AI_Roles.txt" } });
check("a save points each search at its resume - a Word file through its text - keeping other documents",
  chose.status === 200 &&
  JSON.stringify(chose.json?.resumes?.SWE) === JSON.stringify({ documents: ["resumes/AI_Roles.txt", "reference/notes.txt"], profile_pending: true }) &&
  JSON.stringify(chose.json?.resumes?.CPM) === JSON.stringify({ documents: ["resumes/AI_Roles.txt"], profile_pending: true }),
  JSON.stringify(chose.json));
const staleSwe = await searchDocs(R, "SWE");
check("the change marks the search's profile stale, with the file it was written from",
  !!staleSwe?.profile_stale?.since && staleSwe?.profile_stale?.was === "resumes/Engineering.pdf", JSON.stringify(staleSwe));
check("a tab the search fills reports the search's mark",
  JSON.stringify((await searchDocs(R, "swe-ai"))?.profile_stale) === JSON.stringify(staleSwe?.profile_stale));
check("the listing shows the new resume from the next run, and the old one until then",
  usage(await entry(R, "resumes/AI_Roles.docx")) === JSON.stringify([["SWE", "SWE+swe-ai", "from_next_run"], ["CPM", "CPM", "from_next_run"]]) &&
  usage(await entry(R, "resumes/Engineering.pdf")) === JSON.stringify([["SWE", "SWE+swe-ai", "until_next_run"], ["CPM", "CPM", "until_next_run"]]),
  usage(await entry(R, "resumes/AI_Roles.docx")) + usage(await entry(R, "resumes/Engineering.pdf")));

const secondChoice = await settings(R, { resumes: { SWE: "resumes/Pasted.txt" } });
const staleAgain = await searchDocs(R, "SWE");
check("a second change before a run keeps the file the profile was written from, and moves the mark",
  secondChoice.status === 200 && staleAgain?.profile_stale?.was === "resumes/Engineering.pdf" &&
  staleAgain?.profile_stale?.since !== staleSwe?.profile_stale?.since, JSON.stringify(staleAgain?.profile_stale));

const refusedRemove = await req("DELETE", "/api/documents/resumes/AI_Roles.docx", { token: R.token });
check("removing a resume a search reads is refused, naming the search the way the page says it",
  refusedRemove.status === 409 && JSON.stringify(refusedRemove.json?.searches) === JSON.stringify(["CPM"]) &&
  refusedRemove.json?.error === "Program reads this resume, so it can't be removed. Choose another resume for that search below first." &&
  (await entry(R, "resumes/AI_Roles.docx")) !== undefined, JSON.stringify(refusedRemove.json));
await settings(R, { resumes: { CPM: "resumes/Pasted.txt" } });
const twoReaders = await req("DELETE", "/api/documents/resumes/Pasted.txt", { token: R.token });
check("with two searches reading it, the refusal names both",
  twoReaders.status === 409 &&
  twoReaders.json?.error === "Eng - Gaming and Program read this resume, so it can't be removed. Choose another resume for them below first.",
  JSON.stringify(twoReaders.json));
check("removing a search's tracking doc is refused too",
  (await req("DELETE", "/api/documents/docs/tracked_swe_postings.md", { token: R.token })).status === 409);
check("a file the searches were switched away from can be removed before their next run",
  (await req("DELETE", "/api/documents/resumes/Engineering.pdf", { token: R.token })).status === 200 &&
  (await req("DELETE", "/api/documents/resumes/AI_Roles.docx", { token: R.token })).status === 200);

const markNow = (await searchDocs(R, "SWE"))?.profile_stale?.since;
const lateClear = await req("POST", "/api/writeup", { token: R.token, body: { search: "SWE", profile_refreshed: staleSwe?.profile_stale?.since } });
check("a run that read an older mark doesn't clear a newer change",
  lateClear.status === 200 && !(lateClear.json?.written || []).includes("profile_refreshed") &&
  (await searchDocs(R, "SWE"))?.profile_stale?.since === markNow, JSON.stringify(lateClear.json));
const cleared = await req("POST", "/api/writeup", { token: R.token, body: { search: "SWE", profile_refreshed: markNow } });
check("the run clears the mark it read, and says so",
  JSON.stringify(cleared.json?.written) === JSON.stringify(["profile_refreshed"]) && (await searchDocs(R, "SWE"))?.profile_stale === null &&
  usage(await entry(R, "resumes/Pasted.txt")).includes('["SWE","SWE+swe-ai","reads"]'), JSON.stringify(cleared.json));
check("the tab's own list is untouched, since only the search's is read",
  JSON.stringify((await req("GET", "/api/config", { token: R.token })).json?.tracks?.find((t) => t.key === "swe-ai")?.documents) === "[]");

const same = await settings(R, { resumes: { SWE: "resumes/Pasted.txt" } });
check("choosing the resume a search already reads changes nothing",
  same.json?.resumes?.SWE?.profile_pending === false && (await searchDocs(R, "SWE"))?.profile_stale === null, JSON.stringify(same.json));
await putDoc(R, "resumes/Pasted.txt", sixtyWords, "text/plain");
check("the same file sent secondChoice leaves the profile alone",
  (await searchDocs(R, "SWE"))?.profile_stale === null);
await putDoc(R, "resumes/Pasted.txt", `${sixtyWords} and more`, "text/plain");
const inPlace = await searchDocs(R, "SWE");
check("replacing a resume's contents under the same name marks the searches reading it",
  inPlace?.profile_stale?.was === "resumes/Pasted.txt" && (await entry(R, "resumes/Pasted.txt"))?.words === 62, JSON.stringify(inPlace?.profile_stale));

check("another person can't choose this person's resume for their own search of the same name",
  (await settings(RB, { resumes: { SWE: "resumes/Pasted.txt" } })).status === 404 &&
  (await searchDocs(RB, "SWE"))?.profile_stale === undefined);
check("and this person's searches are unchanged by it",
  JSON.stringify((await searchDocs(R, "SWE"))?.documents?.map((d) => d.path)) ===
  JSON.stringify(["docs/tracked_swe_postings.md", "resumes/Pasted.txt", "reference/notes.txt"]));

console.log("\n== cleaning up the shared company list ==");
// Merging two spellings of one employer and renaming an acquired one
// (src/company-clCleanup.js). The list is shared and outlives a run, so every
// name carries this run's stamp.
const clRun = Date.now();
const clUser = async (tag) => {
  const name = `Cleanup ${tag} ${clRun}`;
  await req("POST", "/api/users", { admin: true, body: { name, password: `clCleanup-${tag}-long-password` } });
  const token = (await req("POST", "/api/login", { body: { name, password: `clCleanup-${tag}-long-password` } })).json.token;
  await req("POST", "/api/config", { token, body: { tracks: [{ key: "SWE", label: "SWE" }] } });
  return token;
};
const CL_A = await clUser("a"), CL_B = await clUser("b");
const CL_KEEP = `Merge Keep ${clRun}`, CL_ABSORB = `Merge Absorb ${clRun}`, CL_OLD = `Acquired Co ${clRun}`, CL_NEW = `Acquirer Co ${clRun}`;
const clSweep = (token, on, swept) => req("POST", "/api/coverage", { token, body: { search: "SWE", on, swept } });
await clSweep(CL_A, "", [
  { company: CL_KEEP, endpoint: "https://keep.example/jobs" },
  { company: CL_ABSORB, board: "greenhouse", endpoint: "https://absorb.example/jobs", url_shape: "https://absorb.example/job/{id}", dead_signal: "404" },
  { company: CL_OLD, url_shape: "https://old-tenant.example/job/{id}" },
]);
await clSweep(CL_A, "2026-09-01", [{ company: CL_KEEP, note: "a on keep" }]);
await clSweep(CL_A, "2026-09-05", [{ company: CL_ABSORB }]);
await clSweep(CL_A, "2026-09-04", [{ company: CL_OLD, note: "a on old" }]);
await clSweep(CL_B, "2026-09-03", [{ company: CL_ABSORB, note: "b on absorb" }]);

const clAll = async (token) => (await req("GET", "/api/coverage/SWE?all=1", { token })).json;
const clFind = (list, name) => (list?.companies || []).find((c) => c.company === name);
const clBeforeA = await clAll(CL_A);
const clKeepPos = clFind(clBeforeA, CL_KEEP)?.position, clOldPos = clFind(clBeforeA, CL_OLD)?.position;
const clCleanup = (body) => req("POST", "/api/companies/cleanup", { admin: true, body });
const clBody = { merges: [{ keep: CL_KEEP, absorb: [CL_ABSORB] }], renames: [{ from: CL_OLD, to: CL_NEW, clear_facts: true }] };

check("cleaning up the company list needs the admin token",
  (await req("POST", "/api/companies/cleanup", { token: CL_A, body: clBody })).status === 401);
for (const [why, body, status] of [
  ["nothing asked for", {}, 400],
  ["a name not on the list", { merges: [{ keep: CL_KEEP, absorb: [`Nobody ${clRun}`] }] }, 404],
  ["a company named twice", { merges: [{ keep: CL_KEEP, absorb: [CL_ABSORB] }], renames: [{ from: CL_ABSORB, to: `Else ${clRun}` }] }, 400],
  ["a new name already on the list", { renames: [{ from: CL_OLD, to: CL_KEEP }] }, 409],
  ["a merge with nothing to absorb", { merges: [{ keep: CL_KEEP, absorb: [] }] }, 400],
]) {
  const res = await clCleanup(body);
  check(`a clCleanup is refused: ${why}`, res.status === status && !!res.json?.error, JSON.stringify(res.json));
}
const clPartBad = await clCleanup({ merges: [{ keep: CL_KEEP, absorb: [CL_ABSORB] }], renames: [{ from: `Nobody ${clRun}`, to: CL_NEW }] });
check("one refused change refuses the whole request, and nothing is written",
  clPartBad.status === 404 && !!clFind(await clAll(CL_A), CL_ABSORB));

const clDry = await clCleanup({ ...clBody, dryRun: true });
check("a dry run reports the changes and writes nothing",
  clDry.status === 200 && clDry.json?.dryRun === true && clDry.json?.changes?.length === 2 &&
  !!clFind(await clAll(CL_A), CL_ABSORB) && !!clFind(await clAll(CL_A), CL_OLD), JSON.stringify(clDry.json));

const clDone = await clCleanup(clBody);
const clAfterA = await clAll(CL_A), clAfterB = await clAll(CL_B);
const clKept = clFind(clAfterA, CL_KEEP);
check("a merge leaves one company, in the clKept one's place, and the absorbed one gone",
  clDone.status === 200 && clDone.json?.dryRun === false && clKept?.position === clKeepPos &&
  !clFind(clAfterA, CL_ABSORB) && clAfterA.total === clBeforeA.total - 1, JSON.stringify({ clKept, total: [clBeforeA.total, clAfterA.total] }));
check("the kept company's facts win, and the absorbed one fills only what was empty",
  clKept?.known?.endpoint === "https://keep.example/jobs" && clKept?.known?.board === "greenhouse" &&
  clKept?.known?.url_shape === "https://absorb.example/job/{id}" && clKept?.known?.dead_signal === "404", JSON.stringify(clKept?.known));
check("each search keeps one record of the company, the most recent sweep's, with the note it had",
  clKept?.last_swept === "2026-09-05" && clKept?.note === "a on keep", JSON.stringify(clKept));
check("a search that only knew the absorbed spelling has its record moved to the kept company",
  clFind(clAfterB, CL_KEEP)?.last_swept === "2026-09-03" && clFind(clAfterB, CL_KEEP)?.note === "b on absorb", JSON.stringify(clFind(clAfterB, CL_KEEP)));
const clRenamed = clFind(clAfterA, CL_NEW);
check("a rename keeps the company's place and each search's record under the new name",
  clRenamed?.position === clOldPos && clRenamed?.last_swept === "2026-09-04" && clRenamed?.note === "a on old" && !clFind(clAfterA, CL_OLD),
  JSON.stringify(clRenamed));
check("clear_facts drops what was known about the old careers site",
  !clRenamed?.known, JSON.stringify(clRenamed?.known));
check("the search's cursor is untouched",
  clAfterA.cursor === clBeforeA.cursor);
const clRespelled = await clSweep(CL_A, "2026-09-06", [{ company: CL_NEW.toUpperCase() }]);
check("a run reporting the new name in another spelling lands on the clRenamed company",
  clRespelled.json?.added === 0 && clFind(await clAll(CL_A), CL_NEW)?.last_swept === "2026-09-06", JSON.stringify(clRespelled.json));


{
  console.log("\n== how far a run got through the rotation ==");
  // A run record counts the companies the search stamped with the run's date
  // (migrations/0019_run_swept.sql), so a thin night shows whether the rotation
  // was covered.
  const swRun = Date.now();
  const swName = `Swept ${swRun}`;
  await req("POST", "/api/users", { admin: true, body: { name: swName, password: "swept-long-password-1" } });
  const SW = (await req("POST", "/api/login", { body: { name: swName, password: "swept-long-password-1" } })).json.token;
  await req("POST", "/api/config", { token: SW, body: { tracks: [
    { key: "SWE", label: "SWE" },
    { key: "swe-ai", label: "AI", fed_by: "SWE" },
  ] } });
  const swToday = "2026-09-12", swYesterday = "2026-09-11";
  await req("POST", "/api/coverage", { token: SW, body: { search: "SWE", on: swYesterday,
    swept: [{ company: `Swept Old ${swRun}` }] } });
  await req("POST", "/api/coverage", { token: SW, body: { search: "SWE", on: swToday,
    swept: [{ company: `Swept A ${swRun}` }, { company: `Swept B ${swRun}` }, { company: `Swept C ${swRun}` }] } });

  const swRec = await req("POST", "/api/runs", { token: SW, body: { search: "SWE", status: "ok", on: swToday } });
  check("a run record says how many companies the search covered that date",
    swRec.status === 200 && swRec.json?.run?.swept === 3, JSON.stringify(swRec.json?.run));
  check("a tab the search fills records none of its own",
    swRec.json?.also?.[0]?.swept === 0, JSON.stringify(swRec.json?.also));
  const swConfig = (await req("GET", "/api/config", { token: SW })).json?.tracks || [];
  check("the count is served with the rest of the last run",
    swConfig.find((t) => t.key === "SWE")?.last_run?.swept === 3,
    JSON.stringify(swConfig.find((t) => t.key === "SWE")?.last_run));

  // The same companies re-stamped for a later date move with it: the sweep row
  // keeps only the latest date, which is what the count reads.
  const swLater = await req("POST", "/api/runs", { token: SW, body: { search: "SWE", status: "ok", on: swYesterday } });
  check("a run on another date counts only that date's companies",
    swLater.json?.run?.swept === 1, JSON.stringify(swLater.json?.run));
  // A second account with the same track key and the same company names: its
  // run must count none of the first account's sweeps.
  const swOtherName = `Swept other ${swRun}`;
  await req("POST", "/api/users", { admin: true, body: { name: swOtherName, password: "swept-long-password-2" } });
  const SW_B = (await req("POST", "/api/login", { body: { name: swOtherName, password: "swept-long-password-2" } })).json.token;
  await req("POST", "/api/config", { token: SW_B, body: { tracks: [{ key: "SWE", label: "SWE" }] } });
  check("another person's sweeps are never counted into this run",
    (await req("POST", "/api/runs", { token: SW_B, body: { search: "SWE", status: "ok", on: swToday } })).json?.run?.swept === 0);
}


{
  console.log("\n== a merged name keeps meaning the company it became ==");
  // Aliases (migrations/0020_company_aliases.sql): a name merged or renamed away
  // resolves to the company it became, so a run can't add it back.
  const alRun = Date.now();
  const alName = `Alias ${alRun}`;
  await req("POST", "/api/users", { admin: true, body: { name: alName, password: "alias-long-password-1" } });
  const AL = (await req("POST", "/api/login", { body: { name: alName, password: "alias-long-password-1" } })).json.token;
  await req("POST", "/api/config", { token: AL, body: { tracks: [{ key: "SWE", label: "SWE" }] } });
  const KEEP = `Alias Keep ${alRun}`, SHORT = `Alias Short ${alRun}`, OTHER = `Alias Other ${alRun}`;
  const NEWNAME = `Alias Renamed ${alRun}`, EXTRA = `Alias Extra ${alRun}`, ZED = `Alias Zed ${alRun}`;
  await req("POST", "/api/coverage", { token: AL, body: { search: "SWE", on: "", swept: [
    { company: KEEP }, { company: SHORT }, { company: OTHER }, { company: ZED }] } });
  const alAll = async () => (await req("GET", "/api/coverage/SWE?all=1", { token: AL })).json?.companies || [];
  const alFind = async (name) => (await alAll()).find((c) => c.company === name);
  const alClean = (body) => req("POST", "/api/companies/cleanup", { admin: true, body });
  const alSweep = (on, company) => req("POST", "/api/coverage", { token: AL, body: { search: "SWE", on, swept: [{ company }] } });

  const alDry = await alClean({ merges: [{ keep: KEEP, absorb: [SHORT] }], dryRun: true });
  check("a merge's dry run shows the absorbed name kept as an alias",
    JSON.stringify(alDry.json?.changes?.[0]?.aliases) === JSON.stringify([SHORT]), JSON.stringify(alDry.json));
  await alClean({ merges: [{ keep: KEEP, absorb: [SHORT] }] });
  check("the full list serves a company's aliases, for a run's own lookups",
    JSON.stringify((await alFind(KEEP))?.aliases) === JSON.stringify([SHORT]), JSON.stringify(await alFind(KEEP)));

  const alReport = await alSweep("2026-09-12", SHORT.toUpperCase());
  check("a run reporting a merged name in any spelling is recorded against the company it became, adding nothing",
    alReport.json?.aliased === 1 && alReport.json?.added === 0 &&
    (await alFind(KEEP))?.last_swept === "2026-09-12" && !(await alFind(SHORT)), JSON.stringify(alReport.json));

  const alAdd = await alClean({ aliases: [{ name: EXTRA, company: KEEP }, { name: EXTRA.toLowerCase(), company: KEEP }] });
  check("an alias is added by naming it and the company, and the server keeps the list - once per name",
    alAdd.status === 200 && JSON.stringify((await alFind(KEEP))?.aliases) === JSON.stringify([SHORT, EXTRA]),
    JSON.stringify([alAdd.json, (await alFind(KEEP))?.aliases]));
  check("adding the same alias again changes nothing",
    (await alClean({ aliases: [{ name: EXTRA, company: KEEP }] })).status === 200 &&
    JSON.stringify((await alFind(KEEP))?.aliases) === JSON.stringify([SHORT, EXTRA]));
  for (const [why, body, status] of [
    ["a name that is a company on the list", { aliases: [{ name: OTHER, company: KEEP }] }, 409],
    ["a name that already means another company", { aliases: [{ name: EXTRA, company: OTHER }] }, 409],
    ["a company that isn't on the list", { aliases: [{ name: `Nobody ${alRun}`, company: `Nowhere ${alRun}` }] }, 404],
  ]) {
    const res = await alClean(body);
    check(`an alias is refused: ${why}`, res.status === status && !!res.json?.error, JSON.stringify(res.json));
  }

  await alClean({ renames: [{ from: KEEP, to: NEWNAME }] });
  const alRenamed = await alFind(NEWNAME);
  check("a rename carries the aliases, and adds the old name to them",
    JSON.stringify(alRenamed?.aliases) === JSON.stringify([SHORT, EXTRA, KEEP]), JSON.stringify(alRenamed));
  check("so the oldest name still reaches the company through two changes",
    (await alSweep("2026-09-13", SHORT)).json?.aliased === 1 && (await alFind(NEWNAME))?.last_swept === "2026-09-13");

  await alClean({ merges: [{ keep: ZED, absorb: [NEWNAME] }] });
  check("merging a company carries its aliases to the one it joins",
    JSON.stringify((await alFind(ZED))?.aliases) === JSON.stringify([SHORT, EXTRA, KEEP, NEWNAME]), JSON.stringify(await alFind(ZED)));
  check("and a name that is not an alias still joins the list as before",
    (await alSweep("2026-09-14", `Alias Fresh ${alRun}`)).json?.added === 1);
  check("the nightly slice doesn't carry aliases, only the full list does",
    ((await req("GET", "/api/coverage/SWE", { token: AL })).json?.companies || []).every((c) => c.aliases === undefined));
}


{
  console.log("\n== a search not yet written up has no profile to go stale ==");
  // A new signup's search gets its resume before the overnight write-up has
  // run. Its write-up builds the profile from that resume, so a stale mark set
  // before then would send its first night down the profile-refresh path for
  // nothing (migrations/0018_profile_stale.sql).
  const nwRun = Date.now();
  const nwName = `Not written ${nwRun}`;
  await req("POST", "/api/users", { admin: true, body: { name: nwName, password: "not-written-long-password" } });
  const NW = (await req("POST", "/api/login", { body: { name: nwName, password: "not-written-long-password" } })).json.token;
  await req("POST", "/api/config", { token: NW, body: { tracks: [
    { key: "NEW", label: "New search" },
    { key: "OLD", label: "Written up" },
  ] } });
  // OLD has been written up; NEW is waiting for its first overnight run.
  await req("POST", "/api/writeup", { token: NW, body: { search: "OLD", role_search_line: "roles" } });
  for (const name of ["First.txt", "Second.txt"]) {
    await req("PUT", `/api/documents/resumes/${name}`, { token: NW, raw: `resume ${name} ${"word ".repeat(60)}`, type: "text/plain" });
  }
  const nwStale = async (key) => (await req("GET", `/api/documents?search=${key}`, { token: NW })).json?.profile_stale;

  const nwFirst = await req("POST", "/api/settings", { token: NW, body: { resumes: { NEW: "resumes/First.txt", OLD: "resumes/First.txt" } } });
  check("choosing a resume for a search not yet written up sets its documents, but marks nothing and reports nothing pending",
    nwFirst.status === 200 && JSON.stringify(nwFirst.json?.resumes?.NEW?.documents) === JSON.stringify(["resumes/First.txt"]) &&
    nwFirst.json?.resumes?.NEW?.profile_pending === false && (await nwStale("NEW")) === null,
    JSON.stringify([nwFirst.json?.resumes?.NEW, await nwStale("NEW")]));
  check("while a written-up search choosing a resume is marked as before",
    nwFirst.json?.resumes?.OLD?.profile_pending === true && !!(await nwStale("OLD"))?.since,
    JSON.stringify([nwFirst.json?.resumes?.OLD, await nwStale("OLD")]));

  await req("PUT", "/api/documents/resumes/First.txt", { token: NW, raw: `changed ${"word ".repeat(70)}`, type: "text/plain" });
  check("replacing the resume's contents doesn't mark a search not yet written up either",
    (await nwStale("NEW")) === null);

  // Once written up, the same search is marked like any other.
  await req("POST", "/api/writeup", { token: NW, body: { search: "NEW", role_search_line: "roles" } });
  await req("POST", "/api/settings", { token: NW, body: { resumes: { NEW: "resumes/Second.txt" } } });
  check("after its write-up, a search's resume change marks it stale",
    (await nwStale("NEW"))?.was === "resumes/First.txt", JSON.stringify(await nwStale("NEW")));
}


{
  console.log("\n== where a search looks, as the person typed it ==");
  // The location settings (docs/location-settings-plan.md): three lists and a
  // note, each stored as typed, trimmed at the ends, written by the person or
  // an operator and never by the overnight run.
  const lcRun = Date.now();
  const lcUser = async (tag) => {
    const name = `Locations ${tag} ${lcRun}`;
    await req("POST", "/api/users", { admin: true, body: { name, password: `locations-${tag}-long-password` } });
    const token = (await req("POST", "/api/login", { body: { name, password: `locations-${tag}-long-password` } })).json.token;
    await req("POST", "/api/config", { token, body: { tracks: [{ key: "SWE", label: "SWE" }] } });
    return token;
  };
  const LC = await lcUser("a"), LC_B = await lcUser("b");
  const lcSettings = async (token) => (await req("GET", "/api/config", { token })).json?.settings || {};

  const unset = await lcSettings(LC);
  check("an account that never set its places reads each as empty text",
    ["search_locations", "excluded_locations", "priority_locations", "location_note"].every((k) => unset[k] === ""),
    JSON.stringify(unset));

  const lcSave = await req("POST", "/api/settings", { token: LC, body: {
    search_locations: "  US, Greater Seattle area , Australia ",
    excluded_locations: "Portland, OR",
    priority_locations: "Seattle, Portland OR, Raleigh NC",
    location_note: "open to relocating for the right team",
  } });
  const saved = await lcSettings(LC);
  check("the account panel saves each list as typed, trimmed only at the ends",
    lcSave.status === 200 && saved.search_locations === "US, Greater Seattle area , Australia" &&
    saved.excluded_locations === "Portland, OR" && saved.priority_locations === "Seattle, Portland OR, Raleigh NC" &&
    saved.location_note === "open to relocating for the right team", JSON.stringify([lcSave.json, saved]));
  check("and says what it stored",
    lcSave.json?.locations?.search_locations === "US, Greater Seattle area , Australia");
  check("a list left out of a save keeps its value",
    (await req("POST", "/api/settings", { token: LC, body: { location_note: "" } })).status === 200 &&
    (await lcSettings(LC)).priority_locations === "Seattle, Portland OR, Raleigh NC" && (await lcSettings(LC)).location_note === "");

  for (const [why, body, field] of [
    ["a list that isn't text", { priority_locations: ["Seattle"] }, "priority_locations"],
    ["a list over 4000 characters", { search_locations: "x".repeat(4001) }, "search_locations"],
    ["a note over 1000 characters", { location_note: "x".repeat(1001) }, "location_note"],
  ]) {
    const res = await req("POST", "/api/settings", { token: LC, body });
    check(`a location setting is refused: ${why}, naming it`, res.status === 400 && res.json?.field === field, JSON.stringify(res.json));
  }
  const lcHalf = await req("POST", "/api/settings", { token: LC, body: { excluded_locations: "Nowhere", location_note: "x".repeat(1001) } });
  check("a refused save writes none of it",
    lcHalf.status === 400 && (await lcSettings(LC)).excluded_locations === "Portland, OR");
  check("a list 4000 characters long fits",
    (await req("POST", "/api/settings", { token: LC_B, body: { search_locations: "x".repeat(4000) } })).status === 200);

  const lcConfig = await req("POST", "/api/config", { token: LC, body: { priority_locations: " Boston " } });
  check("an operator can set them through the config too",
    lcConfig.status === 200 && (await lcSettings(LC)).priority_locations === "Boston", JSON.stringify(lcConfig.json));
  const lcBadConfig = await req("POST", "/api/config", { token: LC, body: {
    tracks: [{ key: "RENAMED", label: "Renamed" }], search_locations: 7 } });
  check("and a refused location setting there leaves the tracks alone",
    lcBadConfig.status === 400 && lcBadConfig.json?.field === "search_locations" &&
    (await req("GET", "/api/config", { token: LC })).json?.tracks?.[0]?.key === "SWE", JSON.stringify(lcBadConfig.json));
  check("the overnight run can't write them",
    (await req("POST", "/api/writeup", { token: LC, body: { search: "SWE", search_locations: "anywhere" } })).json?.field === "search_locations");
  check("another account's places are its own",
    (await lcSettings(LC_B)).priority_locations === "" && (await lcSettings(LC_B)).search_locations === "x".repeat(4000));
}


{
  console.log("\n== a migrated account's ranking rules, until the person types their own ==");
  // The stand-in rules (docs/location-settings-plan.md): an operator restores
  // the rules an account had, and the first different ranked list the person
  // saves drops them.
  const prRun = Date.now();
  const prUser = async (tag) => {
    const name = `Rules ${tag} ${prRun}`;
    await req("POST", "/api/users", { admin: true, body: { name, password: `rules-${tag}-long-password` } });
    const token = (await req("POST", "/api/login", { body: { name, password: `rules-${tag}-long-password` } })).json.token;
    await req("POST", "/api/config", { token, body: { tracks: [{ key: "SWE", label: "SWE" }] } });
    return token;
  };
  const PR = await prUser("a"), PR_B = await prUser("b");
  const prSettings = async (token) => (await req("GET", "/api/config", { token })).json?.settings || {};
  const kept = [
    { label: "Seattle area", anyOf: ["seattle", "bellevue", "redmond", "kirkland"] },
    { label: "Remote US", allOf: ["remote"] },
  ];

  check("an account with no stand-in rules reads them as an empty list",
    JSON.stringify((await prSettings(PR)).priority_rules) === "[]");
  const prRestore = await req("POST", "/api/config", { token: PR, body: {
    priority_locations: "Seattle area, Remote US", priority_rules: kept } });
  const restored = await prSettings(PR);
  check("an operator restores an account's rules alongside its list",
    prRestore.status === 200 && JSON.stringify(restored.priority_rules) === JSON.stringify(kept) &&
    restored.priority_locations === "Seattle area, Remote US", JSON.stringify(restored.priority_rules));
  check("and /api/data serves them to the page",
    JSON.stringify((await req("GET", "/api/data", { token: PR })).json?.settings?.priority_rules) === JSON.stringify(kept));

  // Rules set up by hand carry more than the page reads - a `tier`, long term
  // lists - and are restored exactly as stored.
  const handSet = [{ tier: "high", label: "Seattle area", anyOf: Array.from({ length: 30 }, (_, i) => `town ${i}`) }];
  check("rules as they were set up by hand are accepted as stored, extra fields included",
    (await req("POST", "/api/config", { token: PR_B, body: { priority_rules: handSet } })).status === 200 &&
    JSON.stringify((await prSettings(PR_B)).priority_rules) === JSON.stringify(handSet));
  for (const [why, rules] of [
    ["something other than a list", "Seattle"],
    ["a rule without a label", [{ anyOf: ["seattle"] }]],
    ["terms that aren't text", [{ label: "Seattle", anyOf: [42] }]],
    ["more than fifty rules", Array.from({ length: 51 }, (_, i) => ({ label: `L${i}`, anyOf: ["x"] }))],
  ]) {
    const res = await req("POST", "/api/config", { token: PR, body: { priority_rules: rules } });
    check(`stand-in rules are refused: ${why}`, res.status === 400 && res.json?.field === "priority_rules", JSON.stringify(res.json));
  }
  check("the person's own route can't write them",
    (await req("POST", "/api/settings", { token: PR, body: { priority_rules: kept } })).json?.field === "priority_rules");

  await req("POST", "/api/settings", { token: PR, body: { priority_locations: " Seattle area, Remote US ", location_note: "a note" } });
  check("saving the same ranked list again keeps them - a save of another field isn't an edit of the list",
    JSON.stringify((await prSettings(PR)).priority_rules) === JSON.stringify(kept));

  await req("POST", "/api/settings", { token: PR, body: { priority_locations: "Seattle, Bellevue, Remote US" } });
  const edited = await prSettings(PR);
  check("the first different list the person saves drops them, so their list rules",
    JSON.stringify(edited.priority_rules) === "[]" && edited.priority_locations === "Seattle, Bellevue, Remote US",
    JSON.stringify(edited.priority_rules));

  await req("POST", "/api/config", { token: PR_B, body: { priority_locations: "Boston", priority_rules: [{ label: "Boston", anyOf: ["boston"] }] } });
  await req("POST", "/api/config", { token: PR_B, body: { priority_locations: "Austin" } });
  check("an operator's different list drops them too, unless it sets them",
    JSON.stringify((await prSettings(PR_B)).priority_rules) === "[]");
  check("another account's rules are its own",
    JSON.stringify((await prSettings(PR)).priority_rules) === "[]" && (await prSettings(PR_B)).priority_locations === "Austin");
}


{
  console.log("\n== a lead carries the ranked place it falls in ==");
  // Areas (docs/location-settings-plan.md, "Each lead carries its area"): the
  // ranked list split on commas and trimmed, and an area kept when it names one
  // entry ignoring case, stored as that entry is spelled - never refused, stored
  // empty otherwise.
  const arRun = Date.now();
  const arUser = async (tag, ranked) => {
    const name = `Areas ${tag} ${arRun}`;
    await req("POST", "/api/users", { admin: true, body: { name, password: `areas-${tag}-long-password` } });
    const token = (await req("POST", "/api/login", { body: { name, password: `areas-${tag}-long-password` } })).json.token;
    await req("POST", "/api/config", { token, body: { tracks: [{ key: "SWE", label: "SWE" }], priority_locations: ranked } });
    return token;
  };
  // "Portland, OR" is two entries, "Portland" and "OR", by the rule.
  const AR = await arUser("a", "Seattle area, Portland, OR, Remote US");
  const AR_B = await arUser("b", "Boston");
  // Not the bare number: a long number in a path reads as the posting's id (url.js).
  const arUrl = (n) => `https://example.com/areas/${arRun.toString(36)}/${n}`;
  const arLead = (n, area) => ({ search: "SWE", company: "Acme", title: `Role ${n}`, location: "Kirkland, WA", url: arUrl(n), ...(area === undefined ? {} : { area }) });

  const arPost = await req("POST", "/api/leads", { token: AR, body: { leads: [
    arLead("exact", "Seattle area"), arLead("trimmed", " Remote US "), arLead("entry", "OR"),
    arLead("near", "Seattle"), arLead("case", "seattle area"), arLead("typed-whole", "Portland, OR"),
    arLead("none"),
  ] } });
  const arData = (await req("GET", "/api/data", { token: AR })).json;
  const areaOf = (n) => arData.leads.find((l) => l.url === arUrl(n))?.area;
  check("a lead's area is kept when it is one ranked entry, trimmed",
    arPost.status === 200 && arPost.json?.added === 7 &&
    areaOf("exact") === "Seattle area" && areaOf("trimmed") === "Remote US" && areaOf("entry") === "OR",
    JSON.stringify([arPost.json, areaOf("exact"), areaOf("trimmed"), areaOf("entry")]));
  check("an area in another case is stored as the ranked entry is spelled",
    areaOf("case") === "Seattle area", areaOf("case"));
  check("a near-miss, or a whole comma-separated phrase, is stored empty, not refused",
    areaOf("near") === "" && areaOf("typed-whole") === "" && areaOf("none") === "",
    JSON.stringify(["near", "typed-whole", "none"].map(areaOf)));
  check("and the reply counts the areas it emptied, but not a lead that sent none",
    arPost.json?.area_cleared === 2, JSON.stringify(arPost.json));

  const exactId = arData.leads.find((l) => l.url === arUrl("exact")).id;
  const applied = await req("POST", `/api/leads/${exactId}/status`, { token: AR, body: { status: "Applied" } });
  check("an application made from a lead carries its area",
    applied.json?.application?.area === "Seattle area", JSON.stringify(applied.json?.application));

  const byHand = await req("POST", "/api/update", { token: AR, body: { type: "application", link: arUrl("by-hand"), company: "", title: "" } });
  const byHandBad = await req("POST", "/api/update", { token: AR, body: { type: "application", link: arUrl("by-hand-bad"), area: "Seattle" } });
  check("an application added by hand starts with no area, and one sent with a near-miss is stored empty",
    byHand.json?.application?.area === "" && byHandBad.json?.application?.area === "", JSON.stringify([byHand.json, byHandBad.json]));
  const arFill = await req("POST", "/api/applications/autofill", { token: AR, body: { filled: [
    { id: byHand.json.application.id, company: "Acme", title: "Engineer", location: "Remote", area: "remote us" },
    { id: byHandBad.json.application.id, company: "Acme", title: "Engineer", location: "Austin, TX", area: "Austin" },
  ] } });
  const arApps = (await req("GET", "/api/data", { token: AR })).json.applications;
  check("the overnight fill sets a hand-added application's area, checked the same way",
    arFill.json?.filled === 2 && arFill.json?.area_cleared === 1 &&
    arApps.find((a) => a.id === byHand.json.application.id)?.area === "Remote US" &&
    arApps.find((a) => a.id === byHandBad.json.application.id)?.area === "",
    JSON.stringify(arFill.json));

  const arOther = await req("POST", "/api/leads", { token: AR_B, body: { leads: [arLead("other", "Seattle area")] } });
  check("an area is checked against the poster's own list, not anyone else's",
    arOther.json?.area_cleared === 1 &&
    (await req("GET", "/api/data", { token: AR_B })).json.leads.find((l) => l.url === arUrl("other"))?.area === "",
    JSON.stringify(arOther.json));
  check("a person can't set a lead's area by hand",
    (await req("POST", "/api/update", { token: AR, body: { type: "lead", id: exactId, area: "Remote US" } })).json?.lead?.area !== "Remote US");
}


{
  console.log("\n== filling areas on rows filed before areas existed ==");
  // The one-time fill (docs/location-settings-plan.md): an operator stores an
  // area on an account's existing rows, checked like every other area, only
  // where a row has none.
  const flRun = Date.now();
  const flUser = async (tag, ranked) => {
    const name = `Fill ${tag} ${flRun}`;
    await req("POST", "/api/users", { admin: true, body: { name, password: `fill-${tag}-long-password` } });
    const token = (await req("POST", "/api/login", { body: { name, password: `fill-${tag}-long-password` } })).json.token;
    await req("POST", "/api/config", { token, body: { tracks: [{ key: "SWE", label: "SWE" }], priority_locations: ranked } });
    return { name, token };
  };
  const FL = await flUser("a", "Seattle area, Remote US"), FL_B = await flUser("b", "Seattle area");
  const flUrl = (n) => `https://example.com/fill/${flRun.toString(36)}/${n}`;
  const flLead = (n, area) => ({ search: "SWE", company: "Acme", title: `Role ${n}`, location: "Kirkland, WA", url: flUrl(n), ...(area ? { area } : {}) });
  await req("POST", "/api/leads", { token: FL.token, body: { leads: [flLead("old"), flLead("filed", "Remote US"), flLead("other")] } });
  await req("POST", "/api/leads", { token: FL_B.token, body: { leads: [flLead("theirs")] } });
  const flData = async (who) => (await req("GET", "/api/data", { token: who.token })).json;
  const idOf = async (who, n) => (await flData(who)).leads.find((l) => l.url === flUrl(n)).id;
  const [oldId, filedId, otherId, theirsId] = [await idOf(FL, "old"), await idOf(FL, "filed"), await idOf(FL, "other"), await idOf(FL_B, "theirs")];
  const app = (await req("POST", "/api/update", { token: FL.token, body: { type: "application", link: flUrl("app") } })).json.application;
  const fill = (body) => req("POST", "/api/areas/fill", { admin: true, body: { user: FL.name, ...body } });
  const flBody = { leads: [{ id: oldId, area: "seattle area" }, { id: filedId, area: "Seattle area" }, { id: otherId, area: "Seattle" }, { id: theirsId, area: "Seattle area" }],
    applications: [{ id: app.id, area: "Remote US" }] };

  check("the fill needs the admin token",
    (await req("POST", "/api/areas/fill", { token: FL.token, body: { user: FL.name, ...flBody } })).status === 401);
  const flDry = await fill({ ...flBody, dryRun: true });
  check("a dry run counts what it would set and writes nothing",
    flDry.status === 200 && flDry.json?.leads?.set === 1 && flDry.json?.applications?.set === 1 && flDry.json?.area_cleared === 1 &&
    (await flData(FL)).leads.find((l) => l.id === oldId)?.area === "", JSON.stringify(flDry.json));
  const flDone = await fill(flBody);
  const after = await flData(FL);
  check("a row with no area gets it, spelled as the ranked entry",
    flDone.json?.leads?.set === 1 && after.leads.find((l) => l.id === oldId)?.area === "Seattle area", JSON.stringify(flDone.json));
  check("a row a run already filed keeps its area",
    after.leads.find((l) => l.id === filedId)?.area === "Remote US");
  check("an area that isn't a ranked entry is counted and not written",
    flDone.json?.area_cleared === 1 && after.leads.find((l) => l.id === otherId)?.area === "");
  check("an application gets its area too",
    after.applications.find((a) => a.id === app.id)?.area === "Remote US");
  check("another account's row, named in this account's fill, is untouched",
    (await flData(FL_B)).leads.find((l) => l.id === theirsId)?.area === "");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
