// A board reader for the nightly runs, over MCP on stdio.
//
// The shared company list already records how each company's postings are
// reached - `board`, `endpoint`, `url_shape` - and until now nothing executed
// it: a run read those as prose and hand-built a fetch, once per company, every
// night. This is the executor for a table we already maintain.
//
// It does the comparisons a status code cannot settle. Whether a posting is
// still open is membership in its board's own listing, not what fetching it
// answers: a removed Workday req replies 403 while its tenant serves everything
// else, and a Greenhouse page can answer 200 with a full body for a req the
// board no longer lists. Both are observed, not hypothetical.
//
// No dependencies, on purpose: a nightly run shouldn't need an install, and
// node is already on the machine. MCP is JSON-RPC 2.0 over newline-delimited
// stdin/stdout, which is small enough to speak directly.
//
// Credentials come from the environment the runner already sets for
// ./tracker - TRACKER_URL and TRACKER_API_TOKEN - so there is one place a
// token lives and this holds none of its own.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TRACKER_URL = process.env.TRACKER_URL || "";
const TRACKER_TOKEN = process.env.TRACKER_API_TOKEN || "";
const SEARCH = process.env.TRACKER_SEARCH || "";

const log = (...a) => process.stderr.write(`[board-mcp] ${a.join(" ")}\n`);

// Some boards refuse node's HTTP stack and serve curl the same request
// happily - at least one Workday tenant answers 500 to node whatever headers
// it is given, and 200 to curl. It is not the headers: json-only, no Accept
// and no User-Agent all get 500. The difference is below the request we set,
// so a refusal falls back to the platform's curl rather than being reported as
// the board's answer. A board wrongly called unreadable leaves dead postings
// on people's boards, which is the failure this whole reader exists to end.
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
const CURL = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\curl.exe`;

const viaCurl = (url, init) => new Promise((resolve) => {
  const args = ["-s", "-m", "25", "-A", UA];
  for (const [k, v] of Object.entries(init.headers || {})) args.push("-H", `${k}: ${v}`);
  if (init.method && init.method !== "GET") args.push("-X", init.method);
  if (init.body) args.push("-d", String(init.body));
  args.push("-w", "\n%{http_code}", url);
  execFile(CURL, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
    if (err && !stdout) return resolve({ status: 0, text: "", why: `curl: ${String(err.message).slice(0, 60)}` });
    const at = String(stdout).lastIndexOf("\n");
    resolve({ status: parseInt(String(stdout).slice(at + 1), 10) || 0, text: String(stdout).slice(0, at), via: "curl" });
  });
});

const fetchText = async (url, init = {}) => {
  let first;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json, text/html", ...(init.headers || {}) },
      signal: AbortSignal.timeout(25000),
      ...init,
    });
    first = { status: res.status, text: await res.text(), landed: res.url };
  } catch (err) {
    first = { status: 0, text: "", why: String((err && err.message) || err).slice(0, 80) };
  }
  if (first.status === 0 || first.status >= 500) {
    const second = await viaCurl(url, init);
    if (second.status && second.status < 500) {
      log(`${url.slice(0, 70)}: node got ${first.status || first.why}, curl got ${second.status}`);
      return second;
    }
  }
  return first;
};
const asJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

// ---- The company list, read once per process. -----------------------------
let companiesPromise = null;
const companies = () => {
  if (!companiesPromise) {
    companiesPromise = (async () => {
      if (!TRACKER_URL || !TRACKER_TOKEN || !SEARCH) return [];
      const r = await fetchText(`${TRACKER_URL}/api/coverage/${SEARCH}?all=1`, {
        headers: { Authorization: `Bearer ${TRACKER_TOKEN}` },
      });
      const j = asJson(r.text);
      return (j && j.companies) || [];
    })();
  }
  return companiesPromise;
};
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const findCompany = async (name) => {
  const want = norm(name);
  const list = await companies();
  return list.find((c) => norm(c.company) === want)
    || list.find((c) => (c.aliases || []).some((a) => norm(a) === want))
    || list.find((c) => norm(c.company).includes(want) || want.includes(norm(c.company)))
    || null;
};

// ---- One reader per board kind. -------------------------------------------
//
// Each returns { postings } or { error }. A posting is the shape a lead needs:
// the address a person opens, the title, the location as the board states it,
// and the date the board says it went up where it says one.
const readers = {
  greenhouse: {
    match: (ep) => /boards-api\.greenhouse\.io\/v1\/boards\/([^/?]+)/.exec(ep || ""),
    list: async (m) => {
      const token = m[1];
      const r = await fetchText(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`);
      const j = asJson(r.text);
      if (!j || !Array.isArray(j.jobs)) return { error: `greenhouse ${token} answered ${r.status}` };
      return {
        postings: j.jobs.map((x) => ({
          id: String(x.id),
          title: x.title,
          location: (x.location || {}).name || "",
          url: x.absolute_url,
          posted: (x.first_published || "").slice(0, 10),
        })),
      };
    },
    idFromUrl: (u) => (/\/jobs\/(\d+)/.exec(u.pathname) || [])[1] || u.searchParams.get("gh_jid") || "",
  },
  ashby: {
    match: (ep) => /posting-api\/job-board\/([^?&]+)/.exec(ep || ""),
    list: async (m) => {
      const org = m[1];
      const r = await fetchText(`https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`);
      const j = asJson(r.text);
      if (!j || !Array.isArray(j.jobs)) return { error: `ashby ${org} answered ${r.status}` };
      return {
        postings: j.jobs.map((x) => ({
          id: String(x.id),
          title: x.title,
          location: x.location || "",
          url: x.jobUrl,
          posted: (x.publishedAt || "").slice(0, 10),
        })),
      };
    },
    idFromUrl: (u) => u.pathname.split("/").filter(Boolean)[1] || "",
  },
  lever: {
    match: (ep) => /api\.lever\.co\/v0\/postings\/([^?&]+)/.exec(ep || ""),
    list: async (m) => {
      const org = m[1];
      const r = await fetchText(`https://api.lever.co/v0/postings/${org}?mode=json`);
      const j = asJson(r.text);
      if (!Array.isArray(j)) return { error: `lever ${org} answered ${r.status}` };
      return {
        postings: j.map((x) => ({
          id: String(x.id),
          title: x.text,
          location: (x.categories || {}).location || "",
          url: x.hostedUrl,
          posted: x.createdAt ? new Date(x.createdAt).toISOString().slice(0, 10) : "",
        })),
      };
    },
    idFromUrl: (u) => u.pathname.split("/").filter(Boolean)[1] || "",
  },
  workday: {
    match: (ep) => /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/wday\/cxs\/([^/]+)\/([^/\s]+)/i.exec(ep || ""),
    // Paged, and the page size is the board's rather than ours.
    list: async (m) => {
      const [, sub, wd, tenant, site] = m;
      const host = `${sub}.${wd}.myworkdayjobs.com`;
      const postings = [];
      let total = null;
      for (let offset = 0; offset < 600; offset += 20) {
        const r = await fetchText(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 20, offset, searchText: "" }),
        });
        const j = asJson(r.text);
        if (j && typeof j.total === "number") total = j.total;
        const page = (j && j.jobPostings) || [];
        if (!page.length) {
          if (!offset) return { error: `workday ${tenant} answered ${r.status}` };
          break;
        }
        for (const p of page) {
          postings.push({
            id: String(p.bulletFields && p.bulletFields[0] ? p.bulletFields[0] : ""),
            title: p.title,
            location: p.locationsText || "",
            url: `https://${host}/en-US/${site}${p.externalPath || ""}`,
            posted: "",
          });
        }
        if ((j.total || 0) <= offset + 20) break;
      }
      // Workday stops serving pages well before `total` on some tenants - 40 of
      // 181 is a shape seen on more than one - so what came back is said to be
      // partial rather than passed off as the board. A caller that treats a
      // partial listing as the whole board concludes that everything missing
      // from it is gone, which is how a night deletes live leads.
      // A total of 0 beside 40 postings is not a total, and believing it would
      // report a truncated listing as the whole board. Where the count the
      // board gives cannot be reconciled with what it served, completeness is
      // unknown and says so - which a caller must treat as "cannot conclude an
      // absence" rather than as a clean listing.
      const coherent = typeof total === "number" && total >= postings.length && total > 0;
      return {
        postings,
        total: coherent ? total : null,
        total_as_given: total,
        complete: coherent ? postings.length >= total : null,
      };
    },
    // The req id is whatever follows the last underscore, provided it has a
    // digit in it. The forms vary more than a tight pattern survives -
    // R70906, R-861055, JR2026496236, REF072039W, 2026-0024110, Req184431-1 -
    // and a pattern that misses one reports "no id" rather than failing, so
    // the posting is never checked at all.
    idFromUrl: (u) => {
      const tail = decodeURIComponent(u.pathname.split("/").pop() || "");
      const at = tail.lastIndexOf("_");
      const cand = at >= 0 ? tail.slice(at + 1) : tail;
      return /\d/.test(cand) ? cand : "";
    },
    // Workday indexes by req id, so membership is one search rather than a
    // read-through of the whole board.
    has: async (m, id) => {
      const [, sub, wd, tenant, site] = m;
      const host = `${sub}.${wd}.myworkdayjobs.com`;
      const r = await fetchText(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 20, offset: 0, searchText: id }),
      });
      if (r.status !== 200) return { error: `the listing answered ${r.status || r.why}` };
      const j = asJson(r.text);
      const ids = ((j && j.jobPostings) || []).map((p) => `${p.bulletFields} ${p.externalPath || ""}`).join(" ");
      return { present: ids.includes(id) };
    },
  },
  // Oracle Fusion, which the list also records as oracle recruiting cloud and
  // oracle fusion recruiting cx. One tenant's board can be enormous - one of
  // the ones on the list serves 8,284 requisitions - so it is never read
  // whole, and membership is a lookup by id like Workday's.
  //
  // A tenant needs two coordinates, both of which the recorded endpoint
  // carries: the host, and the site number - the candidate-facing board within
  // the tenant, recorded on the list as CX_1, CX_1001, CX_2001 or CX_45001.
  //
  // On the tenants here the site number turns out to be ignored by both
  // routes: the same id and the same totals come back for the right site, a
  // neighbour's, and a value that is not a site at all. It is still sent,
  // because it is part of the documented route and a tenant configured with
  // several boards can enforce it, and it is still required from the address
  // rather than defaulted, because a guessed coordinate is how this would
  // produce a confident answer about the wrong board on the day one does
  // enforce it. Declining costs an `unknown`, which changes nothing.
  oracle: {
    match: (ep) => /([a-z0-9-]+\.fa\.(?:[a-z0-9-]+\.)?oraclecloud\.com)[^\s]*siteNumber=(CX_[A-Za-z0-9_]+)/i.exec(ep || ""),
    // Paged, 200 at a time, and deliberately not to the end: the point of the
    // cap is that `complete` then says false and a caller cannot read an
    // absence out of it. Membership questions go to `has`, which needs no
    // listing at all.
    list: async (m) => {
      const [, host, site] = m;
      const postings = [];
      let total = null;
      for (let offset = 0; offset < 600; offset += 200) {
        const r = await fetchText(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
          + `?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=${site},limit=200,offset=${offset}`);
        const j = asJson(r.text);
        const head = (j && j.items && j.items[0]) || null;
        if (!head) {
          if (!offset) return { error: `oracle ${host} answered ${r.status || r.why}` };
          break;
        }
        if (typeof head.TotalJobsCount === "number") total = head.TotalJobsCount;
        const page = head.requisitionList || [];
        if (!page.length) break;
        for (const p of page) {
          postings.push({
            id: String(p.Id || ""),
            title: p.Title || "",
            location: p.PrimaryLocation || p.Location || p.PrimaryLocationCountry || "",
            url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${p.Id}`,
            posted: p.PostedDate || "",
          });
        }
        if (total !== null && total <= offset + 200) break;
      }
      const coherent = typeof total === "number" && total >= postings.length && total > 0;
      return {
        postings,
        total: coherent ? total : null,
        total_as_given: total,
        complete: coherent ? postings.length >= total : null,
      };
    },
    // The id is the segment after `job`, and it is not always numeric: tenants
    // serve both 334432 and W737883. Anything there is taken as the id rather
    // than matched against a pattern, because the forms vary more than a
    // pattern written today survives.
    //
    // That is only safe because of idLooksIssuedBy below. Taken alone, a
    // permissive read is the dangerous half of the choice: a stored address
    // damaged in the id position - truncated, a redirect's slug, an
    // `undefined` written once - yields an id the board answers empty for,
    // which is indistinguishable from closed. A missed form leaves a lead
    // unchecked; a garbage id takes a live one off the board. Both are silent,
    // and only the second is irreversible in practice, so the reader reads
    // permissively here and refuses downstream on shape.
    idFromUrl: (u) => {
      const parts = u.pathname.split("/").filter(Boolean);
      const at = parts.indexOf("job");
      return at >= 0 && parts[at + 1] ? decodeURIComponent(parts[at + 1]) : "";
    },
    // posting_status is handed a lead's address, not a company's endpoint, so
    // the coordinates are recovered by writing the endpoint this address
    // implies and matching it the usual way. Building a match by hand instead
    // would drift from `match` the moment either one moved.
    fromUrl: (u) => {
      const parts = u.pathname.split("/").filter(Boolean);
      const at = parts.indexOf("sites");
      const site = at >= 0 ? parts[at + 1] : "";
      if (!site) return null;
      return readers.oracle.match(`https://${u.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
        + `?finder=findReqs;siteNumber=${site},limit=1`);
    },
    // One requisition by id. Oracle answers 200 with an empty `items` for a
    // requisition that is closed and for one that never existed, and it would
    // answer the same for a tenant having a bad night - so an empty answer
    // alone is never enough, and the caller controls it against an id the same
    // board served moments earlier.
    has: async (m, id) => {
      const [, host, site] = m;
      const r = await fetchText(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
        + `?expand=all&onlyData=true&finder=ById;Id=${encodeURIComponent(id)},siteNumber=${site}`);
      if (r.status !== 200) return { error: `the requisition lookup answered ${r.status || r.why}` };
      const j = asJson(r.text);
      if (!j || !Array.isArray(j.items)) return { error: "the requisition lookup did not answer with a list" };
      return { present: j.items.length > 0 };
    },
  },
};

// A reader's pure parts - the requisition id and the tenant coordinates it
// reads out of an address - decide whether a `gone` is even about the right
// requisition, so they are exported for the checks to exercise without
// reaching a board.
export const oracleReader = readers.oracle;

// An id's shape, as character classes with runs collapsed: 334432 is "d",
// W737883 is "ad", 2026-0024110 is "d-d", and the word "undefined" is "a".
export function idShape(id) {
  const classes = [...String(id)].map((c) => (/[0-9]/.test(c) ? "d" : /[A-Za-z]/.test(c) ? "a" : "-"));
  const out = [];
  for (const c of classes) if (out[out.length - 1] !== c) out.push(c);
  return out.join("");
}

// Could this board have issued this id? A control proves the route works; it
// says nothing about the subject, because it is fetched from the board rather
// than read out of the address being asked about. So an id whose shape matches
// nothing the board just served is an address the reader could not read, not a
// requisition that closed - and the difference is a lead left alone versus a
// lead deleted with evidence that reads correctly.
//
// Compared against several of the board's own ids rather than one, since a
// tenant can serve more than one form and a single sample would make the
// others unreadable.
//
// What it does not catch, stated so nobody reads it as proof: damage that
// preserves the shape. A truncated R72869 is still letter-then-digits, so it
// passes here and reaches `gone` on a posting that is open. Shape closes the
// cases that actually occur - a slug, a word, an empty position - and a
// stricter test would need a per-tenant id pattern, which is the thing that
// cannot be written once and stay true.
export function idLooksIssuedBy(id, sampleIds) {
  const shapes = new Set((sampleIds || []).map(idShape));
  return shapes.has(idShape(id));
}

const readerFor = (company) => {
  const ep = (company.known || {}).endpoint || "";
  for (const [kind, r] of Object.entries(readers)) {
    const m = r.match(ep);
    if (m) return { kind, reader: r, m };
  }
  return null;
};
// A company's recorded url_shape names the host its postings open at. Where
// that is the company's own domain the host identifies it, and a posting there
// is one of its own even though its board token appears nowhere in the path.
//
// A board vendor's host is not that: it appears in the recorded shape of every
// company on that board, so reading it as an identity turns one posting into a
// tie between dozens. The two are told apart by what the shape's own path
// holds. On a vendor's host the company's board token is a segment of the
// path, which is how the vendor keeps its tenants apart; on a company's own
// domain nothing needs to. That is a property of the shape in front of us,
// rather than a list of vendor hostnames whose hole is always the host nobody
// has added yet.
// A recorded shape carries prose and placeholders as well as an address, so
// the host is read off the front rather than parsed as a URL.
function hostOfShape(shape) {
  const at = /^(?:https?:\/\/)?([^/?#\s]+)([^?#\s]*)/.exec(String(shape || "").trim());
  return at ? { host: at[1].toLowerCase(), path: at[2] } : null;
}

function shapeNamesOwnDomain(shape, token, host) {
  const at = hostOfShape(shape);
  if (!at || at.host !== String(host).toLowerCase()) return false;
  return !at.path.split("/").filter(Boolean).includes(token);
}

// The other half of the same question, and it catches what the path test
// cannot. A shape is recorded by hand, so its path can spell the company's
// token differently from its endpoint - and then the path test finds no token,
// reads the vendor's host as an own domain, and hands one posting to a company
// whose board it is not. A host that several companies record is nobody's own
// domain whatever any one shape says, which is the fact that catches it.
//
// It cannot replace the path test either: a vendor host only one company has
// recorded is counted once, and that company would claim another tenant's
// posting and report it gone. Each test covers the other's hole, and the
// checks hold a case for each.
//
// What this costs, since it is charged silently: it counts rows, not
// employers. One employer recorded twice - two spellings of its name, or a
// parent and a subsidiary sharing a board - has its own careers host counted
// twice and read as a vendor's, so its postings there claim nobody and answer
// unknown rather than open or gone. Counting distinct names does not help:
// those rows differ by name, which is how they come to be two rows. What they
// share is a board token, and that is the fix - put it where a tie is
// resolved rather than here, so a tie whose rows all name one board gets
// checked against that board instead of declining. Until then, a company's
// own-domain postings going permanently unknown is this, not a broken reader.
function hostsSeveralCompaniesRecord(list) {
  const seen = new Map();
  for (const company of list) {
    const at = hostOfShape((company.known || {}).url_shape);
    if (at) seen.set(at.host, (seen.get(at.host) || 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([host]) => host));
}

// Which company's board is a posting on? Pure, and exported, because this is
// the step that can delete a lead and it needs no network to be wrong.
//
// Matched on a whole path segment, never a substring. A board token like `acme`
// is a substring of plenty of other companies' paths, and taking the first
// match would pick a company at random from those: afterwards nothing looks
// wrong, because that company's board reads fine, the id is legitimately absent
// from it - it is not their req - and the answer is `gone` with evidence that
// reads exactly like a true one.
//
// Two companies claiming one board is a real condition rather than a tie to
// break, so it is reported and the caller declines.
export function findBoardOwner(url, kind, list) {
  let u;
  try { u = new URL(url); } catch { return { found: "unreadable-address" }; }
  const segments = u.pathname.split("/").filter(Boolean);
  const ghJid = u.searchParams.get("gh_jid");
  const vendorHosts = hostsSeveralCompaniesRecord(list);

  const claims = [];
  for (const company of list) {
    const reader = readerFor(company);
    if (!reader || reader.kind !== kind || !reader.m[1]) continue;
    const token = reader.m[1];
    // A posting is this company's when its board token is a whole segment of
    // the address, or when the address is on the company's own domain and
    // carries a `?gh_jid=` of its own - see shapeNamesOwnDomain for how a
    // company's own domain is told from its board vendor's.
    const ownDomain = Boolean(ghJid)
      && !vendorHosts.has(u.host.toLowerCase())
      && shapeNamesOwnDomain((company.known || {}).url_shape, token, u.host);
    if (segments.includes(token) || ownDomain) claims.push({ company, reader });
  }

  if (!claims.length) return { found: "none" };
  if (claims.length > 1) return { found: "ambiguous", names: claims.map((c) => c.company.company) };
  return { found: "one", company: claims[0].company, reader: claims[0].reader };
}

const readerForUrl = (url) => {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (/greenhouse\.io$/.test(u.host) || u.searchParams.get("gh_jid")) return { kind: "greenhouse", u };
  if (u.host === "jobs.ashbyhq.com") return { kind: "ashby", u };
  if (u.host === "jobs.lever.co") return { kind: "lever", u };
  if (/\.wd\d+\.myworkdayjobs\.com$/.test(u.host)) return { kind: "workday", u };
  if (/\.fa\.(?:[a-z0-9-]+\.)?oraclecloud\.com$/.test(u.host)) return { kind: "oracle", u };
  return { kind: "", u };
};

// ---- The tools. -----------------------------------------------------------
const TOOLS = [
  {
    name: "list_postings",
    description:
      "Every posting a company's board currently lists, read from the board itself. Takes the company name as the shared list spells it (aliases work). Returns title, location, the address a person opens, and the date the board says it went up where it gives one. Use this instead of fetching a careers page: it is the same source the list's recorded endpoint names, and it cannot miss postings a page hides behind JavaScript.",
    inputSchema: {
      type: "object",
      properties: { company: { type: "string", description: "Company name, as the shared list spells it" } },
      required: ["company"],
    },
  },
  {
    name: "posting_status",
    description:
      "Whether one posting is still open, decided by whether its board still lists it - not by what fetching it answers. Returns open, gone, or unknown with the evidence. A removed Workday req answers 403 while its tenant serves every other req, and a Greenhouse page can answer 200 with a full body for a req the board dropped, so a status code cannot settle this. Unknown means the board could not be read, and a lead on an unknown is left alone.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The posting's address, as stored on the lead" } },
      required: ["url"],
    },
  },
  {
    name: "company_facts",
    description:
      "What the shared company list records about reaching one company: its board kind, listing endpoint, posting-address shape, any wall, and the names it also goes by. Read-only - recording a new fact is still ./tracker swept.",
    inputSchema: {
      type: "object",
      properties: { company: { type: "string" } },
      required: ["company"],
    },
  },
];

const call = async (name, args) => {
  if (name === "company_facts") {
    const c = await findCompany(args.company || "");
    // The list this account is served hides companies it excludes, so absent
    // here means one of two different things and only the person can tell them
    // apart. Saying both stops a run reporting a company as new and adding it
    // back to a list it was deliberately taken off.
    if (!c) return { found: false, why: `"${args.company}" is not on the list this search is served - either nobody has added it, or this account excludes it. Don't treat it as new.` };
    return { found: true, company: c.company, aliases: c.aliases || [], known: c.known || {}, last_swept: c.last_swept || "" };
  }

  if (name === "list_postings") {
    const c = await findCompany(args.company || "");
    if (!c) return { error: `"${args.company}" is not on the shared list under that name or any alias` };
    const r = readerFor(c);
    if (!r) {
      return {
        error: `the list records no machine-readable endpoint for ${c.company}`,
        known: c.known || {},
        advice: "fetch it as step 3 describes, and report what worked with ./tracker swept",
      };
    }
    const out = await r.reader.list(r.m);
    if (out.error) return { company: c.company, board: r.kind, error: out.error };
    const warn = out.complete === false
      ? `the board served ${out.postings.length} of the ${out.total} it claims, so this is some of its postings and not all of them`
      : out.complete === null && "complete" in out
        ? `the board gave no usable count of its own postings${out.total_as_given === 0 ? " (it said 0 while serving " + out.postings.length + ")" : ""}, so whether this is all of them is unknown`
        : "";
    return {
      company: c.company,
      board: r.kind,
      count: out.postings.length,
      ...(typeof out.total === "number" && out.total !== null ? { board_says_total: out.total } : {}),
      complete: "complete" in out ? out.complete : true,
      ...(warn ? { warning: `${warn} - don't read a posting's absence from this list as the posting being gone` } : {}),
      postings: out.postings,
    };
  }

  if (name === "posting_status") {
    const url = String(args.url || "");
    const where = readerForUrl(url);
    if (!where || !where.kind) return { state: "unknown", why: "this board kind isn't one this reader knows" };
    const { kind, u } = where;

    // Workday answers a membership question directly; the others are read by
    // listing the board their company owns and looking for the id.
    if (kind === "workday") {
      const m = readers.workday.match(`${u.host}/wday/cxs/${u.pathname.split("/").filter(Boolean)[1] || ""}/x`);
      const parts = u.pathname.split("/").filter(Boolean);
      const at = parts.indexOf("job");
      const site = at > 0 ? parts[at - 1] : "";
      const sub = u.host.split(".")[0];
      const wd = u.host.split(".")[1];
      const id = readers.workday.idFromUrl(u);
      if (!id || !site) return { state: "unknown", why: "no req id or site could be read out of the address" };
      const mm = [null, sub, wd, sub, site];
      const r = await readers.workday.has(mm, id);
      if (r.error) return { state: "unknown", why: r.error, id };
      if (r.present) return { state: "open", id, evidence: `${id} is in the tenant's listing` };
      // An absence means nothing until the question is shown to work on this
      // host, and the control must travel the same path: another id read out of
      // an address on this host, searched the same way.
      const all = await readers.workday.list(mm);
      if (all.error || !all.postings.length) {
        return { state: "unknown", id, why: `${id} was not found, and ${all.error || "the listing returned nothing"}, so the absence proves nothing` };
      }
      // The control proves the route works here; it says nothing about the
      // subject, because it is taken from the board rather than read out of the
      // address being asked about. So a req id shaped like nothing this tenant
      // serves is an address that cannot be read - an id position truncated,
      // substituted, or written as a redirect's slug - and calling that gone
      // takes a live posting off the person's board with evidence that reads
      // correctly. The row survives as a screened `delisted` one, so nothing
      // is destroyed; what is lost is that anything ever looks again, since a
      // run skips a url already screened.
      const served = all.postings.map((p) => p.id).filter(Boolean);
      if (served.length && !idLooksIssuedBy(id, served)) {
        return {
          state: "unknown",
          id,
          why: `${id} is not the shape of any req id this tenant just served (${[...new Set(served.map(idShape))].join(", ")}), so this address cannot be read rather than the posting being gone`,
        };
      }
      const control = await (async () => {
        const other = all.postings.find((p) => {
          try { return readers.workday.idFromUrl(new URL(p.url)) && readers.workday.idFromUrl(new URL(p.url)) !== id; } catch { return false; }
        });
        if (!other) return { ok: false, why: "no second posting to control with" };
        const cid = readers.workday.idFromUrl(new URL(other.url));
        const c = await readers.workday.has(mm, cid);
        return c.error || !c.present ? { ok: false, why: `the control ${cid} did not come back` } : { ok: true, cid };
      })();
      if (!control.ok) return { state: "unknown", why: `${id} was not found, and ${control.why}, so the absence proves nothing`, id };
      return { state: "gone", id, evidence: `${id} is absent while the control ${control.cid}, read the same way, came back` };
    }

    // Oracle answers membership by id too, and for the same reason as Workday:
    // its boards are far too large to read whole, so there is no listing to
    // compare against.
    if (kind === "oracle") {
      const m = readers.oracle.fromUrl(u);
      const id = readers.oracle.idFromUrl(u);
      if (!m || !id) return { state: "unknown", why: "no requisition id or site number could be read out of the address" };
      const r = await readers.oracle.has(m, id);
      if (r.error) return { state: "unknown", why: r.error, id };
      if (r.present) return { state: "open", id, evidence: `${id} is still served by the tenant's board` };
      // An empty answer is also what a tenant having a bad night returns, and
      // what a damaged address returns. So two things must hold before an
      // absence counts: the route has to work here, and the id being asked
      // about has to be a form this board issues. Both come out of one
      // listing request.
      const sample = await (async () => {
        const first = await fetchText(`https://${m[1]}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
          + `?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=${m[2]},limit=10,offset=0`);
        const j = asJson(first.text);
        const head = (j && j.items && j.items[0]) || null;
        return ((head && head.requisitionList) || []).map((p) => String(p.Id || "")).filter(Boolean);
      })();
      if (!sample.length) {
        return { state: "unknown", id, why: `${id} was not found, and the board served no requisition to check that against, so the absence proves nothing` };
      }
      if (!idLooksIssuedBy(id, sample)) {
        return {
          state: "unknown",
          id,
          why: `${id} is not the shape of any id this board just served (${[...new Set(sample.map(idShape))].join(", ")}), so this address cannot be read rather than the posting being gone`,
        };
      }
      const cid = sample.find((s) => s !== id);
      if (!cid) {
        return { state: "unknown", id, why: `${id} was not found, and the only requisition to control with is the one being asked about, so the absence proves nothing` };
      }
      const c = await readers.oracle.has(m, cid);
      if (c.error || !c.present) {
        return { state: "unknown", id, why: `${id} was not found, and the control ${cid} did not come back, so the absence proves nothing` };
      }
      return {
        state: "gone",
        id,
        evidence: `${id} is absent while the control ${cid}, looked up the same way, came back, and ${id} is a shape this board issues`,
      };
    }

    const idOf = readers[kind].idFromUrl(u);
    if (!idOf) return { state: "unknown", why: "no posting id could be read out of the address" };
    const owner = findBoardOwner(url, kind, await companies());
    if (owner.found === "ambiguous") {
      return {
        state: "unknown",
        id: idOf,
        why: `more than one company on the list claims this board (${owner.names.join(", ")}), so which board to compare against is not settled`,
      };
    }
    if (owner.found !== "one") {
      return { state: "unknown", id: idOf, why: "no company on the shared list owns this board, so there is nothing to compare against" };
    }
    const whose = owner.company.company;
    const all = await owner.reader.reader.list(owner.reader.m);
    if (all.error) return { state: "unknown", id: idOf, company: whose, why: all.error };
    if (all.postings.some((p) => p.id === idOf)) {
      return { state: "open", id: idOf, company: whose, evidence: `${idOf} is on ${whose}'s board` };
    }
    // An absence is only an answer if the board actually listed something. These
    // three readers each fetch one whole-board document, so a short or truncated
    // response is invalid JSON rather than a short array - it arrives as an
    // error above, not as an empty list. That property is what makes an absence
    // conclusive here, so it is written down: were one of these endpoints to
    // start paginating, every absence would read as gone and nothing below
    // would notice.
    if (!all.postings.length) {
      return { state: "unknown", id: idOf, company: whose, why: "the board listed nothing, so an absence proves nothing" };
    }
    return {
      state: "gone",
      id: idOf,
      company: whose,
      evidence: `${idOf} is absent from ${whose}'s board, which listed ${all.postings.length} others`,
    };
  }

  return { error: `no tool named ${name}` };
};

// ---- MCP over stdio: JSON-RPC 2.0, one message per line. ------------------
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

// Only speak the protocol when started as a program. Imported - which is how
// the pure parts above get tested without a board, a token or a network - this
// attaches nothing to stdin and starts no server.
const startedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

let buffer = "";
if (startedDirectly) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) {
        handle(line);
      }
    }
  });
  log(`ready; tracker ${TRACKER_URL ? "configured" : "NOT configured"}, search ${SEARCH || "(none)"}`);
}

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "boards", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await call(name, args);
      return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
    } catch (err) {
      log(`${name} threw: ${err && err.message}`);
      return reply(id, { content: [{ type: "text", text: JSON.stringify({ error: String((err && err.message) || err) }) }], isError: true });
    }
  }
  if (typeof id !== "undefined") return fail(id, `unsupported method ${method}`);
}
