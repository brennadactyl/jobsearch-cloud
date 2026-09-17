/**
 * The company list every search draws from, and what is known about reaching
 * each company: one table, company_fetch, shared by every account
 * (docs/glossary.md#companies-and-the-rotation).
 *
 * Kept out of Db on purpose. Db is bound to one user and every statement in it
 * filters on that user; nothing here does, because no row here belongs to
 * anyone. A reader can trust that anything reached through a Db is the
 * caller's own, and that anything reached through a CompanyList is shared.
 *
 * What one search did with each company - when it last tried, what it noted,
 * where its cursor is - is that search's own, and stays on Db
 * (getCoverage, recordSweeps, getSweepCursor, setSweepCursor). The one
 * exception is cleanUpCompanies, an operator's merge, which has to carry every
 * search's record of a company across with it.
 *
 * addCompanies and upsertCompanyFetch change what every account's searches are
 * served, so a caller refuses a demo account before either write, as
 * routes/coverage.js does (demo account, docs/glossary.md#accounts): a demo's
 * companies are invented.
 */

import { ID_CHUNK } from "./db.js";
import { namedKeys, planCleanup } from "./company-cleanup.js";
import { normalize as normalizeCompany } from "./exclude.js";
import { dateDaysAgo, today } from "./validate.js";

export class CompanyList {
  /** @param {D1Database} d1 */
  constructor(d1) {
    this.d1 = d1;
  }

  /**
   * Shared facts for a set of company names, keyed by normalize().
   *
   * Not user-scoped, by design: the caller supplies names and gets back facts
   * about websites, nothing derived from any user's rows. See
   * docs/glossary.md#companies-and-the-rotation.
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
    const wallFreshFrom = dateDaysAgo(WALL_SERVED_DAYS);
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
   * Merge duplicate companies and rename acquired ones, as ../company-cleanup.js
   * plans it, in one transaction.
   *
   * The one method here that reads and writes company_sweeps, which is every
   * search's own record: a merge has to move each search's record of the
   * absorbed company onto the kept one, across every account, or those searches
   * would lose when they last tried it. The route is ADMIN_TOKEN only.
   *
   * Positions are left as they are. A kept company keeps its place, an absorbed
   * one leaves a gap, and gaps are ordinary (Db.setSweepCursor): a cursor reads
   * "the first position at or after me", so no search skips or repeats a
   * stretch of the list.
   *
   * @param {Object} body see planCleanup
   * @param {boolean} dryRun plan and report, write nothing
   * @returns {Promise<{error: string, status: number} | {changes: import("./company-cleanup.js").Change[]}>}
   */
  async cleanUpCompanies(body, dryRun) {
    const keys = [...new Set(namedKeys(body))];
    const inList = (col) => `${col} IN (${keys.map(() => "?").join(",")})`;
    const [fetched, swept] = keys.length
      ? await this.d1.batch([
          this.d1.prepare(`SELECT * FROM company_fetch WHERE ${inList("company_key")}`).bind(...keys),
          this.d1
            .prepare(`SELECT user_id, search, company_key, last_swept, note FROM company_sweeps WHERE ${inList("company_key")}`)
            .bind(...keys),
        ])
      : [{ results: [] }, { results: [] }];
    const plan = planCleanup(body, fetched.results, swept.results);
    if ("error" in plan || dryRun) return plan;

    const statements = [];
    for (const c of plan.changes) {
      const old = [c.from_key, ...c.absorbed_keys];
      const placeholders = old.map(() => "?").join(",");
      statements.push(
        this.d1.prepare(`DELETE FROM company_sweeps WHERE company_key IN (${placeholders})`).bind(...old)
      );
      if (c.absorbed_keys.length) {
        statements.push(
          this.d1
            .prepare(`DELETE FROM company_fetch WHERE company_key IN (${c.absorbed_keys.map(() => "?").join(",")})`)
            .bind(...c.absorbed_keys)
        );
      }
      const r = c.row;
      statements.push(
        this.d1
          .prepare(
            `UPDATE company_fetch
                SET company_key = ?, display_name = ?, board = ?, endpoint = ?, url_shape = ?, dead_signal = ?,
                    note = ?, verified_on = ?, wall = ?, wall_first_on = ?, wall_last_on = ?, wall_dates = ?
              WHERE company_key = ?`
          )
          .bind(
            r.company_key, r.display_name, r.board, r.endpoint, r.url_shape, r.dead_signal,
            r.note, r.verified_on, r.wall, r.wall_first_on, r.wall_last_on, r.wall_dates,
            c.from_key
          )
      );
      for (const s of c.sweeps) {
        statements.push(
          this.d1
            .prepare(
              "INSERT INTO company_sweeps (user_id, search, company_key, last_swept, note) VALUES (?, ?, ?, ?, ?)"
            )
            .bind(s.user_id, s.search, s.company_key, s.last_swept, s.note)
        );
      }
    }
    await this.d1.batch(statements);
    return plan;
  }
}
