/**
 * All D1 access for a user's own data. Route modules and index.js call Db's
 * methods and never prepare statements for that data themselves, so only this
 * file knows what stores the rows.
 *
 * Every instance is bound to one user - `new Db(env.DB, userId)` - and every
 * statement filters on `this.userId`. Keep it a constructor argument, never a
 * per-method parameter: one forgotten argument at one call site would read or
 * overwrite another person's rows with nothing in the code looking wrong.
 *
 * Another user's row id doesn't resolve (getLead returns null, updateLead
 * reports no change), so a handler's not-found path is also its cross-user
 * access check.
 *
 * Users and sessions live in auth.js: resolving which user is calling has to
 * happen before a user-scoped Db exists.
 *
 * There is no build step, so the @typedef blocks below are the type contract
 * that editors and `tsc --checkJs` read.
 */

/**
 * @typedef {Object} Lead
 * @property {number} id
 * @property {string} user_id
 * @property {string} search - track key, matches Track.key
 * @property {string} found - YYYY-MM-DD, date first found
 * @property {string} company
 * @property {string} title
 * @property {string} location
 * @property {string} url
 * @property {string} verified - YYYY-MM-DD, date last verified live
 * @property {string} fit
 * @property {string} status - one of LEAD_STATUS in routes/leads.js
 * @property {string} notes
 * @property {string} team
 * @property {string} setup
 * @property {string} source
 * @property {string} link
 * @property {string} lastContact
 * @property {string} nextAction
 * @property {string} nextActionDate
 * @property {string} resume
 * @property {string} referral
 * @property {string} comp
 */

/**
 * @typedef {Object} Application
 * @property {number} id
 * @property {string} user_id
 * @property {string} leadId - the originating Lead.id as text, or '' if added by hand
 * @property {string} company
 * @property {string} title
 * @property {string} location - copied from the lead at creation, then editable
 * @property {string} dateApplied - YYYY-MM-DD
 * @property {string} status - one of APP_STATUS in routes/applications.js
 * @property {string} notes
 * @property {string} team
 * @property {string} setup
 * @property {string} source
 * @property {string} link
 * @property {string} lastContact
 * @property {string} nextAction
 * @property {string} nextActionDate
 * @property {string} resume
 * @property {string} referral
 * @property {string} comp
 * @property {string} dateRecruiterScreen
 * @property {string} dateTechScreen
 * @property {string} dateOnsite
 * @property {string} dateOffer
 * @property {string} dateRejected
 * @property {string} dateWithdrawn
 * @property {string} autofill - '' | 'filled' | 'failed'; whether the nightly fill has read
 *   this row's posting. Server bookkeeping: no route takes it from a caller. See
 *   migrations/0009_application_autofill.sql.
 * @property {string} autofill_note - why a read failed or came back partial; '' otherwise.
 *   Shown on the row
 */

/**
 * @typedef {Object} ScreenedItem
 * @property {number} id
 * @property {string} user_id
 * @property {string} search - track key
 * @property {string} url
 * @property {string} company
 * @property {string} title
 * @property {string} location
 * @property {string} reason
 * @property {string} date - YYYY-MM-DD, date screened
 */

/**
 * @typedef {Object} SearchRun
 * @property {string} user_id
 * @property {string} track_key
 * @property {string} last_run_at - ISO 8601 UTC instant, or '' if never recorded
 * @property {string} last_run_on - YYYY-MM-DD, the installer's local date
 * @property {string} status - 'ok' | 'error' | ''
 * @property {number} leads_added
 * @property {number} screened_added
 * @property {number} delisted
 * @property {string} note
 */

/**
 * @typedef {Object} Track
 * @property {string} key
 * @property {string} label
 * @property {string} full_description
 * @property {number} sort_order
 * @property {string} role_search_line
 * @property {string} target_companies - JSON array of company names
 * @property {string} search_note
 * @property {string} resume_line
 * @property {string} fit_clause
 * @property {string} fit_disqualifier
 * @property {string} doc_file
 * @property {string} doc_summary
 * @property {string} fit_filter_step
 * @property {string} leads_note
 * @property {string} doc_update_line
 * @property {string} intro_note
 * @property {string} report_line
 * @property {string} screened_examples
 * @property {string} schedule_time
 * @property {string} fed_by - key of the sibling track whose search fills this tab, '' when this track runs its own
 */

/**
 * @typedef {Track & {last_run: {at: string, on: string, status: string, leads_added: number, screened_added: number, delisted: number, note: string}}} TrackWithRun
 */

/**
 * @typedef {Object} Settings
 * @property {string} display_title
 * @property {string} overview_label
 * @property {string} applications_label
 * @property {string} all_leads_label
 * @property {number} stale_run_hours
 * @property {Array<Object>} priority_locations
 * @property {string[]} excluded_companies
 * @property {string} geo_scope_line
 * @property {string} scope_clause
 * @property {string} scope_disqualifier
 * @property {string} location_guidance
 * @property {string} footer_note
 * @property {string} pronouns
 */

import { normalize as normalizeCompany } from "./exclude.js";
import { canonicalUrl } from "./url.js";

// The route modules validate against these same lists, so validation and
// storage share one definition.
export const EXTRA_FIELDS = [
  "team", "setup", "source", "link", "lastContact",
  "nextAction", "nextActionDate", "resume", "referral", "comp",
];
export const APP_STAGE_DATE_FIELDS = [
  "dateRecruiterScreen", "dateTechScreen", "dateOnsite",
  "dateOffer", "dateRejected", "dateWithdrawn",
];

// The `reason` on the screened row a delisted lead leaves behind. The lead is
// deleted, so that row is the only record a posting came down, and
// countRunActivity splits a day's screened rows on this exact text to tell a
// delisting from an ordinary rejection.
//
// Don't change it: migrations/0004_drop_lead_delisted_on.sql hardcodes the
// same text in SQL, and existing rows would be silently reclassified.
export const DELISTED_REASON = "posting taken down";

// Every track column except `key`, split by audience: the client reads the
// first list to draw tabs, and only prompt.js reads the second. POST
// /api/config writes both.
export const TRACK_DISPLAY_FIELDS = ["label", "full_description", "sort_order"];
export const TRACK_CONFIG_FIELDS = [
  "role_search_line", "target_companies", "search_note", "resume_line",
  "fit_clause", "fit_disqualifier", "fit_filter_step", "leads_note",
  "doc_file", "doc_summary", "doc_update_line", "intro_note", "report_line",
  "screened_examples", "schedule_time", "fed_by",
];

// Settings the client renders from...
export const SETTING_KEYS = [
  "display_title", "overview_label", "applications_label", "all_leads_label",
  "stale_run_hours",
];
// ...and settings only prompt.js reads: the per-user half of the search config
// (TRACK_CONFIG_FIELDS is the per-track half). Stored as verbatim prose - don't
// rebuild these sentences from keywords, which would drop hand-written detail
// the searches depend on.
export const PROMPT_SETTING_KEYS = [
  "geo_scope_line", "scope_clause", "scope_disqualifier",
  "location_guidance", "footer_note", "pronouns",
];

export const DEFAULT_SETTINGS = {
  display_title: "Job Search Tracker",
  overview_label: "Overview",
  applications_label: "Applications",
  // The built-in cross-track leads tab.
  all_leads_label: "All leads",
  stale_run_hours: 36,
  priority_locations: [],
  // A list rather than a sentence in a track's prose, so "is X excluded?" is a
  // lookup and adding a company is an append.
  excluded_companies: [],
  // No geographic restriction by default: an unconfigured deployment shouldn't
  // filter out postings it was never told to exclude.
  geo_scope_line: "",
  scope_clause: "",
  scope_disqualifier: "",
  location_guidance:
    "Write accurate location strings - the tracker derives priority from them " +
    "automatically, so precision matters. There is no priority field to set - " +
    "just get the location text right.",
  footer_note: "",
  pronouns: "they/them",
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Every column an application row is created with. Both insert paths
// (insertApplication, and the transaction in
// setLeadStatusAndMaybeCreateApplication) share this one list, so a new field
// can't reach only one of them.
const APPLICATION_COLS = [
  "leadId", "company", "title", "location", "dateApplied", "status", "notes",
  ...EXTRA_FIELDS, ...APP_STAGE_DATE_FIELDS, "autofill", "autofill_note",
];

// The columns an autofill read may write: what a posting states plainly. The
// rest (referral, resume, source, notes, stage dates) is the person's own
// account of their search, which no posting can supply. team/setup/comp are
// the same posting-stated extras the search captures in prompt.js.
const AUTOFILL_FILL_FIELDS = ["company", "title", "location", "team", "setup", "comp"];

// Don't set `autofill` here: whether a row's posting wants reading is derived
// from the row when a run asks (getAutofillQueue), so nothing that creates an
// application has to know about the fill.
function applicationValues(fields) {
  return APPLICATION_COLS.map((f) => {
    if (f === "dateApplied") return fields.dateApplied || today();
    if (f === "status") return fields.status || "Applied";
    return fields[f] || "";
  });
}

// Most values one statement may name in an `IN (...)` list. D1 rejects a
// statement with more than 100 bound parameters, and a single call can carry
// more ids or names than that, so callers split the list across statements in
// one batch. 90 leaves room for the statement's other bindings.
const ID_CHUNK = 90;

export class Db {
  /**
   * @param {D1Database} d1
   * @param {string} userId - every statement below is filtered to this user
   */
  constructor(d1, userId) {
    this.d1 = d1;
    this.userId = userId;
  }

  // ---------------------------------------------------------------- meta --

  /** @returns {Promise<string|null>} this user's 'updated' timestamp, or null if never set */
  async getUpdatedTimestamp() {
    const row = await this.d1
      .prepare("SELECT value FROM meta WHERE user_id = ? AND key = 'updated'")
      .bind(this.userId)
      .first();
    return row ? row.value : null;
  }

  /** Stamps 'updated' with today's date - call after any write a viewer should see reflected. */
  async touchUpdated() {
    await this.d1
      .prepare(
        `INSERT INTO meta (user_id, key, value) VALUES (?, 'updated', ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
      )
      .bind(this.userId, today())
      .run();
  }

  // -------------------------------------------------------- full dumps --

  /** @returns {Promise<Lead[]>} */
  async getAllLeads() {
    const res = await this.d1
      .prepare("SELECT * FROM leads WHERE user_id = ? ORDER BY id")
      .bind(this.userId)
      .all();
    return res.results;
  }

  /** @returns {Promise<Application[]>} */
  async getAllApplications() {
    const res = await this.d1
      .prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY id")
      .bind(this.userId)
      .all();
    return res.results;
  }

  /** @returns {Promise<ScreenedItem[]>} */
  async getAllScreened() {
    const res = await this.d1
      .prepare("SELECT * FROM screened WHERE user_id = ? ORDER BY id")
      .bind(this.userId)
      .all();
    return res.results;
  }

  /**
   * What a daily run needs to skip what it has already seen, for one track: its
   * leads' ids, urls and statuses, and the urls it has screened out.
   *
   * Kept to these columns and this track because the result lands in the run's
   * context every night and screened rows grow without bound. A full dump
   * would eventually be truncated, and the run would re-add postings it had
   * already ruled out.
   *
   * `status` tells an untouched lead from one already applied to; `id` is what
   * a dead posting is reported against (routes/delisting.js's removeDelistedLead).
   * @param {string} trackKey
   * @returns {Promise<{leads: Array<{id: number, url: string, status: string}>, screened: string[]}>}
   */
  async getDedupData(trackKey) {
    const [leads, screened] = await Promise.all([
      this.d1
        .prepare("SELECT id, url, status FROM leads WHERE user_id = ? AND search = ? ORDER BY id")
        .bind(this.userId, trackKey)
        .all(),
      this.d1
        .prepare("SELECT url FROM screened WHERE user_id = ? AND search = ? ORDER BY id")
        .bind(this.userId, trackKey)
        .all(),
    ]);
    return { leads: leads.results, screened: screened.results.map((r) => r.url) };
  }

  // ---------------------------------------------------- company sweeps --

  /**
   * Shared facts for a set of company names, keyed by normalize().
   *
   * Not user-scoped, by design: the caller supplies names and gets back facts
   * about websites, nothing derived from any user's rows. See
   * migrations/0010_company_fetch.sql and 0011_one_company_list.sql.
   *
   * A retracted row comes back with its fields blanked and only the retraction
   * visible, so a reader cannot use a withdrawn fact by forgetting to check one
   * more field.
   *
   * A row with no facts is left out. Every listed company has a row, most of
   * them bare membership, and an empty entry would claim something is known
   * about a company nothing has looked at.
   *
   * A wall is served only when recorded on at least two separate dates and
   * last recorded within seven days. Otherwise it is left out rather than
   * flagged, so a run meeting an expired wall simply fetches, which is the
   * re-test.
   *
   * @param {string[]} names @returns {Promise<Map<string, Object>>} by company_key
   */
  async getCompanyFetch(names) {
    const keys = [...new Set(names.map(normalizeCompany).filter(Boolean))];
    if (keys.length === 0) return new Map();
    // Chunked by ID_CHUNK: routes/coverage.js's `?all=1` asks for the whole list.
    const chunks = [];
    for (let i = 0; i < keys.length; i += ID_CHUNK) chunks.push(keys.slice(i, i + ID_CHUNK));
    const batches = await this.d1.batch(
      chunks.map((chunk) =>
        this.d1
          .prepare(`SELECT * FROM company_fetch WHERE company_key IN (${chunk.map(() => "?").join(",")})`)
          .bind(...chunk)
      )
    );
    const found = batches.flatMap((b) => b.results);
    const WALL_MIN_DATES = 2, WALL_SERVED_DAYS = 7;
    const wallFreshFrom = new Date(Date.now() - WALL_SERVED_DAYS * 86400000).toISOString().slice(0, 10);
    const out = new Map();
    for (const r of found) {
      if (r.retracted_on) {
        out.set(r.company_key, { retracted_on: r.retracted_on, retracted_note: r.retracted_note || "" });
        continue;
      }
      const facts = {
        board: r.board || "",
        endpoint: r.endpoint || "",
        url_shape: r.url_shape || "",
        dead_signal: r.dead_signal || "",
        note: r.note || "",
        verified_on: r.verified_on || "",
      };
      const wallServed = !!r.wall && r.wall_dates >= WALL_MIN_DATES && r.wall_last_on >= wallFreshFrom;
      if (wallServed) {
        facts.wall = r.wall;
        facts.wall_last_on = r.wall_last_on;
      }
      if (facts.board || facts.endpoint || facts.url_shape || facts.dead_signal || facts.note || wallServed) {
        out.set(r.company_key, facts);
      }
    }
    return out;
  }

  /**
   * Record what a run learned about reaching a company.
   *
   * Non-empty-wins, field by field: a run that confirmed an endpoint but has
   * nothing to say about the dead signal must not wipe what an earlier run
   * established, or the shared table degrades every time a run is terse.
   *
   * `wall` counts separate dates, not reports - two runs meeting one wall on one
   * day are one piece of evidence. A reported board or endpoint clears it, since
   * a fetch that worked settles the question. And only a positive fact moves
   * `verified_on`: meeting a wall is not confirming the row works.
   *
   * A row already retracted is left alone. Re-asserting a withdrawn fact is a
   * decision a person makes by clearing the retraction, not something a run
   * should be able to do by rediscovering the same wrong thing.
   *
   * @param {Array<{company: string, board?: string, endpoint?: string,
   *   url_shape?: string, dead_signal?: string, note?: string, wall?: string}>} rows
   * @param {string} on YYYY-MM-DD, or "" for a fact nobody dated, which is
   *   stamped with the server's date: `verified_on` records when a fact was
   *   established. A wall never arrives undated - routes/coverage.js refuses
   *   that before calling this.
   */
  async upsertCompanyFetch(rows, on) {
    const date = on || today();
    const useful = rows.filter(
      (r) =>
        normalizeCompany(r.company) &&
        (r.board || r.endpoint || r.url_shape || r.dead_signal || r.note || r.wall)
    );
    if (useful.length === 0) return { written: 0 };

    const works = "(excluded.board <> '' OR excluded.endpoint <> '')";
    const positive =
      "(excluded.board <> '' OR excluded.endpoint <> '' OR excluded.url_shape <> '' OR excluded.dead_signal <> '')";
    const stmt = this.d1.prepare(
      `INSERT INTO company_fetch
         (company_key, display_name, board, endpoint, url_shape, dead_signal, note, verified_on,
          wall, wall_first_on, wall_last_on, wall_dates)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_key) DO UPDATE SET
         display_name  = CASE WHEN company_fetch.display_name = '' THEN excluded.display_name ELSE company_fetch.display_name END,
         board         = CASE WHEN excluded.board <> ''       THEN excluded.board       ELSE company_fetch.board END,
         endpoint      = CASE WHEN excluded.endpoint <> ''    THEN excluded.endpoint    ELSE company_fetch.endpoint END,
         url_shape     = CASE WHEN excluded.url_shape <> ''   THEN excluded.url_shape   ELSE company_fetch.url_shape END,
         dead_signal   = CASE WHEN excluded.dead_signal <> '' THEN excluded.dead_signal ELSE company_fetch.dead_signal END,
         note          = CASE WHEN excluded.note <> ''        THEN excluded.note        ELSE company_fetch.note END,
         verified_on   = CASE WHEN ${positive} THEN excluded.verified_on ELSE company_fetch.verified_on END,
         wall          = CASE WHEN ${works} THEN ''
                              WHEN excluded.wall <> '' THEN excluded.wall
                              ELSE company_fetch.wall END,
         wall_first_on = CASE WHEN ${works} THEN ''
                              WHEN excluded.wall <> '' AND company_fetch.wall_first_on = '' THEN excluded.wall_last_on
                              ELSE company_fetch.wall_first_on END,
         wall_last_on  = CASE WHEN ${works} THEN ''
                              WHEN excluded.wall <> '' THEN excluded.wall_last_on
                              ELSE company_fetch.wall_last_on END,
         wall_dates    = CASE WHEN ${works} THEN 0
                              WHEN excluded.wall <> '' AND company_fetch.wall_last_on = excluded.wall_last_on THEN company_fetch.wall_dates
                              WHEN excluded.wall <> '' THEN company_fetch.wall_dates + 1
                              ELSE company_fetch.wall_dates END
       WHERE company_fetch.retracted_on = ''`
    );
    const res = await this.d1.batch(
      useful.map((r) => {
        const isPositive = !!(r.board || r.endpoint || r.url_shape || r.dead_signal);
        const wall = r.board || r.endpoint ? "" : r.wall || "";
        return stmt.bind(
          normalizeCompany(r.company),
          String(r.company).trim(),
          r.board || "",
          r.endpoint || "",
          r.url_shape || "",
          r.dead_signal || "",
          r.note || "",
          isPositive ? date : "",
          wall,
          wall ? date : "",
          wall ? date : "",
          wall ? 1 : 0
        );
      })
    );
    return { written: res.reduce((n, x) => n + (x.meta.changes || 0), 0) };
  }

  /**
   * Put companies on the list.
   *
   * Membership only: what a row says about the company's website is written by
   * upsertCompanyFetch, on the same call, dated or not. A company
   * already on the list keeps its place and its name: a position is assigned
   * once, when a company joins, and never moves, or the cursor would step over
   * companies it had already passed.
   *
   * Not scoped to this.userId: the list is shared by every account, by design -
   * see 0011_one_company_list.sql.
   * @param {{company: string, position: number}[]} items
   * @returns {Promise<number>} how many joined
   */
  async addCompanies(items) {
    const rows = items.filter((i) => normalizeCompany(i.company));
    if (rows.length === 0) return 0;
    const stmt = this.d1.prepare(
      `INSERT INTO company_fetch (company_key, display_name, position) VALUES (?, ?, ?)
       ON CONFLICT(company_key) DO NOTHING`
    );
    const res = await this.d1.batch(
      rows.map((i) => stmt.bind(normalizeCompany(i.company), String(i.company).trim(), i.position))
    );
    return res.reduce((n, x) => n + (x.meta.changes || 0), 0);
  }

  /**
   * The list in log order, with this search's own record of each company.
   *
   * The list is global (company_fetch, 0011_one_company_list.sql); what this
   * search did with each company - when it last tried, what it noted - is its
   * own, in company_sweeps. Ordered by `position`, a fixed place per company,
   * never by date. routes/coverage.js picks a run's slice from the cursor.
   *
   * company_sweeps is keyed by the name a run wrote, so one search can hold two
   * rows for spellings normalize() merges. The most recently swept wins, then
   * the newest row, so the answer never depends on SQLite's read order.
   *
   * `board` is the shared one, blank on a retracted row: a withdrawn board is
   * not a hint.
   *
   * Returns the whole list; the caller windows it. Slicing in SQL would mean
   * LIMIT-ing before excluded companies are filtered out, which is what would
   * quietly hand a run a short batch.
   * @param {string} search
   * @returns {Promise<Array<{company: string, last_swept: string, board: string, note: string, position: number}>>}
   */
  async getCoverage(search) {
    const rows = await this.d1
      .prepare(
        `SELECT COALESCE(NULLIF(f.display_name, ''), f.company_key) AS company,
                f.position,
                CASE WHEN f.retracted_on = '' THEN f.board ELSE '' END AS board,
                COALESCE(s.last_swept, '') AS last_swept,
                COALESCE(s.note, '') AS note
           FROM company_fetch f
           LEFT JOIN company_sweeps s ON s.rowid = (
             SELECT x.rowid FROM company_sweeps x
              WHERE x.user_id = ? AND x.search = ? AND x.company_key = f.company_key
              ORDER BY x.last_swept DESC, x.rowid DESC
              LIMIT 1)
          ORDER BY f.position, f.company_key`
      )
      .bind(this.userId, search)
      .all();
    return rows.results;
  }

  /** @param {string} key @returns {Promise<number>} how far along the log this search has read */
  async getSweepCursor(key) {
    const row = await this.d1
      .prepare("SELECT sweep_cursor FROM tracks WHERE user_id = ? AND key = ?")
      .bind(this.userId, key)
      .first();
    return (row && Number(row.sweep_cursor)) || 0;
  }

  /**
   * Moves the cursor to just past the last company a run reported from the
   * slice it was served - routes/coverage.js decides which company that is.
   *
   * Set rather than incremented, and from the companies actually reported: a
   * run that covered fewer companies than it was handed must not advance the
   * cursor past the ones it skipped, or they wait a whole cycle.
   * @param {string} key @param {number} next
   */
  async setSweepCursor(key, next) {
    // Stored unwrapped. Don't take it modulo the company count: gaps and
    // excluded rows make the count differ from the highest position. The read
    // in routes/coverage.js wraps.
    const value = Math.max(0, Math.floor(next));
    await this.d1
      .prepare("UPDATE tracks SET sweep_cursor = ? WHERE user_id = ? AND key = ?")
      .bind(value, this.userId, key)
      .run();
    return value;
  }

  /**
   * This search's record of the companies it covered.
   *
   * One row per company per search, created on write. `last_swept` and `note`
   * only overwrite when non-empty: an empty `on` is how a caller registers
   * companies without claiming to have swept them, and a terse run must not
   * blank a note an earlier one wrote.
   *
   * Membership is not written here - that is addCompanies, on the shared list.
   * Readers join on `company_key`; `board` and `position` mirror the list only
   * for rollback compatibility (see 0011_one_company_list.sql).
   * @param {string} search
   * @param {{company: string, board?: string, note?: string, position: number}[]} items
   *   `company` is the name as the list holds it, so every spelling of one
   *   company lands on one row.
   * @param {string} on - YYYY-MM-DD
   */
  async recordSweeps(search, items, on) {
    const stmt = this.d1.prepare(
      `INSERT INTO company_sweeps (user_id, search, company, company_key, last_swept, board, note, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, search, company) DO UPDATE SET
         company_key = excluded.company_key,
         last_swept = CASE WHEN excluded.last_swept <> '' THEN excluded.last_swept ELSE company_sweeps.last_swept END,
         board = CASE WHEN excluded.board <> '' THEN excluded.board ELSE company_sweeps.board END,
         note = CASE WHEN excluded.note <> '' THEN excluded.note ELSE company_sweeps.note END,
         position = excluded.position`
    );
    await this.d1.batch(
      items.map((i) =>
        stmt.bind(
          this.userId,
          search,
          i.company,
          normalizeCompany(i.company),
          on,
          typeof i.board === "string" ? i.board : "",
          typeof i.note === "string" ? i.note : "",
          Number.isFinite(i.position) ? i.position : 0
        )
      )
    );
    return items.length;
  }

  // -------------------------------------------------- tracks & settings --

  /** @returns {Promise<{tracks: TrackWithRun[], settings: Settings}>} */
  async getTracksAndSettings() {
    const trackCols = ["key", ...TRACK_DISPLAY_FIELDS, ...TRACK_CONFIG_FIELDS]
      .map((f) => `t.${f}`)
      .join(", ");
    const settingKeys = ["priority_locations", "excluded_companies", ...SETTING_KEYS, ...PROMPT_SETTING_KEYS];
    const [tracksRes, settingsRows] = await Promise.all([
      this.d1
        .prepare(
          `SELECT ${trackCols},
                  r.last_run_at, r.last_run_on, r.status AS last_run_status,
                  r.leads_added, r.screened_added, r.delisted, r.note
           FROM tracks t
           LEFT JOIN search_runs r ON r.track_key = t.key AND r.user_id = t.user_id
           WHERE t.user_id = ?
           ORDER BY t.sort_order, t.key`
        )
        .bind(this.userId)
        .all(),
      this.d1
        .prepare(
          `SELECT key, value FROM meta WHERE user_id = ? AND key IN (${settingKeys
            .map(() => "?")
            .join(", ")})`
        )
        .bind(this.userId, ...settingKeys)
        .all(),
    ]);

    const settings = { ...DEFAULT_SETTINGS };
    for (const row of settingsRows.results) {
      if (row.key === "priority_locations" || row.key === "excluded_companies") {
        try {
          settings[row.key] = JSON.parse(row.value);
        } catch {
          settings[row.key] = [];
        }
      } else if (row.key === "stale_run_hours") {
        const n = Number(row.value);
        if (Number.isFinite(n) && n > 0) settings.stale_run_hours = n;
      } else {
        settings[row.key] = row.value;
      }
    }

    const tracks = tracksRes.results.map((row) => {
      const track = { key: row.key };
      for (const f of [...TRACK_DISPLAY_FIELDS, ...TRACK_CONFIG_FIELDS]) track[f] = row[f];
      track.last_run = {
        at: row.last_run_at || "",
        on: row.last_run_on || "",
        status: row.last_run_status || "",
        leads_added: row.leads_added || 0,
        screened_added: row.screened_added || 0,
        delisted: row.delisted || 0,
        note: row.note || "",
      };
      return track;
    });

    return { tracks, settings };
  }

  /** @param {string} key @returns {Promise<Track|null>} */
  async getTrack(key) {
    const row = await this.d1
      .prepare("SELECT * FROM tracks WHERE user_id = ? AND key = ?")
      .bind(this.userId, key)
      .first();
    return row || null;
  }

  /** @param {string} key @returns {Promise<boolean>} */
  async trackExists(key) {
    return !!(await this.getTrack(key));
  }

  /**
   * How many rows a retired search still has, per table. Read-only, and the
   * thing a purge should be able to show someone before it runs.
   * @param {string} key
   * @returns {Promise<{leads: number, screened: number, sweeps: number, runs: number, applications: number}>}
   */
  async countSearchRows(key) {
    const one = async (sql) =>
      ((await this.d1.prepare(sql).bind(this.userId, key).first()) || {}).n || 0;
    const [leads, screened, sweeps, runs] = await Promise.all([
      one("SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND search = ?"),
      one("SELECT COUNT(*) AS n FROM screened WHERE user_id = ? AND search = ?"),
      one("SELECT COUNT(*) AS n FROM company_sweeps WHERE user_id = ? AND search = ?"),
      one("SELECT COUNT(*) AS n FROM search_runs WHERE user_id = ? AND track_key = ?"),
    ]);
    // Applications have no search column; they point at a lead id. These are
    // the ones a purge would leave pointing at nothing.
    const apps = await this.d1
      .prepare(
        `SELECT COUNT(*) AS n FROM applications
          WHERE user_id = ? AND leadId != ''
            AND leadId IN (SELECT CAST(id AS TEXT) FROM leads WHERE user_id = ? AND search = ?)`
      )
      .bind(this.userId, this.userId, key)
      .first();
    return { leads, screened, sweeps, runs, applications: (apps && apps.n) || 0 };
  }

  /**
   * Removes every trace of one retired search: its leads, the postings it
   * screened, its company sweep records, and its run record.
   *
   * One transaction, because a half-purged search is worse than an un-purged
   * one: screened rows left without their leads still suppress rediscovery.
   *
   * Applications are kept, with `leadId` cleared to '' - the schema's "added by
   * hand" (migrations/0001_schema.sql). An application is the least
   * recoverable record here, and a dangling id would point at a deleted lead.
   *
   * No applied-to check, unlike delisting: the caller is retiring the whole
   * search on purpose, and the applications survive it.
   *
   * @param {string} key
   * @returns {Promise<{leads: number, screened: number, sweeps: number, runs: number, applications: number}>} rows affected
   */
  async purgeSearch(key) {
    const before = await this.countSearchRows(key);
    await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE applications SET leadId = ''
            WHERE user_id = ? AND leadId != ''
              AND leadId IN (SELECT CAST(id AS TEXT) FROM leads WHERE user_id = ? AND search = ?)`
        )
        .bind(this.userId, this.userId, key),
      this.d1.prepare("DELETE FROM leads WHERE user_id = ? AND search = ?").bind(this.userId, key),
      this.d1.prepare("DELETE FROM screened WHERE user_id = ? AND search = ?").bind(this.userId, key),
      this.d1.prepare("DELETE FROM company_sweeps WHERE user_id = ? AND search = ?").bind(this.userId, key),
      this.d1.prepare("DELETE FROM search_runs WHERE user_id = ? AND track_key = ?").bind(this.userId, key),
    ]);
    return before;
  }

  /**
   * Replaces this user's whole track list in one batch (one real transaction)
   * and keeps `search_runs` 1:1 with it - a new track gets an empty "never
   * ran" row, a removed track's run row goes with it. Scoped to this user
   * throughout: another person's tracks are neither read, updated, nor caught
   * by the "not in the new list" deletes.
   * @param {Array<Partial<Track> & {key: string}>} tracks
   */
  async replaceTracks(tracks) {
    const cols = [...TRACK_DISPLAY_FIELDS, ...TRACK_CONFIG_FIELDS];

    // A field the payload omits keeps its stored value. `tracks` replaces which
    // tracks exist, but posting `{key, label}` to rename a tab must not blank
    // its config - the prompt would quietly fall back to generic defaults.
    // Clear a field by sending "".
    const existing = {};
    const current = await this.d1
      .prepare(`SELECT key, ${cols.join(", ")} FROM tracks WHERE user_id = ?`)
      .bind(this.userId)
      .all();
    for (const row of current.results) existing[row.key] = row;

    // Posted, then stored, then default. `sort_order` too: defaulting it to the
    // array index would reorder tabs when a caller posts them in another order.
    const keep = (t, f, fallback) => {
      const stored = existing[t.key] && existing[t.key][f];
      return stored !== undefined && stored !== null ? stored : fallback;
    };
    const stmt = this.d1.prepare(
      `INSERT INTO tracks (user_id, key, ${cols.join(", ")})
       VALUES (?, ?, ${cols.map(() => "?").join(", ")})
       ON CONFLICT(user_id, key) DO UPDATE SET
         ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`
    );
    // INSERT OR IGNORE: re-posting an unchanged track list is normal and must
    // not wipe run history.
    const runStmt = this.d1.prepare(
      "INSERT OR IGNORE INTO search_runs (user_id, track_key) VALUES (?, ?)"
    );
    const placeholders = tracks.map(() => "?").join(", ");
    const keys = tracks.map((t) => t.key);
    const batch = [
      this.d1
        .prepare(`DELETE FROM tracks WHERE user_id = ? AND key NOT IN (${placeholders})`)
        .bind(this.userId, ...keys),
      this.d1
        .prepare(`DELETE FROM search_runs WHERE user_id = ? AND track_key NOT IN (${placeholders})`)
        .bind(this.userId, ...keys),
      ...tracks.map((t, i) =>
        stmt.bind(
          this.userId,
          t.key,
          typeof t.label === "string" && t.label ? t.label : keep(t, "label", t.key),
          typeof t.full_description === "string" ? t.full_description : keep(t, "full_description", ""),
          Number.isInteger(t.sort_order) ? t.sort_order : keep(t, "sort_order", i),
          ...TRACK_CONFIG_FIELDS.map((f) => {
            // target_companies is the one structured field: accept an array
            // and store it as JSON, or pass through a string that already is.
            if (f === "target_companies" && Array.isArray(t[f])) return JSON.stringify(t[f]);
            if (typeof t[f] === "string") return t[f];
            return keep(t, f, "");
          })
        )
      ),
      ...keys.map((k) => runStmt.bind(this.userId, k)),
    ];
    await this.d1.batch(batch);
  }

  /**
   * Sets any subset of this user's settings.
   *
   * An empty string means different things per group. A display label of "" is
   * ignored, so DEFAULT_SETTINGS applies. A prompt setting of "" is stored:
   * clearing a geographic restriction or a footer note is a real instruction,
   * and ignoring it would leave the searches excluding what they were told to
   * stop excluding.
   * @param {Partial<Settings>} patch
   */
  async setSettings(patch) {
    const labels = SETTING_KEYS.filter((k) => k !== "stale_run_hours");
    for (const key of labels) {
      if (typeof patch[key] === "string" && patch[key]) {
        await this.setSetting(key, patch[key]);
      }
    }
    for (const key of PROMPT_SETTING_KEYS) {
      if (typeof patch[key] === "string") {
        await this.setSetting(key, patch[key]);
      }
    }
    if (patch.stale_run_hours != null) {
      await this.setSetting("stale_run_hours", String(patch.stale_run_hours));
    }
    if (Array.isArray(patch.priority_locations)) {
      await this.setSetting("priority_locations", JSON.stringify(patch.priority_locations));
    }
    // An empty array is a real instruction ("exclude no one"), so any array is written.
    if (Array.isArray(patch.excluded_companies)) {
      await this.setSetting(
        "excluded_companies",
        JSON.stringify(patch.excluded_companies.filter((c) => typeof c === "string" && c.trim()))
      );
    }
  }

  /** @param {string} key @param {string} value */
  async setSetting(key, value) {
    await this.d1
      .prepare(
        `INSERT INTO meta (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
      )
      .bind(this.userId, key, value)
      .run();
  }

  // ------------------------------------------------------------- runs --

  /**
   * What one track gained on one date, counted from the rows themselves. A run
   * record's numbers come from here, not from the caller (see routes/runs.js's
   * handleRecordRun).
   *
   *   - `leadsAdded`: leads under this key whose `found` is this date.
   *   - `delisted`: screened rows carrying DELISTED_REASON (see above).
   *   - `screenedAdded`: every other screened row that day, so a delisting
   *     isn't counted in both columns.
   *
   * Only `added_by = 'run'` screened rows count, so a person clearing postings
   * off their board isn't reported as the search's work
   * (migrations/0007_screened_added_by.sql).
   *
   * Each key counts only its own rows; a multi-tab run calls this once per tab.
   *
   * @param {string} key - track key
   * @param {string} on - YYYY-MM-DD, the run's own local date
   * @returns {Promise<{leadsAdded: number, screenedAdded: number, delisted: number}>}
   */
  async countRunActivity(key, on) {
    const [leads, screened] = await Promise.all([
      this.d1
        .prepare("SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND search = ? AND found = ?")
        .bind(this.userId, key, on)
        .first(),
      // One query, so both sums agree on what "not delisted" means.
      this.d1
        .prepare(
          `SELECT SUM(CASE WHEN reason = ? THEN 1 ELSE 0 END) AS delisted,
                  SUM(CASE WHEN reason <> ? THEN 1 ELSE 0 END) AS screened
             FROM screened
            WHERE user_id = ? AND search = ? AND date = ? AND added_by = 'run'`
        )
        .bind(DELISTED_REASON, DELISTED_REASON, this.userId, key, on)
        .first(),
    ]);
    // SUM over zero rows is NULL in SQLite, and a quiet day is normal.
    return {
      leadsAdded: (leads && leads.n) || 0,
      screenedAdded: (screened && screened.screened) || 0,
      delisted: (screened && screened.delisted) || 0,
    };
  }

  /**
   * @param {string} key
   * @param {{at: string, on: string, status: string, leadsAdded: number, screenedAdded: number, delisted: number, note: string}} run
   * @returns {Promise<SearchRun>}
   */
  async recordRun(key, run) {
    const [row] = await this.recordRuns([{ key, ...run }]);
    return row;
  }

  /**
   * Writes a run record for every tab one run filled, in one transaction
   * (d1.batch). Written one at a time, a failure partway would leave tabs that
   * were searched reading as never run, after the run could no longer retry.
   *
   * The caller computes the counts first: they are reads, and stay outside the
   * write transaction.
   *
   * @param {Array<{key: string, at: string, on: string, status: string, leadsAdded: number, screenedAdded: number, delisted: number, note: string}>} runs
   * @returns {Promise<SearchRun[]>} the written rows, in the order asked for
   */
  async recordRuns(runs) {
    if (!runs.length) return [];
    const stmt = this.d1.prepare(
      `INSERT INTO search_runs
         (user_id, track_key, last_run_at, last_run_on, status, leads_added, screened_added, delisted, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, track_key) DO UPDATE SET
         last_run_at = excluded.last_run_at, last_run_on = excluded.last_run_on,
         status = excluded.status, leads_added = excluded.leads_added,
         screened_added = excluded.screened_added, delisted = excluded.delisted,
         note = excluded.note`
    );
    await this.d1.batch(
      runs.map((r) =>
        stmt.bind(
          this.userId, r.key, r.at, r.on, r.status,
          r.leadsAdded, r.screenedAdded, r.delisted, r.note
        )
      )
    );

    const keys = runs.map((r) => r.key);
    const res = await this.d1
      .prepare(
        `SELECT * FROM search_runs
          WHERE user_id = ? AND track_key IN (${keys.map(() => "?").join(", ")})`
      )
      .bind(this.userId, ...keys)
      .all();
    // Read back in the caller's order, not the database's: the first entry is
    // the track the run posted about, and the response distinguishes it from
    // the tabs written on its behalf.
    const byKey = new Map(res.results.map((r) => [r.track_key, r]));
    return keys.map((k) => byKey.get(k)).filter(Boolean);
  }

  // ------------------------------------------------------------ leads --

  /**
   * Splits a batch into the rows whose posting this user doesn't already have,
   * and a count of the rest. Shared by addLeads and addScreened.
   *
   * A row is already known if its canonical URL (./url.js) matches a lead or a
   * screened row anywhere in the same feed group: the track that runs a search
   * plus the tabs it fills (`fed_by`, migrations/0003_branched_tracks.sql).
   * Scoped to one track, a posting filed under one tab and sorted into a
   * sibling tab the next night would read as new and be added twice.
   *
   * Two independent tracks with the same posting still get a row each; a feed
   * group is one search with several outputs.
   *
   * Rows accepted earlier in the same batch join the set, which catches one
   * payload naming a posting twice.
   *
   * @param {Array<{search: string, url: string}>} rows
   * @returns {Promise<{fresh: Array<Object>, duplicates: number}>}
   */
  async dropKnownUrls(rows) {
    const asked = [...new Set(rows.map((r) => r.search).filter(Boolean))];
    if (asked.length === 0) return { fresh: [], duplicates: rows.length };

    // A track's feed group: the track that runs the search, plus every tab it
    // fills. `fed_by` is one level (a fed track is a tab, not a search), so
    // the root is one hop and the group is everything sharing that root.
    const tracks = await this.d1
      .prepare("SELECT key, fed_by FROM tracks WHERE user_id = ?")
      .bind(this.userId)
      .all();
    const rootOf = new Map(tracks.results.map((t) => [t.key, t.fed_by || t.key]));
    const root = (k) => rootOf.get(k) || k;

    const roots = new Set(asked.map(root));
    const groupKeys = tracks.results.map((t) => t.key).filter((k) => roots.has(root(k)));
    // A key the batch names that isn't a configured track has no group; keep it
    // so it still dedups against itself rather than skipping the check.
    for (const k of asked) if (!groupKeys.includes(k)) groupKeys.push(k);

    const seen = new Map([...roots].map((r) => [r, new Set()]));
    const placeholders = groupKeys.map(() => "?").join(", ");
    const [leads, screened] = await Promise.all([
      this.d1
        .prepare(`SELECT search, url FROM leads WHERE user_id = ? AND search IN (${placeholders})`)
        .bind(this.userId, ...groupKeys)
        .all(),
      this.d1
        .prepare(`SELECT search, url FROM screened WHERE user_id = ? AND search IN (${placeholders})`)
        .bind(this.userId, ...groupKeys)
        .all(),
    ]);
    for (const row of [...leads.results, ...screened.results]) {
      seen.get(root(row.search))?.add(canonicalUrl(row.url));
    }

    const fresh = [];
    let duplicates = 0;
    for (const row of rows) {
      const key = canonicalUrl(row.url);
      const set = seen.get(root(row.search));
      if (!key || set?.has(key)) {
        duplicates++;
        continue;
      }
      set?.add(key);
      fresh.push(row);
    }
    return { fresh, duplicates };
  }

  /**
   * Inserts leads not already present for the same (user, search, posting).
   *
   * Two layers. The canonical-URL filter (dropKnownUrls) catches the same
   * posting under a different URL - a `?gh_jid=` suffix, a slug, a tracking
   * param; see ./url.js. `INSERT OR IGNORE` against `UNIQUE(user_id, search,
   * url)` is the race-free backstop for a byte-identical URL.
   *
   * The filter is read-then-write, so it is not race-free. Accepted: a track's
   * leads are written only by its own nightly run, and the constraint still
   * covers an identical URL arriving concurrently.
   *
   * Never touches an existing row's status/notes. Two users tracking the same
   * posting are two separate rows, by design.
   *
   * @param {Array<Partial<Lead>>} leads
   * @param {string} [on] the run's local date, used for `found`/`verified`
   *   when a lead doesn't carry its own
   * @returns {Promise<{added: number, duplicates: number}>} inserted, and how
   *   many were dropped as already-known
   */
  async addLeads(leads, on) {
    // Prefer the caller's local date: the worker only knows UTC, and an evening
    // search is already the next UTC day. The caller validates it (validate.js's
    // isoDate); don't re-validate here, or the rule has two copies.
    const t = on || today();

    const { fresh, duplicates } = await this.dropKnownUrls(leads);
    if (fresh.length === 0) return { added: 0, duplicates };

    const stmt = this.d1.prepare(
      `INSERT OR IGNORE INTO leads
         (user_id, search, found, company, title, location, url, verified, fit, status, notes, ${EXTRA_FIELDS.join(", ")})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', '', ${EXTRA_FIELDS.map(() => "?").join(", ")})`
    );
    const batch = fresh.map((lead) =>
      stmt.bind(
        this.userId,
        lead.search,
        lead.found || t,
        lead.company,
        lead.title,
        lead.location || "",
        lead.url,
        lead.verified || t,
        lead.fit || "",
        ...EXTRA_FIELDS.map((f) => lead[f] || "")
      )
    );
    const results = await this.d1.batch(batch);
    return { added: results.reduce((n, r) => n + (r.meta.changes || 0), 0), duplicates };
  }

  /** @param {number|string} id @returns {Promise<Lead|null>} */
  async getLead(id) {
    return this.d1
      .prepare("SELECT * FROM leads WHERE id = ? AND user_id = ?")
      .bind(id, this.userId)
      .first();
  }

  /**
   * Field-whitelist partial update - only keys present in `patch` (as
   * strings) are changed; everything else is left as-is via COALESCE.
   *
   * `search` is writable so a lead can move between this user's tabs, e.g. when
   * a track is split in two. The caller (routes/update.js's handleUpdate)
   * checks the target track exists and handles the UNIQUE(user_id, search,
   * url) collision; both are policy, not storage.
   * @param {number|string} id
   * @param {Partial<Lead>} patch
   * @returns {Promise<Lead|null>} the updated row, or null if no row matched
   */
  async updateLead(id, patch) {
    const changed = await this.#patchRow("leads", ["status", "notes", "search", ...EXTRA_FIELDS], id, patch);
    return changed ? this.getLead(id) : null;
  }

  /**
   * The field-whitelist partial update behind updateLead and updateApplication.
   * Only keys `patch` carries as strings are written; every other column binds
   * null and `COALESCE(?, col)` keeps it. A non-string value is not a
   * validation error: it means "leave this column", which is what makes a
   * patch partial.
   *
   * Private: `table` and `fields` are interpolated into SQL, which is safe only
   * because both are this file's literals, never a caller's.
   *
   * @param {string} table
   * @param {string[]} fields the writable columns, in any order
   * @param {number|string} id
   * @param {Object} patch
   * @returns {Promise<boolean>} whether a row actually matched and changed
   */
  async #patchRow(table, fields, id, patch) {
    const setClause = fields.map((f) => `${f} = COALESCE(?, ${f})`).join(", ");
    const values = fields.map((f) => (typeof patch[f] === "string" ? patch[f] : null));
    const result = await this.d1
      .prepare(`UPDATE ${table} SET ${setClause} WHERE id = ? AND user_id = ?`)
      .bind(...values, id, this.userId)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Every lead this user tracks, in the columns URL matching and delisting
   * need: `id` and `url` to match on, `status` for the applied-to check, and
   * the company/title/location deleteLeadAndScreen copies onto its screened row.
   *
   * Whole table, not `WHERE url IN (...)`: matching uses canonicalUrl
   * (./url.js), in JS. A raw SQL string match would miss URL variants and
   * leave a dead posting on the board.
   *
   * Not scoped to the caller's track: a multi-tab run treats all its tabs'
   * dedup data as one set, so the postings it re-checks aren't all in the tab
   * it reports under, and narrowing would wrongly report them as unmatched.
   * @returns {Promise<Array<{id: number, search: string, url: string, status: string, company: string, title: string, location: string}>>}
   */
  async getLeadsForUrlMatch() {
    const res = await this.d1
      .prepare(
        `SELECT id, search, url, status, company, title, location
           FROM leads WHERE user_id = ? ORDER BY id`
      )
      .bind(this.userId)
      .all();
    return res.results;
  }

  /**
   * Stamps `verified` on the given leads: the date someone last confirmed the
   * postings were live. A delisted lead is deleted, so for a lead still in a
   * tab this column is the only answer to "how long since anyone looked?".
   *
   * Unconditional, not `MAX(verified, on)`: a date moving backwards costs one
   * extra re-check, whereas refusing it would swallow a correction and claim a
   * confirmation on a day nobody made one. The caller validates `on`.
   * @param {Array<number|string>} ids
   * @param {string} on - YYYY-MM-DD, the run's own local date
   * @returns {Promise<number>} how many rows were actually stamped
   */
  async markVerified(ids, on) {
    if (!ids.length) return 0;
    const chunks = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
    const results = await this.d1.batch(
      chunks.map((chunk) =>
        this.d1
          .prepare(
            `UPDATE leads SET verified = ?
              WHERE user_id = ? AND id IN (${chunk.map(() => "?").join(", ")})`
          )
          .bind(on, this.userId, ...chunk)
      )
    );
    return results.reduce((n, r) => n + (r.meta.changes || 0), 0);
  }

  // -------------------------------------------------------- screened --

  /**
   * Same two-layer dedup as addLeads.
   *
   * A URL already tracked as a lead is dropped too, not just one already
   * screened: the prompt's step 7 sorts each candidate into exactly one of
   * tracked-or-screened, a finding, or a disqualified new one, so a run
   * reporting both is contradicting itself, and the lead is the row to keep.
   *
   * deleteLeadAndScreen doesn't come through here, so a lead being removed
   * still gets its screened row.
   *
   * @param {Array<Partial<ScreenedItem>>} items
   * @param {string} [on] the run's local date, for items without their own
   * @returns {Promise<{added: number, duplicates: number}>}
   */
  async addScreened(items, on) {
    const t = on || today();

    const { fresh, duplicates } = await this.dropKnownUrls(items);
    if (fresh.length === 0) return { added: 0, duplicates };

    const stmt = this.d1.prepare(
      // added_by is always 'run': this path serves POST /api/screened, a
      // search's report. A person's removal goes through deleteLeadAndScreen.
      `INSERT OR IGNORE INTO screened (user_id, search, url, company, title, location, reason, date, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'run')`
    );
    const batch = fresh.map((item) =>
      stmt.bind(
        this.userId,
        item.search,
        item.url,
        item.company || "",
        item.title || "",
        item.location || "",
        item.reason || "",
        item.date || t
      )
    );
    const results = await this.d1.batch(batch);
    return { added: results.reduce((n, r) => n + (r.meta.changes || 0), 0), duplicates };
  }

  /**
   * Forget that postings were ever screened, so a later run can find them again.
   *
   * A screened row tells every future run to skip a url, and dropKnownUrls
   * applies it to leads too, so a wrongly delisted lead can never be
   * rediscovered. This is the undo.
   *
   * The row is deleted, never flagged: a "screened but ignore" state would need
   * every reader to honour it. Deleting restores the prior state exactly - the
   * next run judges the posting on its merits.
   *
   * Matched on canonical url (./url.js): the caller works from a report or a
   * webpage, whose url rarely carries the tracking params it was stored with.
   *
   * Scoped to the whole feed group, because screened rows for one search land
   * under different keys: handleAddScreened files a run's rejections under the
   * feeder, but delistLead writes the row under the lead's own tab. The group
   * is also what dropKnownUrls reads, so every row that hides a posting is
   * removable here.
   *
   * @param {string[]} searches every key in the feed group
   * @param {string[]} urls
   * @returns {Promise<{removed: number, urls: string[], unmatched: string[]}>}
   */
  async unscreenUrls(searches, urls) {
    const keys = Array.isArray(searches) ? searches : [searches];
    if (keys.length === 0) return { removed: 0, urls: [], unmatched: urls.slice() };
    const wanted = new Map(urls.map((u) => [canonicalUrl(u), u]));
    const inKeys = keys.map(() => "?").join(",");
    const rows = await this.d1
      .prepare(`SELECT url FROM screened WHERE user_id = ? AND search IN (${inKeys})`)
      .bind(this.userId, ...keys)
      .all();

    const hits = [];
    for (const row of rows.results) {
      const key = canonicalUrl(row.url);
      if (wanted.has(key)) {
        hits.push(row.url);
        wanted.delete(key);
      }
    }
    // Reported rather than swallowed: a silent 0 for a url never screened here
    // would look the same as a successful undo.
    const unmatched = [...wanted.values()];
    if (hits.length === 0) return { removed: 0, urls: [], unmatched };

    const placeholders = hits.map(() => "?").join(",");
    const res = await this.d1
      .prepare(
        `DELETE FROM screened WHERE user_id = ? AND search IN (${inKeys}) AND url IN (${placeholders})`
      )
      .bind(this.userId, ...keys, ...hits)
      .run();
    return { removed: res.meta.changes || 0, urls: hits, unmatched };
  }

  // ----------------------------------------------------- applications --

  /** @param {number|string} id @returns {Promise<Application|null>} */
  async getApplication(id) {
    return this.d1
      .prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?")
      .bind(id, this.userId)
      .first();
  }

  /** @param {number|string} leadId @returns {Promise<Application|null>} */
  async getApplicationByLeadId(leadId) {
    return this.d1
      .prepare("SELECT * FROM applications WHERE leadId = ? AND user_id = ? LIMIT 1")
      .bind(String(leadId), this.userId)
      .first();
  }

  /**
   * @param {Partial<Application>} fields
   * @returns {Promise<Application>}
   */
  async insertApplication(fields) {
    const result = await this.#applicationInsert(fields).run();
    return this.getApplication(result.meta.last_row_id);
  }

  /**
   * The bound INSERT behind both application-creating paths (APPLICATION_COLS).
   * Returns a statement rather than running it, so it can also join a
   * `batch()`.
   *
   * Private: it interpolates a column list into SQL, which is safe only
   * because that list is this file's constant, never a caller's.
   *
   * @param {Partial<Application>} fields
   * @returns {D1PreparedStatement}
   */
  #applicationInsert(fields) {
    const placeholders = ["?", ...APPLICATION_COLS.map(() => "?")].join(", ");
    return this.d1
      .prepare(
        `INSERT INTO applications (user_id, ${APPLICATION_COLS.join(", ")}) VALUES (${placeholders})`
      )
      .bind(this.userId, ...applicationValues(fields));
  }

  /**
   * Field-whitelist partial update, same #patchRow rule as updateLead.
   * @param {number|string} id
   * @param {Partial<Application>} patch
   * @returns {Promise<Application|null>}
   */
  async updateApplication(id, patch) {
    const fields = ["company", "title", "location", "dateApplied", "status", "notes", "leadId", ...EXTRA_FIELDS, ...APP_STAGE_DATE_FIELDS];
    const changed = await this.#patchRow("applications", fields, id, patch);
    return changed ? this.getApplication(id) : null;
  }

  /** @param {number|string} id @returns {Promise<boolean>} true if a row was actually deleted */
  async deleteApplication(id) {
    const result = await this.d1
      .prepare("DELETE FROM applications WHERE id = ? AND user_id = ?")
      .bind(id, this.userId)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Sets status and, the first time it reaches a stage with a history
   * column, stamps that column with a date - but only if it's still empty,
   * so it never overwrites a date the user corrected by hand.
   * @param {number|string} id
   * @param {string} status
   * @param {string|null} stageDateColumn - one of APP_STAGE_DATE_FIELDS (or dateApplied, for "Applied"), or null if this status has none
   * @param {string|null} clearColumn - a date column to blank instead of stamp - see handleSetApplicationStatus's "To Apply" case
   * @param {string|null} explicitDate - the date the client says this actually happened on (YYYY-MM-DD, already validated by the caller), or null to fall back to today - see handleSetApplicationStatus
   * @returns {Promise<Application|null>}
   */
  async setApplicationStatus(id, status, stageDateColumn, clearColumn = null, explicitDate = null) {
    // Column names here come from routes/applications.js's own constants,
    // never from the request body, so they're safe to interpolate; the values
    // still bind.
    const sets = ["status = ?"];
    const values = [status];
    if (stageDateColumn) {
      sets.push(`${stageDateColumn} = CASE WHEN ${stageDateColumn} = '' THEN ? ELSE ${stageDateColumn} END`);
      values.push(explicitDate || today());
    }
    if (clearColumn) sets.push(`${clearColumn} = ''`);
    const result = await this.d1
      .prepare(`UPDATE applications SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .bind(...values, id, this.userId)
      .run();
    if (result.meta.changes === 0) return null;
    return this.getApplication(id);
  }

  // --------------------------------------------- the overnight fill --

  /**
   * Which applications a nightly run should read, as `{id, link}` only: the
   * result lands in the run's context. Derived from each row's own state;
   * nothing is queued. See migrations/0009_application_autofill.sql.
   *
   * `autofill = ''` limits each row to one read, so an unreadable posting
   * doesn't return nightly. Only a blank company, title or location qualifies
   * a row; blank team, setup or comp don't, since many postings never state
   * them and the gap would never close.
   *
   * @returns {Promise<{id: number, link: string}[]>}
   */
  async getAutofillQueue() {
    const { results } = await this.d1
      .prepare(
        `SELECT id, link FROM applications
          WHERE user_id = ? AND autofill = '' AND link != ''
            AND (company = '' OR title = '' OR location = '')
          ORDER BY id`
      )
      .bind(this.userId)
      .all();
    return results || [];
  }

  /**
   * Writes what a run read off one posting, and marks the row 'filled'.
   *
   * Fills only columns still empty: the person may have typed values in since
   * the queue was fetched, and their typing wins. `AND autofill = ''` makes a
   * row already read, or deleted, match nothing rather than be written twice.
   *
   * Marks the row read even when `fields` has nothing usable, or it would
   * return in every later queue.
   *
   * `fields.note` explains a partial read - some fields found, the rest not -
   * and is shown on the row like a failure's reason.
   *
   * @param {number|string} id
   * @param {Partial<Application>} fields - only AUTOFILL_FILL_FIELDS and `note` are read
   * @returns {Promise<Application|null>} null if the row was already read
   */
  async applyAutofill(id, fields) {
    const note = typeof fields.note === "string" ? fields.note.trim() : "";
    const sets = ["autofill = 'filled'", "autofill_note = ?"];
    const values = [note];
    for (const f of AUTOFILL_FILL_FIELDS) {
      const value = typeof fields[f] === "string" ? fields[f].trim() : "";
      if (!value) continue;
      // Column names come from this file's own constant, never the body.
      sets.push(`${f} = CASE WHEN ${f} = '' THEN ? ELSE ${f} END`);
      values.push(value);
    }
    const result = await this.d1
      .prepare(
        `UPDATE applications SET ${sets.join(", ")}
          WHERE id = ? AND user_id = ? AND autofill = ''`
      )
      .bind(...values, id, this.userId)
      .run();
    if (result.meta.changes === 0) return null;
    return this.getApplication(id);
  }

  /**
   * Clears the read flag on the named rows so the next run reads them again.
   * An operator tool for after the fill's instructions improve, not a retry:
   * it takes explicit ids, has no "everything that failed" mode, and nothing
   * calls it on a schedule or in response to a failure.
   *
   * @param {(number|string)[]} ids
   * @returns {Promise<number>} rows actually cleared
   */
  async requeueAutofill(ids) {
    if (!ids.length) return 0;
    const chunks = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
    const results = await this.d1.batch(
      chunks.map((chunk) =>
        this.d1
          .prepare(
            `UPDATE applications SET autofill = '', autofill_note = ''
              WHERE user_id = ? AND id IN (${chunk.map(() => "?").join(", ")})`
          )
          .bind(this.userId, ...chunk)
      )
    );
    return results.reduce((n, r) => n + (r.meta.changes || 0), 0);
  }

  /**
   * Records that a run opened the link and couldn't read it. Final: a failed
   * read isn't retried (migrations/0009_application_autofill.sql).
   *
   * The note is shown on the row; without it a failed row looks like one not
   * yet read. Stored as the run wrote it.
   *
   * @param {number|string} id
   * @param {string} note - short, human-readable; the person reads this
   * @returns {Promise<Application|null>} null if the row was already read
   */
  async failAutofill(id, note) {
    const result = await this.d1
      .prepare(
        `UPDATE applications SET autofill = 'failed', autofill_note = ?
          WHERE id = ? AND user_id = ? AND autofill = ''`
      )
      .bind(note, id, this.userId)
      .run();
    if (result.meta.changes === 0) return null;
    return this.getApplication(id);
  }

  // ------------------------------------------------------- composite --

  /**
   * Sets a lead's status and optionally inserts an application, in one D1
   * batch (transaction), so a lead can't end up "Applied" with no application
   * after a partial failure. Whether to create one is the caller's decision.
   * @param {number|string} id
   * @param {string} status
   * @param {Partial<Application>|null} newApplicationFields - pass an object to also create an application in the same transaction, or null to just set the status
   * @returns {Promise<{lead: Lead|null, application: Application|null}>}
   */
  async setLeadStatusAndMaybeCreateApplication(id, status, newApplicationFields) {
    const batch = [
      this.d1
        .prepare("UPDATE leads SET status = ? WHERE id = ? AND user_id = ?")
        .bind(status, id, this.userId),
    ];
    if (newApplicationFields) batch.push(this.#applicationInsert(newApplicationFields));
    const results = await this.d1.batch(batch);

    const lead = await this.getLead(id);
    let application = null;
    if (newApplicationFields) {
      application = await this.getApplication(results[1].meta.last_row_id);
    }
    return { lead, application };
  }

  /**
   * Deletes a lead and records its URL in `screened`, in one D1 batch
   * (transaction). The callers decide when: routes/delisting.js's delistLead
   * and routes/leads.js's handleDeleteLeads.
   *
   * Both halves land together: the delete alone lets tomorrow's run re-add the
   * URL as a new lead, and the screened row alone hides a lead still in its tab.
   *
   * INSERT OR IGNORE because (user, search, url) is unique and a re-reported
   * posting is a no-op. The screened row carries company/title/location
   * because it is all that remains of the lead.
   *
   * Never pass a lead an application points at: deleting it would strand that
   * row. Both callers check for an application row first, not just for status
   * "Applied".
   * @param {Lead} lead - the already-fetched row, so this doesn't re-read it
   * @param {string} reason - short human-readable note stored on the screened row
   * @param {string|null} date - YYYY-MM-DD the posting was confirmed dead (the run's own local date), or null for today
   * @param {'run'|'hand'} addedBy - 'run' for a search reporting a posting gone,
   *   'hand' for a person clearing it off their board. Required, not defaulted:
   *   countRunActivity counts only 'run' (migrations/0007_screened_added_by.sql).
   * @returns {Promise<boolean>} true if the lead row was actually deleted
   */
  async deleteLeadAndScreen(lead, reason, date, addedBy) {
    // Throw rather than default: a fallback would misattribute the rows. Only
    // a programming error reaches this, never request input.
    if (addedBy !== "run" && addedBy !== "hand") {
      throw new Error(`deleteLeadAndScreen: addedBy must be 'run' or 'hand', got ${JSON.stringify(addedBy)}`);
    }
    const results = await this.d1.batch([
      this.d1
        .prepare(
          `INSERT OR IGNORE INTO screened (user_id, search, url, company, title, location, reason, date, added_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          this.userId,
          lead.search,
          lead.url,
          lead.company || "",
          lead.title || "",
          lead.location || "",
          reason,
          date || today(),
          addedBy
        ),
      this.d1
        .prepare("DELETE FROM leads WHERE id = ? AND user_id = ?")
        .bind(lead.id, this.userId),
    ]);
    return (results[1].meta.changes || 0) > 0;
  }
}
