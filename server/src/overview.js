/**
 * What the admin Overview's numbers mean.
 *
 * The rules live here and the storage lives in ./deployment-db.js, because
 * they change for different reasons: "a search is running when nobody paused
 * it and it has been written up" is a product decision, and which table holds
 * `paused_since` is not. Written as functions over rows, so the definitions
 * can be read without stepping over SQL, and so a rule can be checked by
 * calling it rather than by standing up a database.
 *
 * Nothing here reaches D1.
 */

import { retryCutoff } from "./onboarding.js";
import { dateDaysAgo, SCREENED_BY_RULES } from "./validate.js";

/** How far back every "7 days" number counts. */
export const WINDOW_DAYS = 7;

/**
 * Demo accounts are left out of every number, not only the count of people.
 *
 * Their rows are invented by definition (docs/glossary.md#accounts), so
 * counting their leads would answer "is this serving anyone" with data about
 * nobody. The flag exists so the server can tell them apart.
 */
const EXCLUDE_DEMO = { excludeDemo: true };

/**
 * A search is running when nobody has paused it and it has been written up.
 *
 * Both halves matter. A paused search is silent on purpose, and one never
 * written up has no instructions to run, so counting either as a fault fills
 * the page with rows an operator can do nothing about.
 *
 * @param {{paused_since: string, role_search_line: string}} search
 */
export function isRunning(search) {
  // `role_search_line` is what "written up" means; db.js's WRITTEN_UP says the
  // same thing in SQL, for the queries that have to ask the database.
  return search.paused_since === "" && (search.role_search_line || "") !== "";
}

/**
 * The night every "last night" number is about: the newest day any run
 * recorded, or "" when nothing ever has.
 *
 * Taken from the runs rather than from a clock. A run stamps its own local
 * day, so a date derived from the worker's UTC clock would call a night missed
 * for everyone west of it for part of each day. Taking it from the newest run
 * makes the word mean the same thing to whoever is reading - the rule the
 * tracker page already follows for its own windows.
 *
 * @param {Array<{last_run_on: string|null}>} searches
 */
export function lastNight(searches) {
  return searches.reduce((day, s) => ((s.last_run_on || "") > day ? s.last_run_on : day), "");
}

/**
 * Which of the three quiet states a running search is in, or "ran".
 *
 * They are counted apart because only one is a fault, and a page that merges
 * them teaches an operator to stop looking.
 *
 * `never_run` is named for what the server knows rather than for what it
 * suspects. A search with no run recorded usually has no scheduled task, which
 * no browser can create - `setup-scheduler.ps1` runs on the machine that runs
 * the searches - but it looks exactly the same as one registered this
 * afternoon whose first night hasn't come. Calling it "no task" would state
 * the likely cause as a fact.
 *
 * `reported_nothing` is the fault: this search has run before, so it has a
 * task and instructions, and last night it didn't.
 *
 * @param {{last_run_on: string|null}} search
 * @param {string} night
 * @returns {'ran'|'reported_nothing'|'never_run'}
 */
export function nightState(search, night) {
  if (!search.last_run_on) return "never_run";
  if (night && search.last_run_on === night) return "ran";
  return "reported_nothing";
}

/**
 * Everything the Overview shows, from one moment's reads.
 *
 * Grouped as the screen asks its two questions - is the system running, and is
 * it serving anyone - plus what there is. Counted here rather than summed by
 * the page from rows it happens to hold: the page holds a window, and a number
 * summed from a window is a different number wearing the same label.
 *
 * **It describes what was reported and cannot see what wasn't.** The pair it
 * cannot separate both land in `reported_nothing`: a run that started and died
 * before recording - the machine asleep, the CLI unauthenticated, the
 * write-back refused - and a task that never fired at all. Either way the
 * server heard nothing, and the row looks the same. That is the fork where an
 * operator's next step changes, and the logs are what decide it, so the page
 * points at `run-report.ps1` rather than guessing.
 *
 * @param {import("./deployment-db.js").DeploymentDb} store
 */
export async function overview(store) {
  const since = dateDaysAgo(WINDOW_DAYS);

  const [searches, leads, leadsBySearch, screened, applications, people, invites, companies, intake] =
    await Promise.all([
      store.searchesWithLastRun(EXCLUDE_DEMO),
      store.leadCountSince(since, EXCLUDE_DEMO),
      store.leadCountsBySearchSince(since, EXCLUDE_DEMO),
      store.screenedCountSince(since, SCREENED_BY_RULES, EXCLUDE_DEMO),
      store.applicationActivitySince(since, EXCLUDE_DEMO),
      store.accountCount(EXCLUDE_DEMO),
      store.openInviteCount(new Date().toISOString()),
      store.companyCount(),
      store.intakeTrouble(retryCutoff(Date.now()), EXCLUDE_DEMO),
    ]);

  const night = lastNight(searches);
  const running = searches.filter(isRunning);
  const inState = (state) => running.filter((s) => nightState(s, night) === state).length;

  // Keyed on both, because a track key is only unique within an account.
  const found = new Set(leadsBySearch.map((r) => `${r.user_id}\u0000${r.search}`));

  return {
    night,
    running: {
      ran_last_night: inState("ran"),
      reported_nothing: inState("reported_nothing"),
      never_run: inState("never_run"),
      setups_waiting: intake.failed + intake.stuck,
    },
    serving: {
      leads_last_night: night
        ? searches.reduce((n, s) => n + (s.last_run_on === night ? Number(s.leads_added || 0) : 0), 0)
        : 0,
      leads_7d: leads,
      // Not broken, and not nothing: a search finding nothing for a week is a
      // conversation about someone's scope or rules.
      searches_finding_nothing_7d: running.filter(
        (s) => !found.has(`${s.user_id}\u0000${s.key}`)
      ).length,
      screened_by_rules_7d: screened,
      applications_moved_7d: applications.moved,
      applications_made_7d: applications.made,
    },
    standing: {
      people,
      searches_running: running.length,
      searches_paused: searches.filter((s) => s.paused_since !== "").length,
      invites_outstanding: invites,
      companies,
    },
  };
}
