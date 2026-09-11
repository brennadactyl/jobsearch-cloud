/**
 * Checks the migrations that reshape existing rows - 0002_multi_user.sql,
 * 0011_one_company_list.sql and 0012_demo_account.sql - against a database
 * that already has data.
 *
 *   node verify-migration.mjs
 *
 * A migration runs once, against real data, and cannot be undone.
 * `verify-local.mjs` always starts from an empty database, so it cannot see a
 * migration lose a column, drop rows, reset AUTOINCREMENT, or leave data owned
 * by a user that doesn't exist.
 *
 * Runs entirely in-process against a throwaway `node:sqlite` database - no
 * wrangler, no dev worker, nothing to clean up, and it never touches D1.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const OWNER = "ab266b6c-00cc-45d1-92ac-cdad412c1558";
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " -- " + detail : ""}`); }
};

// D1 applies a migration file statement by statement; node:sqlite's exec()
// runs the whole script, which is close enough for what's being checked here.
const sql = (f) => readFileSync(new URL(`./migrations/${f}`, import.meta.url), "utf8");

function migrated(seed) {
  const db = new DatabaseSync(":memory:");
  db.exec(sql("0001_schema.sql"));
  if (seed) db.exec(seed);
  db.exec(sql("0002_multi_user.sql"));
  return db;
}

const SEED = `
INSERT INTO leads (id, search, found, company, title, location, url, verified, fit, status, notes, delistedOn, team, setup, source, link, lastContact, nextAction, nextActionDate, resume, referral, comp)
VALUES (7, 'SWE', '2026-08-01', 'Acme', 'Senior Backend', 'Bellevue, WA', 'https://example.com/a', '2026-08-30', 'strong', 'Applied', 'my note', '', 'Platform', 'Hybrid', '', '', '', '', '', '', 'a referral', '$1');
INSERT INTO leads (id, search, found, company, title, location, url, verified, fit, status, notes, delistedOn, team, setup, source, link, lastContact, nextAction, nextActionDate, resume, referral, comp)
VALUES (42, 'TPM', '2026-08-02', 'Globex', 'TPM', 'Remote (U.S.)', 'https://example.com/b', '2026-08-30', '', 'New', '', '2026-08-29', '', '', '', '', '', '', '', '', '', '');
INSERT INTO applications (id, leadId, company, title, dateApplied, status, notes, team, setup, source, link, lastContact, nextAction, nextActionDate, resume, referral, comp, dateRecruiterScreen, dateTechScreen, dateOnsite, dateOffer, dateRejected, dateWithdrawn)
VALUES (3, '7', 'Acme', 'Senior Backend', '2026-08-15', 'Recruiter Screen', '', '', '', '', '', '', '', '', '', '', '', '2026-08-20', '', '', '', '', '');
INSERT INTO screened (id, search, url, company, title, location, reason, date) VALUES (9, 'SWE', 'https://example.com/dead', 'Initech', 'SDE II', 'London, UK', 'outside the US', '2026-08-29');
INSERT INTO tracks (key, label, full_description, sort_order) VALUES ('SWE', 'Engineering', 'Senior / Staff SWE', 0);
INSERT INTO tracks (key, label, full_description, sort_order) VALUES ('TPM', 'Technical PM', 'Senior+ TPM', 1);
INSERT INTO search_runs (track_key, last_run_at, last_run_on, status, leads_added, screened_added, delisted, note)
VALUES ('SWE', '2026-08-30T15:15:31.422Z', '2026-08-30', 'ok', 3, 23, 0, '3 new leads');
INSERT INTO search_runs (track_key) VALUES ('TPM');
INSERT INTO meta (key, value) VALUES ('updated', '2026-08-30');
INSERT INTO meta (key, value) VALUES ('display_title', 'A Job Search');
INSERT INTO meta (key, value) VALUES ('priority_locations', '[{"tier":"p-high","label":"Seattle area","anyOf":["seattle"]}]');
`;

console.log("\n== against a database with data ==");
{
  const db = migrated(SEED);
  const all = (q) => db.prepare(q).all();
  const one = (q) => db.prepare(q).get();

  check("exactly one account exists, and owns everything",
    one("SELECT COUNT(*) c FROM users").c === 1 && one("SELECT id FROM users").id === OWNER);
  check("login starts disabled on it (nothing can hash a password in SQL)",
    one("SELECT password_hash h FROM users").h === "");

  for (const t of ["leads", "applications", "screened", "tracks", "search_runs", "meta"]) {
    check(`${t}: every row is owned`, one(`SELECT COUNT(*) c FROM ${t} WHERE user_id != '${OWNER}'`).c === 0);
  }
  check("no row count changed",
    one("SELECT COUNT(*) c FROM leads").c === 2 && one("SELECT COUNT(*) c FROM applications").c === 1
    && one("SELECT COUNT(*) c FROM screened").c === 1 && one("SELECT COUNT(*) c FROM tracks").c === 2
    && one("SELECT COUNT(*) c FROM search_runs").c === 2 && one("SELECT COUNT(*) c FROM meta").c === 3);

  const lead = one("SELECT * FROM leads WHERE id = 7");
  check("lead ids are preserved", !!lead && !!one("SELECT id FROM leads WHERE id = 42"));
  check("every lead column survived the rebuild",
    lead.status === "Applied" && lead.notes === "my note" && lead.referral === "a referral"
    && lead.comp === "$1" && lead.team === "Platform" && lead.fit === "strong",
    JSON.stringify(lead));
  // 0004 drops leads.delistedOn. migrated() applies only 0001 and 0002, so
  // this checks that 0002's table rebuild kept a column that existed then.
  check("delistedOn survived", one("SELECT delistedOn d FROM leads WHERE id = 42").d === "2026-08-29");
  check("application stage dates survived",
    one("SELECT dateRecruiterScreen d FROM applications WHERE id = 3").d === "2026-08-20");
  check("the application still points at its lead",
    one("SELECT leadId l FROM applications WHERE id = 3").l === "7");
  check("run history survived",
    one("SELECT leads_added n FROM search_runs WHERE track_key = 'SWE'").n === 3);
  check("settings survived",
    one("SELECT value v FROM meta WHERE key = 'display_title'").v === "A Job Search");

  // If AUTOINCREMENT didn't follow the rename, the next insert reuses an id
  // that already belongs to a row, and the UNIQUE constraint hides it as a
  // silent no-op rather than an error.
  db.exec(`INSERT INTO leads (user_id, search, found, company, title, url, verified) VALUES ('${OWNER}', 'SWE', '2026-09-01', 'New Co', 'Eng', 'https://example.com/new', '2026-09-01')`);
  check("AUTOINCREMENT continues past the highest existing id",
    one("SELECT MAX(id) m FROM leads").m === 43, JSON.stringify(one("SELECT MAX(id) m FROM leads")));

  check("the new per-user uniqueness holds within one user", (() => {
    try {
      db.exec(`INSERT INTO leads (user_id, search, found, company, title, url, verified) VALUES ('${OWNER}', 'SWE', '2026-09-01', 'Acme', 'Senior Backend', 'https://example.com/a', '2026-09-01')`);
      return false;
    } catch { return true; }
  })());
  check("...and lets a second user hold the same (search, url)", (() => {
    db.exec("INSERT INTO users (id, name) VALUES ('other-user', 'Someone Else')");
    db.exec(`INSERT INTO leads (user_id, search, found, company, title, url, verified) VALUES ('other-user', 'SWE', '2026-09-01', 'Acme', 'Senior Backend', 'https://example.com/a', '2026-09-01')`);
    return db.prepare("SELECT COUNT(*) c FROM leads WHERE url = 'https://example.com/a'").get().c === 2;
  })());
  check("two users can hold the same track key", (() => {
    db.exec("INSERT INTO tracks (user_id, key, label) VALUES ('other-user', 'SWE', 'Their Engineering')");
    return db.prepare("SELECT COUNT(*) c FROM tracks WHERE key = 'SWE'").get().c === 2;
  })());
  check("names are case-insensitively unique", (() => {
    try { db.exec("INSERT INTO users (id, name) VALUES ('dupe', 'someone else')"); return false; }
    catch { return true; }
  })());
  check("no scaffolding tables are left behind",
    all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_new'").length === 0);
  db.close();
}

console.log("\n== against an empty database ==");
{
  const db = migrated(null);
  check("no account is invented for a fresh install",
    db.prepare("SELECT COUNT(*) c FROM users").get().c === 0);
  check("every table is there and empty",
    ["leads", "applications", "screened", "tracks", "search_runs", "meta", "sessions"]
      .every((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c === 0));
  check("the new columns exist",
    db.prepare("SELECT COUNT(*) c FROM pragma_table_info('tracks') WHERE name IN ('user_id','role_search_line','resume_line','fit_filter_step','leads_note','doc_update_line','schedule_time')").get().c === 7);
  db.close();
}

console.log("\n== against a database holding only screened rows ==");
{
  // The owner backfill is conditional on there being data, so a database whose
  // only rows are in one of the less common tables must still get an owner.
  const db = migrated("INSERT INTO screened (search, url, date) VALUES ('SWE', 'https://example.com/x', '2026-08-29');");
  check("an owner is still created for it",
    db.prepare("SELECT COUNT(*) c FROM users").get().c === 1);
  db.close();
}

// ---- 0011_one_company_list.sql -------------------------------------------
//
// 0011 merges every rotation into one list held in company_fetch, keys
// company_sweeps by normalize(), and reshuffles positions over the merged list.
// Three things only a database that already has rows can show: that the SQL
// spelling of normalize() agrees with the JavaScript one, that a merge keeps
// every fact and every row it should, and that the previous worker still reads
// the schema this leaves behind.
const { readdirSync } = await import("node:fs");
const { normalize } = await import("./src/exclude.js");
const MIGRATIONS = readdirSync(new URL("./migrations/", import.meta.url))
  .filter((f) => f.endsWith(".sql")).sort();

// Every migration before `stop`, then the seed, then `stop` itself. The seed is
// SQL text or a function given the open database, for rows a literal cannot
// hold (control characters).
function migratedThrough(stop, seed) {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS.filter((f) => f < stop)) db.exec(sql(f));
  if (typeof seed === "function") seed(db);
  else if (seed) db.exec(seed);
  db.exec(sql(stop));
  return db;
}
const STOP = MIGRATIONS.find((f) => f.startsWith("0011_"));

console.log("\n== 0011 against a database with rotations ==");
{
  const U1 = "user-one", U2 = "user-two";
  const db = migratedThrough(STOP, `
INSERT INTO users (id, name) VALUES ('${U1}', 'One'), ('${U2}', 'Two');
INSERT INTO tracks (user_id, key, label, sweep_cursor) VALUES
  ('${U1}', 'SWE', 'SWE', 7), ('${U1}', 'CPM', 'CPM', 3), ('${U2}', 'product', 'Product', 5);
INSERT INTO company_sweeps (user_id, search, company, last_swept, board, note, position) VALUES
  ('${U1}', 'SWE', 'Cursor (Anysphere)', '2026-09-01', 'ashby', 'the older spelling', 4),
  ('${U1}', 'SWE', 'Cursor Anysphere',   '2026-09-05', '',      'the newer spelling', 9),
  ('${U1}', 'SWE', 'Acme',               '2026-09-02', 'greenhouse', 'swe acme', 0),
  ('${U1}', 'SWE', 'C.H. Robinson',      '',           'workday cxs', '', 1),
  ('${U1}', 'CPM', 'Acme',               '2026-09-03', '', 'cpm acme', 2),
  ('${U1}', 'CPM', 'Rocket Companies (formerly Redfin)', '2026-09-04', '', '', 0),
  ('${U2}', 'product', 'acme',           '2026-09-06', '', 'two acme', 1),
  ('${U2}', 'product', 'T-Mobile',       '',           '', '', 0),
  ('${U2}', 'product', 'Retracted Co',   '',           'lever', '', 2);
INSERT INTO company_fetch (company_key, display_name, board, endpoint, verified_on, retracted_on, retracted_note) VALUES
  ('acme', 'Acme', 'lever', 'jobs.lever.co/acme', '2026-09-08', '', ''),
  ('retracted co', 'Retracted Co', 'withdrawn-board', '', '2026-09-01', '2026-09-09', 'was wrong');
`);
  const all = (q, ...a) => db.prepare(q).all(...a);
  const one = (q, ...a) => db.prepare(q).get(...a);

  const sweeps = all("SELECT * FROM company_sweeps");
  check("no rotation row is lost", sweeps.length === 9, String(sweeps.length));
  check("every rotation row is keyed by normalize(company)",
    sweeps.every((r) => r.company_key === normalize(r.company)),
    JSON.stringify(sweeps.filter((r) => r.company_key !== normalize(r.company)).map((r) => [r.company, r.company_key])));
  check("last_swept and note survive untouched on every row",
    one("SELECT last_swept l, note n FROM company_sweeps WHERE user_id=? AND search='SWE' AND company='Cursor Anysphere'", U1).n === "the newer spelling"
    && one("SELECT last_swept l FROM company_sweeps WHERE user_id=? AND search='product' AND company='acme'", U2).l === "2026-09-06");

  const fetchRows = all("SELECT * FROM company_fetch ORDER BY company_key");
  const keys = fetchRows.map((r) => r.company_key);
  check("every company in any rotation is on the one list, exactly once",
    JSON.stringify(keys) === JSON.stringify(["acme", "c h robinson", "cursor anysphere", "retracted co", "rocket companies formerly redfin", "t mobile"]),
    JSON.stringify(keys));
  const row = (k) => fetchRows.find((r) => r.company_key === k);
  check("two spellings of one company merge into one row",
    row("cursor anysphere") && row("cursor anysphere").display_name === "Cursor (Anysphere)",
    JSON.stringify(row("cursor anysphere")));
  check("a board a run swept with is carried onto the list",
    row("cursor anysphere").board === "ashby", JSON.stringify(row("cursor anysphere")));
  check("but a board on a company nobody has swept is not - a typed list is not evidence",
    row("c h robinson").board === "", JSON.stringify(row("c h robinson")));
  check("a board already on the list is never overwritten by a rotation's",
    row("acme").board === "lever", row("acme").board);
  check("the facts already on the list survive the merge",
    row("acme").endpoint === "jobs.lever.co/acme" && row("acme").verified_on === "2026-09-08");
  check("a retracted row is left exactly as it was",
    row("retracted co").board === "withdrawn-board" && row("retracted co").retracted_on === "2026-09-09",
    JSON.stringify(row("retracted co")));

  const positions = fetchRows.map((r) => r.position).sort((a, b) => a - b);
  check("positions over the merged list are a dense permutation - no two companies share a place",
    JSON.stringify(positions) === JSON.stringify(positions.map((_, i) => i)),
    JSON.stringify(positions));
  check("the scratch table used for the shuffle is gone",
    !one("SELECT name FROM sqlite_master WHERE type='table' AND name='company_fetch_shuffle'"));
  check("every search's cursor restarts at the front of the new log",
    all("SELECT sweep_cursor c FROM tracks").every((t) => t.c === 0));
  check("company_sweeps.position mirrors the list's, so the previous worker orders by it",
    sweeps.every((r) => r.position === row(r.company_key).position));
  check("the new wall columns exist and are empty on every row",
    fetchRows.every((r) => r.wall === "" && r.wall_first_on === "" && r.wall_last_on === "" && r.wall_dates === 0));

  // The pre-0011 worker's rotation read (db.getCoverage), verbatim. Rolling a
  // deploy back puts that worker on this schema.
  const previous = all(
    `SELECT company, last_swept, board, note, position FROM company_sweeps
      WHERE user_id = ? AND search = ? ORDER BY position`, U1, "SWE");
  check("the previous worker's rotation read still works against this schema",
    previous.length === 4 && previous.every((r) => typeof r.company === "string"),
    JSON.stringify(previous));
  db.close();
}

console.log("\n== 0011: normalize() in SQL agrees with the JavaScript function ==");
{
  // Every ASCII character the SQL spells out, in every position that matters:
  // between letters, leading, trailing, repeated into a run, beside capitals.
  const names = [];
  for (let c = 1; c < 128; c++) {
    const ch = String.fromCharCode(c);
    if (/[a-zA-Z0-9 ]/.test(ch)) continue;
    names.push(`x${ch}y${c}`, `${ch}lead${c}`, `trail${c}${ch}`, `mid${ch}${ch}${ch}run${c}`, `MiXeD${ch}CaSe${c}`);
  }
  names.push("a" + "!@#$%^&*()".repeat(6) + "b", "!!!", "  padded  ", "Rocket Companies (formerly Redfin)");
  const db = migratedThrough(STOP, (d) => {
    const ins = d.prepare("INSERT INTO company_sweeps (user_id, search, company) VALUES ('u', 's', ?)");
    for (const n of names) ins.run(n);
  });
  const rows = db.prepare("SELECT company, company_key FROM company_sweeps").all();
  const wrong = rows.filter((r) => r.company_key !== normalize(r.company));
  check(`all ${names.length} names get the key normalize() would give them`,
    rows.length === names.length && wrong.length === 0,
    JSON.stringify(wrong.slice(0, 5).map((r) => ({ name: [...r.company].map((c) => c.charCodeAt(0)), sql: r.company_key, js: normalize(r.company) }))));
  check("a name that normalizes to nothing does not join the list",
    !db.prepare("SELECT 1 FROM company_fetch WHERE company_key = ''").get());
  db.close();
}

console.log("\n== 0011 against an empty database ==");
{
  const db = migratedThrough(STOP, null);
  check("the list is empty, and nothing is invented for it",
    db.prepare("SELECT COUNT(*) c FROM company_fetch").get().c === 0);
  check("the new columns exist",
    db.prepare("SELECT COUNT(*) c FROM pragma_table_info('company_fetch') WHERE name IN ('position','wall','wall_first_on','wall_last_on','wall_dates')").get().c === 5
    && db.prepare("SELECT COUNT(*) c FROM pragma_table_info('company_sweeps') WHERE name = 'company_key'").get().c === 1);
  check("no scratch table is left behind",
    !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='company_fetch_shuffle'").get());
  db.close();
}

const STOP12 = MIGRATIONS.find((f) => f.startsWith("0012_"));
const DEMO_ID = "1c773239-0000-4000-8000-000000000000";
const listed = (d) => d.prepare("SELECT company_key k, position p FROM company_fetch ORDER BY company_key").all();

console.log("\n== 0012: a seeded demo account's companies leave the shared list ==");
{
  // Northwind and Kestrel are demo-user.json companies a demo account holds.
  // Lumenwave is on that list too, but no demo account holds it here - which is
  // the case of a real company that happens to share a name.
  const db = migratedThrough(STOP12, `
INSERT INTO users (id, name, created_at) VALUES
  ('${OWNER}', 'Brenna', '2026-08-31'),
  ('${DEMO_ID}', 'Demo', '2026-09-02');
INSERT INTO tracks (user_id, key, label, sweep_cursor) VALUES
  ('${OWNER}', 'SWE', 'SWE', 2), ('${DEMO_ID}', 'engineering', 'Engineering', 0);
INSERT INTO leads (user_id, search, found, company, title, url, verified) VALUES
  ('${DEMO_ID}', 'engineering', '2026-09-01', 'Northwind Systems', 'Engineer', 'https://careers.northwind.example.com/jobs/1', '2026-09-01'),
  ('${OWNER}', 'SWE', '2026-09-01', 'Acme', 'Engineer', 'https://boards.greenhouse.io/acme/jobs/1', '2026-09-01');
INSERT INTO applications (user_id, dateApplied, link) VALUES
  ('${DEMO_ID}', '2026-09-02', 'https://careers.kestrel.example.com/apply');
INSERT INTO company_fetch (company_key, display_name, position) VALUES
  ('northwind systems', 'Northwind Systems', 0), ('acme', 'Acme', 1),
  ('kestrel analytics', 'Kestrel Analytics', 2), ('lumenwave', 'Lumenwave', 3), ('zeta', 'Zeta', 4);
INSERT INTO company_sweeps (user_id, search, company, company_key, last_swept, note, position) VALUES
  ('${DEMO_ID}', 'engineering', 'Northwind Systems', 'northwind systems', '', '', 0),
  ('${DEMO_ID}', 'engineering', 'Kestrel Analytics', 'kestrel analytics', '', '', 2),
  ('${OWNER}', 'SWE', 'Northwind Systems', 'northwind systems', '2026-09-11', 'No identifiable real company', 0),
  ('${OWNER}', 'SWE', 'Acme', 'acme', '2026-09-10', '', 1),
  ('${OWNER}', 'SWE', 'Lumenwave', 'lumenwave', '2026-09-11', '', 3);
`);
  const flags = Object.fromEntries(db.prepare("SELECT id, demo FROM users").all().map((u) => [u.id, u.demo]));
  check("the seeded demo account is marked, and the person is not",
    flags[DEMO_ID] === 1 && flags[OWNER] === 0, JSON.stringify(flags));
  check("the companies a demo account holds are off the list, and every other keeps its position",
    JSON.stringify(listed(db)) === JSON.stringify([{ k: "acme", p: 1 }, { k: "lumenwave", p: 3 }, { k: "zeta", p: 4 }]),
    JSON.stringify(listed(db)));
  const sweeps = db.prepare("SELECT user_id u, company_key k FROM company_sweeps ORDER BY u, k").all();
  check("their sweep rows go for every account, including a real search's note about one",
    JSON.stringify(sweeps) === JSON.stringify([{ u: OWNER, k: "acme" }, { u: OWNER, k: "lumenwave" }]), JSON.stringify(sweeps));
  check("no cursor moves",
    JSON.stringify(db.prepare("SELECT key, sweep_cursor c FROM tracks ORDER BY key").all()) ===
    JSON.stringify([{ key: "SWE", c: 2 }, { key: "engineering", c: 0 }]));
  check("the demo account's own leads and applications are its data, and stay",
    db.prepare("SELECT COUNT(*) c FROM leads WHERE user_id = ?").get(DEMO_ID).c === 1 &&
    db.prepare("SELECT COUNT(*) c FROM applications WHERE user_id = ?").get(DEMO_ID).c === 1);
  check("no scratch table is left behind",
    !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'demo_%'").get());
  db.close();
}

console.log("\n== 0012: an account called Demo holding one real posting is a person ==");
{
  // A lookalike host, not a subdomain of example.com - the case a LIKE on the
  // whole URL gets wrong.
  const db = migratedThrough(STOP12, `
INSERT INTO users (id, name) VALUES ('${DEMO_ID}', 'Demo');
INSERT INTO leads (user_id, search, found, company, title, url, verified) VALUES
  ('${DEMO_ID}', 'engineering', '2026-09-01', 'Northwind Systems', 'Engineer', 'https://careers.northwind.example.com/jobs/1', '2026-09-01');
INSERT INTO screened (user_id, search, url, date) VALUES
  ('${DEMO_ID}', 'engineering', 'https://example.com.jobs-mirror.io/realco/9', '2026-09-01');
INSERT INTO company_fetch (company_key, display_name, position) VALUES ('northwind systems', 'Northwind Systems', 0);
INSERT INTO company_sweeps (user_id, search, company, company_key, position) VALUES
  ('${DEMO_ID}', 'engineering', 'Northwind Systems', 'northwind systems', 0);
`);
  check("it is not marked", db.prepare("SELECT demo FROM users").get().demo === 0);
  check("and nothing is removed",
    db.prepare("SELECT COUNT(*) c FROM company_fetch").get().c === 1 &&
    db.prepare("SELECT COUNT(*) c FROM company_sweeps").get().c === 1);
  db.close();
}

const STOP13 = MIGRATIONS.find((f) => f.startsWith("0013_"));
const OTHER_ID = "49732752-0000-4000-8000-000000000000";

console.log("\n== 0013: company_sweeps rebuilt on company_key ==");
{
  // Two spellings of one company in one search - the case 0011 left behind and
  // getCoverage papered over at read time - plus another account's row for a
  // company the first also holds, and a name that normalizes to nothing.
  const db = migratedThrough(STOP13, `
INSERT INTO users (id, name) VALUES ('${OWNER}', 'Brenna'), ('${OTHER_ID}', 'Brady');
INSERT INTO tracks (user_id, key, label, sweep_cursor) VALUES
  ('${OWNER}', 'SWE', 'SWE', 24), ('${OTHER_ID}', 'CPM', 'CPM', 3);
INSERT INTO company_fetch (company_key, display_name, position, board) VALUES
  ('cursor anysphere', 'Cursor (Anysphere)', 0, 'ashby'), ('acme', 'Acme', 1, 'greenhouse');
INSERT INTO company_sweeps (user_id, search, company, company_key, last_swept, board, note, position) VALUES
  ('${OWNER}', 'SWE', 'Cursor (Anysphere)', 'cursor anysphere', '2026-09-01', 'ashby', 'the older note', 0),
  ('${OWNER}', 'SWE', 'Cursor Anysphere', 'cursor anysphere', '2026-09-05', '', '', 0),
  ('${OWNER}', 'SWE', 'Acme', 'acme', '2026-09-03', 'greenhouse', 'acme note', 1),
  ('${OTHER_ID}', 'CPM', 'Acme', 'acme', '2026-09-02', '', 'brady note', 1),
  ('${OWNER}', 'SWE', '!!!', '', '2026-09-04', '', 'punctuation only', 0);
`);
  const cols = db.prepare("SELECT name FROM pragma_table_info('company_sweeps') ORDER BY cid").all().map((c) => c.name);
  check("the mirrored columns are gone, and the row is user, search, key, date, note",
    JSON.stringify(cols) === JSON.stringify(["user_id", "search", "company_key", "last_swept", "note"]),
    JSON.stringify(cols));

  const rows = db.prepare("SELECT user_id, search, company_key, last_swept, note FROM company_sweeps ORDER BY user_id, search, company_key").all();
  check("two spellings of one company become one row, keeping the later date",
    rows.filter((r) => r.company_key === "cursor anysphere" && r.user_id === OWNER).length === 1 &&
    rows.find((r) => r.company_key === "cursor anysphere").last_swept === "2026-09-05",
    JSON.stringify(rows));
  check("and the note from the most recently swept row that had one",
    rows.find((r) => r.company_key === "cursor anysphere").note === "the older note",
    JSON.stringify(rows.find((r) => r.company_key === "cursor anysphere")));
  check("each account keeps its own record of a company they both hold",
    rows.filter((r) => r.company_key === "acme").length === 2 &&
    rows.find((r) => r.user_id === OTHER_ID).note === "brady note", JSON.stringify(rows));
  check("a name that normalizes to nothing is dropped, since it can join no company",
    !rows.some((r) => r.company_key === ""), JSON.stringify(rows));
  check("no cursor moves",
    JSON.stringify(db.prepare("SELECT key, sweep_cursor c FROM tracks ORDER BY key").all()) ===
    JSON.stringify([{ key: "CPM", c: 3 }, { key: "SWE", c: 24 }]));
  check("the key itself is the index a rotation reads, so no separate one is left",
    db.prepare("SELECT COUNT(*) c FROM pragma_index_list('company_sweeps') WHERE origin = 'pk'").get().c === 1 &&
    !db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_company_sweeps_key'").get());
  check("no scratch table is left behind",
    !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='company_sweeps_by_key'").get());

  // db.getCoverage's read, verbatim, against the schema this leaves behind.
  const served = db.prepare(
    `SELECT COALESCE(NULLIF(f.display_name, ''), f.company_key) AS company,
            f.position,
            CASE WHEN f.retracted_on = '' THEN f.board ELSE '' END AS board,
            COALESCE(s.last_swept, '') AS last_swept,
            COALESCE(s.note, '') AS note
       FROM company_fetch f
       LEFT JOIN company_sweeps s
         ON s.user_id = ? AND s.search = ? AND s.company_key = f.company_key
      ORDER BY f.position, f.company_key`).all(OWNER, "SWE");
  check("the rotation read serves one row per company, with the list's name and board",
    served.length === 2 && served[0].company === "Cursor (Anysphere)" && served[0].board === "ashby" &&
    served[0].last_swept === "2026-09-05" && served[1].company === "Acme",
    JSON.stringify(served));
  db.close();
}

console.log("\n== 0013 against an empty database ==");
{
  const db = migratedThrough(STOP13, null);
  check("the table exists and is empty",
    db.prepare("SELECT COUNT(*) c FROM company_sweeps").get().c === 0);
  check("no scratch table is left behind",
    !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='company_sweeps_by_key'").get());
  db.close();
}

console.log("\n== 0012 against an empty database ==");
{
  const db = migratedThrough(STOP12, null);
  const col = db.prepare("SELECT dflt_value d, [notnull] n FROM pragma_table_info('users') WHERE name = 'demo'").get();
  check("users gains demo, not null, defaulting to a person", !!col && col.d === "0" && col.n === 1, JSON.stringify(col));
  check("no scratch table is left behind",
    !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'demo_%'").get());
  db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
