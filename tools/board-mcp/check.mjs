// Usage: node tools/board-mcp/check.mjs [--json]
//
// Checks the board reader: a set of cases that need nothing, and a set that reaches
// live boards. It exists so the server can be refactored - a reader that
// answers "gone" for a posting that is open takes a live posting off her board
// and hides it from later runs, and while the hiding is undoable
// (db.unscreenUrls) what she typed on the lead is not, so "I only moved code
// around" is not something anyone should take on trust.
//
// It names no company and asserts no count. Which employers a search covers,
// and which one an account excludes, are that account's business and this file
// is public - so every live case picks its own subject out of whatever the list
// serves at run time, by the property the case is about: a company with a
// greenhouse endpoint, a company with no machine-readable endpoint, and so on.
// That also makes the cases survive the list changing under them.
//
// A failure can be the world moving rather than the code breaking - a board
// changes shape, a posting closes - so each case says what it is really
// asserting, and the live cases avoid pinning values that rot: the gone case
// uses an id fabricated to be absent rather than a req that was once real.
//
// The live set needs TRACKER_URL, TRACKER_API_TOKEN and TRACKER_SEARCH, the
// same three the nightly helper uses. TRACKER_SEARCH can be any non-fed track
// key on the account whose token is in TRACKER_API_TOKEN; no case depends on
// which.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes("--json");
const out = [];
const say = (line) => { if (!asJson) console.log(line); };

// ---- Talking to the server the way the CLI does. --------------------------
function openServer() {
  const child = spawn(process.execPath, [join(here, "server.mjs")], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  let buffer = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const settle = waiting.get(msg.id);
      if (settle) {
        waiting.delete(msg.id);
        settle(msg);
      }
    }
  });
  child.stderr.resume();

  let nextId = 1;
  const send = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  return {
    close: () => child.kill(),
    handshake: () => send("initialize", { protocolVersion: "2024-11-05" }),
    tools: async () => (await send("tools/list")).result.tools.map((t) => t.name),
    call: async (name, args) => {
      const msg = await send("tools/call", { name, arguments: args });
      if (!msg.result || !msg.result.content) {
        return { error: msg.error || "no content" };
      }
      return JSON.parse(msg.result.content[0].text);
    },
  };
}

function record(what, asserts, pass, answer) {
  out.push({ what, asserts, pass, answer });
  say(`  ${pass ? "PASS" : "FAIL"}  ${what}`);
  if (!pass) {
    say(`        asserting: ${asserts}`);
    say(`        answered:  ${JSON.stringify(answer).slice(0, 220)}`);
  }
}

// ---- The part that needs no board, no token and no network. ---------------
//
// Deciding whose board a posting is on is pure string work, and it is the step
// that deletes leads: pick the wrong company and its board reads fine, the id
// is legitimately absent from it, and the answer is "gone" with evidence that
// reads like a true one. The companies here are invented.
const { findBoardOwner, oracleReader, idShape, idLooksIssuedBy } = await import("./server.mjs");

const invented = [
  { company: "Acme", known: { board: "greenhouse", endpoint: "boards-api.greenhouse.io/v1/boards/acme/jobs" } },
  { company: "Cme Robotics", known: { board: "greenhouse", endpoint: "boards-api.greenhouse.io/v1/boards/cme/jobs" } },
  { company: "Twin A", known: { board: "greenhouse", endpoint: "boards-api.greenhouse.io/v1/boards/shared/jobs" } },
  { company: "Twin B", known: { board: "greenhouse", endpoint: "boards-api.greenhouse.io/v1/boards/shared/jobs" } },
  { company: "Ownhost", known: { board: "greenhouse", endpoint: "boards-api.greenhouse.io/v1/boards/ownhost/jobs", url_shape: "https://careers.ownhost.com/job?gh_jid=<id>" } },
];

for (const c of [
  {
    what: "a board token that is a whole path segment claims the posting",
    asserts: "a board is claimed by a segment of the address, which is the only match that is about this company",
    run: () => findBoardOwner("https://job-boards.greenhouse.io/acme/jobs/123", "greenhouse", invented),
    ok: (r) => r.found === "one" && r.company.company === "Acme",
  },
  {
    what: "a board token that is only a substring of a segment claims nothing",
    asserts: "a token inside another company's path cannot claim its postings - the verdict would be about the wrong board",
    run: () => findBoardOwner("https://job-boards.greenhouse.io/acme/jobs/123", "greenhouse", [invented[1]]),
    ok: (r) => r.found === "none",
  },
  {
    what: "two companies claiming one board answer ambiguous rather than picking",
    asserts: "a tie is a fact about the list, so the caller declines instead of guessing",
    run: () => findBoardOwner("https://job-boards.greenhouse.io/shared/jobs/123", "greenhouse", invented),
    ok: (r) => r.found === "ambiguous" && r.names.length === 2,
  },
  {
    what: "a posting on a company's own domain is claimed through its recorded shape",
    asserts: "a board token absent from the path is still matched where the list records that host",
    run: () => findBoardOwner("https://careers.ownhost.com/job?gh_jid=99", "greenhouse", invented),
    ok: (r) => r.found === "one" && r.company.company === "Ownhost",
  },
  {
    what: "a posting on a board's shared host is claimed by segment alone, not by every company on that board",
    asserts: "the recorded host only identifies a company on its own domain - a shared board host appears in every user's recorded shape, so matching on it turns one posting into a tie between dozens",
    run: () => findBoardOwner("https://job-boards.greenhouse.io/acme/jobs/123?gh_jid=123", "greenhouse", [
      ...invented,
      { company: "Shared Host User", known: { board: "greenhouse", endpoint: "boards-api.greenhouse.io/v1/boards/other/jobs", url_shape: "https://job-boards.greenhouse.io/other/jobs/<id>" } },
    ]),
    ok: (r) => r.found === "one" && r.company.company === "Acme",
  },
  {
    // Found live, as a tie on a real posting, and kept here because the path
    // test alone cannot see it: this shape sits on the vendor's host but
    // spells the token differently from the endpoint, so no token is found in
    // the path and the vendor's host reads as an own domain. What catches it
    // is that several companies record that host.
    what: "a shape on a vendor's host whose path spells the token differently still claims nothing",
    asserts: "a host several companies record is nobody's own domain, whatever any one shape's path says - a hand-recorded shape can disagree with its own endpoint",
    run: () => findBoardOwner("https://job-boards.greenhouse.io/acme/jobs/123?gh_jid=123", "greenhouse", [
      ...invented,
      { company: "Spelt Differently", known: { board: "greenhouse", endpoint: "boards-api.greenhouse.io/v1/boards/spelt/jobs", url_shape: "https://job-boards.greenhouse.io/speltdifferently/jobs/<id>" } },
      { company: "Second Recorder", known: { board: "greenhouse", endpoint: "boards-api.greenhouse.io/v1/boards/second/jobs", url_shape: "https://job-boards.greenhouse.io/second/jobs/<id>" } },
    ]),
    ok: (r) => r.found === "one" && r.company.company === "Acme",
  },
  {
    // The hole in deciding this by counting how many companies record a host:
    // with one recorder the count says "nobody shares it", and that lone
    // company then claims another tenant's posting and reports it gone.
    what: "the only company recording a vendor's host still does not claim another tenant's posting there",
    asserts: "a vendor's host is told from an own domain by the shape's own path holding the company's board token, so it is not identity however few companies record it",
    run: () => findBoardOwner("https://job-boards.greenhouse.io/someone-else/jobs/7?gh_jid=7", "greenhouse", [
      { company: "Shared Host User", known: { board: "greenhouse", endpoint: "boards-api.greenhouse.io/v1/boards/other/jobs", url_shape: "https://job-boards.greenhouse.io/other/jobs/<id>" } },
    ]),
    ok: (r) => r.found === "none",
  },
  {
    // Oracle ids are not all numeric - tenants serve both 334432 and W737883 -
    // so a pattern tighter than "whatever follows job" would report no id for
    // a form it had not seen, and the posting would never be checked at all.
    what: "an Oracle address yields its requisition id and its site number, whatever form the id takes",
    asserts: "the id is whatever follows `job` and the site whatever follows `sites`, so a W-prefixed id, a trailing slash and a tenant host without a data centre label all survive",
    run: () => {
      const forms = [
        ["https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/334432", "334432", "CX_45001"],
        ["https://tenant.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/W737883/", "W737883", "CX_1001"],
        ["https://tenant.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/607", "607", "CX_1"],
      ];
      return forms.map(([address, id, site]) => {
        const u = new URL(address);
        const m = oracleReader.fromUrl(u);
        return oracleReader.idFromUrl(u) === id && m && m[2] === site && m[1] === u.host;
      });
    },
    ok: (r) => Array.isArray(r) && r.length === 3 && r.every(Boolean),
  },
  {
    // The case the control cannot catch. A control is fetched from the board,
    // so it comes back whatever the subject looked like - which means a stored
    // address damaged in the id position reaches `gone` on a live posting.
    what: "an id shaped like nothing the board serves is not accepted as a subject",
    asserts: "a damaged id position - truncated, a slug, the word undefined - is an unreadable address rather than a closed posting, and the board's own ids are what say which it is",
    run: () => {
      const served = ["334432", "336931", "320967"];
      return {
        damaged: ["undefined", "senior-software-engineer", "334432?utm=x", ""].map((bad) => idLooksIssuedBy(bad, served)),
        real: idLooksIssuedBy("451002", served),
        otherFormAccepted: idLooksIssuedBy("W737883", ["W737883", "W737884"]),
        mixedBoardAcceptsBoth: ["334432", "W737883"].map((ok) => idLooksIssuedBy(ok, ["334432", "W737883"])),
      };
    },
    ok: (r) => r.damaged.every((x) => x === false)
      && r.real === true
      && r.otherFormAccepted === true
      && r.mixedBoardAcceptsBoth.every(Boolean),
  },
  {
    what: "an id's shape is its character classes with runs collapsed",
    asserts: "the comparison is on shape, not length or value, so a board's next id is accepted while a different form is not",
    run: () => [idShape("334432"), idShape("W737883"), idShape("2026-0024110"), idShape("undefined"), idShape("Req184431-1")],
    ok: (r) => r[0] === "d" && r[1] === "ad" && r[2] === "d-d" && r[3] === "a" && r[4] === "ad-d",
  },
  {
    what: "an Oracle address with no site number yields no coordinates rather than guessing one",
    asserts: "a missing site number is declined rather than defaulted - the tenants seen ignore it, but a tenant configured with several boards can enforce it, and a guessed coordinate is what would produce a confident answer about the wrong board",
    run: () => oracleReader.fromUrl(new URL("https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/job/334432")),
    ok: (r) => r === null,
  },
  {
    what: "an address that is not an address is reported, not thrown",
    asserts: "a malformed address fails as an answer rather than as an exception",
    run: () => findBoardOwner("not-a-url", "greenhouse", invented),
    ok: (r) => r.found === "unreadable-address",
  },
]) {
  let answer;
  try {
    answer = c.run();
  } catch (err) {
    answer = { threw: String((err && err.message) || err) };
  }
  record(c.what, c.asserts, Boolean(c.ok(answer)), answer);
}
const pureFailed = out.filter((r) => !r.pass).length;
const pureCount = out.length;
say(`\n${pureCount - pureFailed} of ${pureCount} passed without touching a board\n`);

// ---- The ones that reach live boards. -------------------------------------
const missing = ["TRACKER_URL", "TRACKER_API_TOKEN", "TRACKER_SEARCH"].filter((k) => !process.env[k]);
if (missing.length) {
  say(`skipping the live cases: needs ${missing.join(", ")}`);
  if (asJson) {
    console.log(JSON.stringify({ results: out, failed: pureFailed, live: "skipped" }, null, 1));
  }
  process.exit(pureFailed ? 1 : 0);
}

// Subjects are chosen by the property each case is about, never by name.
const listed = await (await fetch(
  `${process.env.TRACKER_URL}/api/coverage/${process.env.TRACKER_SEARCH}?all=1`,
  { headers: { Authorization: `Bearer ${process.env.TRACKER_API_TOKEN}` } },
)).json();
const rows = listed.companies || [];
const withEndpoint = (re) => rows.find((c) => re.test(((c.known || {}).endpoint) || ""));
// The greenhouse subject needs a board no other row on the list claims. More
// than one row can record the same board token - a parent and its brand, or
// the same employer entered twice - and a posting on a board two rows claim is
// legitimately `ambiguous`, which is the reader declining rather than failing.
// Picking a sole claimant is what makes this case about membership.
const ghToken = (c) => {
  const m = /boards-api\.greenhouse\.io\/v1\/boards\/([^/?]+)/.exec(((c.known || {}).endpoint) || "");
  return m ? m[1] : "";
};
const ghClaimants = new Map();
for (const c of rows) {
  const t = ghToken(c);
  if (t) ghClaimants.set(t, (ghClaimants.get(t) || 0) + 1);
}
const greenhouse = rows.find((c) => {
  const t = ghToken(c);
  return Boolean(t) && ghClaimants.get(t) === 1;
});
const workday = withEndpoint(/myworkdayjobs\.com\/wday\/cxs\//);
// A company the reader has no route for. This list must name every board kind
// the server reads: miss one and this case picks a company the server can in
// fact read, then fails asserting it was declined.
const noRoute = rows.find((c) => {
  const ep = ((c.known || {}).endpoint) || "";
  return !/greenhouse|ashbyhq|lever\.co|myworkdayjobs|oraclecloud/.test(ep);
});

const server = openServer();
const hand = await server.handshake();
if (!hand.result || !hand.result.serverInfo) {
  console.error("the server did not answer initialize");
  process.exit(1);
}
say(`tools: ${(await server.tools()).join(", ")}\n`);

if (greenhouse) {
  const token = ghToken(greenhouse);
  const listing = await server.call("list_postings", { company: greenhouse.company });
  record(
    "a whole-board listing comes back complete",
    "a board that gives a usable count of its own postings is reported complete, so an absence from it may be concluded",
    Array.isArray(listing.postings) && listing.postings.length > 0 && listing.complete === true,
    { count: listing.count, complete: listing.complete },
  );

  if (Array.isArray(listing.postings) && listing.postings.length) {
    const open = await server.call("posting_status", { url: listing.postings[0].url });
    record(
      "a posting its board still lists is open",
      "the verdict comes from membership in the board's own listing",
      open.state === "open" && Boolean(open.evidence),
      open,
    );
    // An id built to be absent, rather than a req that was once real: a real
    // dead req's answer rots into "unknown" the day its board changes shape,
    // and this asserts the same path without pinning anything.
    const absent = await server.call("posting_status", { url: `https://job-boards.greenhouse.io/${token}/jobs/1` });
    record(
      "an id its board does not list is gone, with the board's size as evidence",
      "an absence is only concluded against a listing that came back non-empty",
      absent.state === "gone" && /absent/.test(absent.evidence || ""),
      absent,
    );
  }
}

const oracle = withEndpoint(/oraclecloud\.com[^\s]*siteNumber=CX_/);
if (oracle) {
  const listing = await server.call("list_postings", { company: oracle.company });
  record(
    "an Oracle listing serves postings and says plainly whether it is the whole board",
    "an Oracle tenant can hold thousands of requisitions and is read a few pages deep, so a listing that is not the whole board reports complete:false and carries the warning - an absence must never be read out of it",
    Array.isArray(listing.postings) && listing.postings.length > 0
      && (listing.complete === false ? /don't read a posting's absence/.test(listing.warning || "") : listing.complete === true),
    { count: listing.count, complete: listing.complete, total: listing.board_says_total },
  );

  if (Array.isArray(listing.postings) && listing.postings.length) {
    const open = await server.call("posting_status", { url: listing.postings[0].url });
    record(
      "an Oracle requisition the tenant still serves is open",
      "the verdict is a lookup by requisition id rather than a read of the whole board, which is why it works on a tenant too large to list",
      open.state === "open" && Boolean(open.evidence),
      open,
    );
    // A fabricated id rather than a requisition that was once real, so the
    // case asserts the absence path without pinning anything that rots.
    const host = new URL(listing.postings[0].url);
    const absent = await server.call("posting_status", { url: `${host.origin}${host.pathname.replace(/\/job\/.*$/, "/job/9")}` });
    record(
      "an Oracle requisition the tenant does not serve is gone, and only against a control",
      "an empty answer is also what a failing tenant returns, so `gone` is only reached when an id the board served moments earlier comes back by the same route",
      absent.state === "gone" && /control/.test(absent.evidence || ""),
      absent,
    );
  }
}

if (workday) {
  const listing = await server.call("list_postings", { company: workday.company });
  record(
    "a Workday listing reports its completeness honestly",
    "a board whose own count cannot be reconciled with what it served is reported as unknown completeness, with a warning not to read an absence from it",
    Array.isArray(listing.postings)
      && (listing.complete === true || (listing.complete === null && /absence/.test(listing.warning || ""))),
    { count: listing.count, complete: listing.complete, warning: listing.warning },
  );
}

if (noRoute) {
  const declined = await server.call("list_postings", { company: noRoute.company });
  record(
    "a company with no machine-readable endpoint is declined, with what is recorded",
    "the reader never guesses a board, and hands back the facts a run can act on instead",
    /no machine-readable endpoint/.test(declined.error || "") && Boolean(declined.known),
    { error: declined.error, hasKnown: Boolean(declined.known) },
  );
}

const facts = await server.call("company_facts", { company: (rows[0] || {}).company || "" });
record(
  "a company on the list reports its recorded facts",
  "company_facts reads the list rather than the board",
  facts.found === true && Boolean(facts.known),
  { found: facts.found, hasKnown: Boolean(facts.known) },
);

const absentCompany = await server.call("company_facts", { company: "Nowhere Industries Ltd" });
record(
  "a company absent from the served list is not reported as new",
  "absent means unknown-or-excluded and says so, so a run cannot re-add what an account took off",
  absentCompany.found === false && /excludes it/.test(absentCompany.why || ""),
  absentCompany,
);

const unknownBoard = await server.call("posting_status", { url: "https://careers.example.com/jobs/12345" });
record(
  "an address on no board this reader knows is unknown, not gone",
  "an unreadable board never produces a verdict that would delete a lead",
  unknownBoard.state === "unknown",
  unknownBoard,
);

server.close();
const failed = out.filter((r) => !r.pass).length;
// The tally covers both sets, so it says so. Read as a live figure it promises
// twice the coverage against real boards that it has, and the number anyone
// quotes is the last one printed.
const liveRan = out.length - pureCount;
if (asJson) {
  console.log(JSON.stringify({ results: out, failed, pure: pureCount, live: liveRan }, null, 1));
} else {
  console.log(`\n${out.length - failed} of ${out.length} passed, ${failed} failed`);
  console.log(`that is ${pureCount} needing no board or token, and ${liveRan} against live boards.`);
  if (failed) {
    console.log("A failure here is either the code or the world. Each case says what it asserts;");
    console.log("read that first, then check the board by hand before concluding the code is wrong.");
  }
}
process.exit(failed ? 1 : 0);
