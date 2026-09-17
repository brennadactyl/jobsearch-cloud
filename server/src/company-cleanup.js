/**
 * Tidying the shared company list by hand: merging two spellings of one
 * employer into one row, and renaming a company that was acquired
 * (docs/glossary.md#companies-and-the-rotation).
 *
 * A run adds any company it is handed, so the list collects duplicates - "SSI"
 * beside "Safe Superintelligence" - and each is swept, stamped and noted
 * separately by every search. Nothing a run does can merge them; this is the
 * operator's way, through POST /api/companies/cleanup.
 *
 * Planned here as data, from rows already read, so a dry run and the real
 * write come from the same answer and the rules can be checked without a
 * database. CompanyList.cleanUpCompanies reads the rows and applies the plan.
 */

import { normalize } from "./exclude.js";

/** The fetch facts a merge carries across, field by field. */
const FACT_FIELDS = ["board", "endpoint", "url_shape", "dead_signal", "note"];
const NO_WALL = { wall: "", wall_first_on: "", wall_last_on: "", wall_dates: 0 };

/**
 * @typedef {Object} FetchRow a company_fetch row
 * @property {string} company_key
 * @property {string} display_name
 * @property {number} position
 * @property {string} board
 * @property {string} endpoint
 * @property {string} url_shape
 * @property {string} dead_signal
 * @property {string} note
 * @property {string} verified_on
 * @property {string} wall
 * @property {string} wall_first_on
 * @property {string} wall_last_on
 * @property {number} wall_dates
 * @property {string} retracted_on
 *
 * @typedef {{user_id: string, search: string, company_key: string, last_swept: string, note: string}} SweepRow
 *
 * @typedef {Object} Change one company as it will be written
 * @property {string} from_key the kept row's key before the change
 * @property {string[]} absorbed_keys rows deleted into it
 * @property {FetchRow} row the kept row after the change, under its final key
 * @property {FetchRow[]} before every row involved, kept first
 * @property {SweepRow[]} sweeps each search's record of the company after the change
 */

/**
 * Every company key a request names, for reading their rows in one go.
 * @param {{merges?: Array<{keep: string, absorb: string[], rename?: string}>, renames?: Array<{from: string, to: string}>}} body
 * @returns {string[]}
 */
export function namedKeys(body) {
  const merges = Array.isArray(body.merges) ? body.merges : [];
  const renames = Array.isArray(body.renames) ? body.renames : [];
  return [
    ...merges.flatMap((m) => [m?.keep, ...(Array.isArray(m?.absorb) ? m.absorb : []), m?.rename]),
    ...renames.flatMap((r) => [r?.from, r?.to]),
  ]
    .filter((n) => typeof n === "string")
    .map(normalize)
    .filter(Boolean);
}

/**
 * The one row a set of rows describing one employer becomes.
 *
 * The kept row's facts win, and an absorbed row only fills a field the kept row
 * has empty, taking the most recently verified first. `verified_on` is the
 * latest of them. A board or endpoint on the result settles any wall, as a
 * reported one does (CompanyList.upsertCompanyFetch); otherwise the kept wall
 * stands, or the most recent absorbed one.
 * @param {FetchRow} kept
 * @param {FetchRow[]} absorbed
 * @returns {FetchRow}
 */
export function mergedFacts(kept, absorbed) {
  const fresher = [...absorbed].sort((a, b) => (b.verified_on || "").localeCompare(a.verified_on || ""));
  const row = { ...kept };
  for (const f of FACT_FIELDS) {
    if (!row[f]) row[f] = fresher.find((a) => a[f])?.[f] || "";
  }
  row.verified_on = [kept, ...absorbed].map((r) => r.verified_on || "").sort().pop();
  if (row.board || row.endpoint) return { ...row, ...NO_WALL };
  if (!row.wall) {
    const walled = absorbed.filter((a) => a.wall).sort((a, b) => b.wall_last_on.localeCompare(a.wall_last_on))[0];
    if (walled) {
      Object.assign(row, {
        wall: walled.wall,
        wall_first_on: walled.wall_first_on,
        wall_last_on: walled.wall_last_on,
        wall_dates: walled.wall_dates,
      });
    }
  }
  return row;
}

/**
 * Each search's one record of a merged company: the most recently swept wins,
 * the kept company's on a tie, and a winner with no note takes the latest note
 * another record has.
 * @param {string} keptKey
 * @param {SweepRow[]} rows every search's records under the kept and absorbed keys
 * @param {string} finalKey the key they will sit under
 * @returns {SweepRow[]}
 */
export function mergedSweeps(keptKey, rows, finalKey) {
  const bySearch = new Map();
  for (const r of rows) {
    const id = JSON.stringify([r.user_id, r.search]);
    if (!bySearch.has(id)) bySearch.set(id, []);
    bySearch.get(id).push(r);
  }
  return [...bySearch.values()].map((group) => {
    const ordered = [...group].sort(
      (a, b) => b.last_swept.localeCompare(a.last_swept) || (b.company_key === keptKey) - (a.company_key === keptKey)
    );
    const [winner] = ordered;
    return {
      user_id: winner.user_id,
      search: winner.search,
      company_key: finalKey,
      last_swept: winner.last_swept,
      note: winner.note || ordered.find((r) => r.note)?.note || "",
    };
  });
}

/**
 * The whole request as changes, or the reason it can't be made. Nothing is
 * planned when anything is wrong, so a request is applied whole or not at all.
 *
 * Refused: a name that isn't on the list, a retracted row (its withdrawal is a
 * decision a person made, and a merge would bury it), a company named twice in
 * one request, and a new name that is already another company's - that is a
 * merge, and should be asked for as one.
 *
 * @param {Object} body `{ merges?: [{keep, absorb: [...], rename?}], renames?: [{from, to, clear_facts?}] }`
 * @param {FetchRow[]} fetchRows the rows namedKeys names
 * @param {SweepRow[]} sweepRows every search's records under those keys
 * @returns {{error: string, status: number} | {changes: Change[]}}
 */
export function planCleanup(body, fetchRows, sweepRows) {
  const merges = body.merges === undefined ? [] : body.merges;
  const renames = body.renames === undefined ? [] : body.renames;
  if (!Array.isArray(merges) || !Array.isArray(renames)) {
    return { status: 400, error: "merges and renames must be lists" };
  }
  if (merges.length + renames.length === 0) return { status: 400, error: "nothing to do - send merges or renames" };

  const rows = new Map(fetchRows.map((r) => [r.company_key, r]));
  const used = new Set();
  const refuse = (status, error) => ({ status, error });

  /** @returns {FetchRow|{status: number, error: string}} */
  const claim = (name, role) => {
    const key = typeof name === "string" ? normalize(name) : "";
    if (!key) return refuse(400, `${role} must be a company name`);
    if (used.has(key)) return refuse(400, `"${name}" is named more than once - each company can be in one change`);
    used.add(key);
    const row = rows.get(key);
    if (!row) return refuse(404, `"${name}" is not on the company list`);
    if (row.retracted_on) return refuse(409, `"${row.display_name}" is retracted - clear the retraction before merging or renaming it`);
    return row;
  };
  // A new name may be the kept row's own key under another spelling, but never
  // another company's, including one this request is about to create.
  const finalKeys = new Set();
  const nameFor = (name, fromKey) => {
    const key = typeof name === "string" ? normalize(name) : "";
    if (!key) return refuse(400, "a new name must be a company name");
    if ((rows.has(key) && key !== fromKey) || finalKeys.has(key)) {
      return refuse(409, `"${name}" is already on the company list - merge into it instead of renaming`);
    }
    finalKeys.add(key);
    return { key, name: name.trim() };
  };
  const isRefusal = (x) => typeof x?.error === "string";

  /** @type {Change[]} */
  const changes = [];
  for (const m of merges) {
    const kept = claim(m?.keep, "keep");
    if (isRefusal(kept)) return kept;
    if (!Array.isArray(m.absorb) || m.absorb.length === 0) return refuse(400, `a merge into "${m.keep}" needs absorb: [names]`);
    const absorbed = [];
    for (const a of m.absorb) {
      const row = claim(a, "absorb");
      if (isRefusal(row)) return row;
      absorbed.push(row);
    }
    const target = m.rename === undefined ? { key: kept.company_key, name: kept.display_name } : nameFor(m.rename, kept.company_key);
    if (isRefusal(target)) return target;
    if (m.rename === undefined) finalKeys.add(kept.company_key);

    const keys = [kept.company_key, ...absorbed.map((a) => a.company_key)];
    changes.push({
      from_key: kept.company_key,
      absorbed_keys: absorbed.map((a) => a.company_key),
      row: { ...mergedFacts(kept, absorbed), company_key: target.key, display_name: target.name },
      before: [kept, ...absorbed],
      sweeps: mergedSweeps(kept.company_key, sweepRows.filter((s) => keys.includes(s.company_key)), target.key),
    });
  }

  for (const r of renames) {
    const from = claim(r?.from, "from");
    if (isRefusal(from)) return from;
    const target = nameFor(r.to, from.company_key);
    if (isRefusal(target)) return target;
    // An acquired company's facts describe the old careers site, so a caller
    // that knows they no longer apply clears them, and the next run re-learns
    // them under the new name.
    const facts = r.clear_facts === true
      ? { ...Object.fromEntries(FACT_FIELDS.map((f) => [f, ""])), verified_on: "", ...NO_WALL }
      : {};
    changes.push({
      from_key: from.company_key,
      absorbed_keys: [],
      row: { ...from, ...facts, company_key: target.key, display_name: target.name },
      before: [from],
      sweeps: sweepRows
        .filter((s) => s.company_key === from.company_key)
        .map((s) => ({ ...s, company_key: target.key })),
    });
  }
  return { changes };
}
