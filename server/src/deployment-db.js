/**
 * D1 access for the deployment as a whole, rather than for one person's rows.
 *
 * The pair says the distinction: `Db` (./db.js) is bound to a user id and
 * every statement filters on it, so a handler holding one cannot see anyone
 * else's rows. Nothing here has a user to bind, because the questions are
 * about every account at once. That is why these queries live in their own
 * class instead of on `Db` - a `Db` built without a user matches nothing or
 * everything depending on the statement, and tells you which only in
 * production. `CompanyList` (./companies.js) is outside `Db` for the mirror
 * reason: its rows belong to no user.
 *
 * Only admin routes are handed one, and it reads and never writes.
 *
 * **It answers storage questions and nothing else.** No method here knows what
 * a page shows, which numbers belong together, or what makes a search worth
 * counting - those are rules, and they live in ./overview.js. What a caller
 * gets back is rows and totals. Where a rule has to reach the SQL to avoid
 * dragging a table into memory, it arrives as an argument, so the decision
 * stays the caller's and only the mechanism is here.
 */

/** @typedef {{user_id: string, key: string, paused_since: string, role_search_line: string, last_run_on: string|null, leads_added: number|null}} SearchRow */

export class DeploymentDb {
  /** @param {D1Database} d1 */
  constructor(d1) {
    this.d1 = d1;
  }

  /** `u.demo = 0` or nothing, as the caller asked. */
  #realOnly(excludeDemo) {
    return excludeDemo ? "u.demo = 0" : "1 = 1";
  }

  /**
   * Every search on the deployment with its last recorded run beside it.
   *
   * LEFT JOIN, because a search that has never run has no `search_runs` row at
   * all - `last_run_on` comes back null, and that absence is a real answer
   * rather than a gap. Whether it means anything is the caller's to decide.
   *
   * The paused stamp and the roles line are returned raw rather than folded
   * into a flag: what makes a search worth counting is a rule, not a column.
   *
   * @param {{excludeDemo?: boolean}} [opts]
   * @returns {Promise<SearchRow[]>}
   */
  async searchesWithLastRun({ excludeDemo = false } = {}) {
    const res = await this.d1
      .prepare(
        `SELECT t.user_id, t.key, t.paused_since, t.role_search_line,
                r.last_run_on AS last_run_on, r.leads_added AS leads_added
           FROM tracks t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN search_runs r ON r.user_id = t.user_id AND r.track_key = t.key
          WHERE ${this.#realOnly(excludeDemo)}`
      )
      .all();
    return res.results;
  }

  /**
   * How many leads were found on or after `since`.
   * @param {string} since YYYY-MM-DD
   * @param {{excludeDemo?: boolean}} [opts]
   * @returns {Promise<number>}
   */
  async leadCountSince(since, { excludeDemo = false } = {}) {
    const res = await this.d1
      .prepare(`SELECT COUNT(*) AS n FROM leads l JOIN users u ON u.id = l.user_id
                 WHERE ${this.#realOnly(excludeDemo)} AND l.found >= ?`)
      .bind(since)
      .all();
    return Number(res.results[0]?.n || 0);
  }

  /**
   * Which searches found anything on or after `since`, and how many. A search
   * with none is absent rather than zero - it has no rows to group.
   * @param {string} since YYYY-MM-DD
   * @param {{excludeDemo?: boolean}} [opts]
   * @returns {Promise<Array<{user_id: string, search: string, n: number}>>}
   */
  async leadCountsBySearchSince(since, { excludeDemo = false } = {}) {
    const res = await this.d1
      .prepare(`SELECT l.user_id, l.search, COUNT(*) AS n FROM leads l JOIN users u ON u.id = l.user_id
                 WHERE ${this.#realOnly(excludeDemo)} AND l.found >= ? GROUP BY l.user_id, l.search`)
      .bind(since)
      .all();
    return res.results;
  }

  /**
   * How many screened rows since `since` carry one of `kinds`.
   *
   * The kinds are the caller's - which rejections count as somebody's own
   * settings at work is a rule (validate.js SCREENED_BY_RULES), not a fact
   * about the table. Passed in so the SQL can filter rather than this handing
   * back every screened row on the deployment.
   * @param {string} since YYYY-MM-DD
   * @param {string[]} kinds
   * @param {{excludeDemo?: boolean}} [opts]
   * @returns {Promise<number>}
   */
  async screenedCountSince(since, kinds, { excludeDemo = false } = {}) {
    if (!kinds.length) return 0;
    const holes = kinds.map(() => "?").join(", ");
    const res = await this.d1
      .prepare(`SELECT COUNT(*) AS n FROM screened s JOIN users u ON u.id = s.user_id
                 WHERE ${this.#realOnly(excludeDemo)} AND s.date >= ? AND s.kind IN (${holes})`)
      .bind(since, ...kinds)
      .all();
    return Number(res.results[0]?.n || 0);
  }

  /**
   * Applications made since `since`, and applications whose stage moved since
   * then - any stage date inside the window, which is what a stage change
   * stamps (routes/applications.js STAGE_DATE_MAP).
   * @param {string} since YYYY-MM-DD
   * @param {{excludeDemo?: boolean}} [opts]
   * @returns {Promise<{made: number, moved: number}>}
   */
  async applicationActivitySince(since, { excludeDemo = false } = {}) {
    const res = await this.d1
      .prepare(
        `SELECT
           SUM(CASE WHEN MAX(a.dateApplied, a.dateRecruiterScreen, a.dateTechScreen,
                             a.dateOnsite, a.dateOffer, a.dateRejected, a.dateWithdrawn) >= ?
                    THEN 1 ELSE 0 END) AS moved,
           SUM(CASE WHEN a.dateApplied >= ? THEN 1 ELSE 0 END) AS made
         FROM applications a JOIN users u ON u.id = a.user_id
        WHERE ${this.#realOnly(excludeDemo)}`
      )
      .bind(since, since)
      .all();
    const row = res.results[0] || {};
    return { moved: Number(row.moved || 0), made: Number(row.made || 0) };
  }

  /**
   * How many accounts there are.
   * @param {{excludeDemo?: boolean}} [opts]
   * @returns {Promise<number>}
   */
  async accountCount({ excludeDemo = false } = {}) {
    const res = await this.d1
      .prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${this.#realOnly(excludeDemo)}`)
      .all();
    return Number(res.results[0]?.n || 0);
  }

  /**
   * Invites not used, not revoked, and not expired as of `now`.
   * @param {string} now ISO 8601 instant
   * @returns {Promise<number>}
   */
  async openInviteCount(now) {
    const res = await this.d1
      .prepare(`SELECT COUNT(*) AS n FROM invites
                 WHERE used_at = '' AND revoked_at = '' AND expires_at > ?`)
      .bind(now)
      .all();
    return Number(res.results[0]?.n || 0);
  }

  /** Rows on the company list every account shares. @returns {Promise<number>} */
  async companyCount() {
    const res = await this.d1.prepare("SELECT COUNT(*) AS n FROM company_fetch").all();
    return Number(res.results[0]?.n || 0);
  }

  /**
   * Setups that failed, and setups still pending though sent on or before
   * `retriedBefore`. The cutoff is the caller's: how long a setup keeps being
   * retried is a rule (onboarding.js), not a property of the table.
   * @param {string} retriedBefore ISO 8601 instant
   * @param {{excludeDemo?: boolean}} [opts]
   * @returns {Promise<{failed: number, stuck: number}>}
   */
  async intakeTrouble(retriedBefore, { excludeDemo = false } = {}) {
    const res = await this.d1
      .prepare(
        `SELECT
           SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN i.status = 'pending' AND i.sent_at <= ? THEN 1 ELSE 0 END) AS stuck
         FROM intake i JOIN users u ON u.id = i.user_id
        WHERE ${this.#realOnly(excludeDemo)}`
      )
      .bind(retriedBefore)
      .all();
    const row = res.results[0] || {};
    return { failed: Number(row.failed || 0), stuck: Number(row.stuck || 0) };
  }
}
