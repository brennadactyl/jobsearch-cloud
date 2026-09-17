/**
 * Ask a question of the tracker's data without touching production: load the
 * newest local backup into an in-memory SQLite database and run one SELECT.
 *
 *   node server/inspect-backup.mjs "SELECT COUNT(*) AS n FROM company_fetch"
 *   node server/inspect-backup.mjs --file <backup.sql> "SELECT ..."
 *
 * Production D1 is reached only through the API, so a read about live rows
 * comes from a backup instead (scripts/backup-tracker.ps1 writes them). The
 * answer is as of that backup's time, printed first; take a fresh backup when
 * that matters.
 *
 * Read-only three ways: anything but a single SELECT (or WITH ... SELECT) is
 * refused, SQLite's query_only pragma refuses any write that gets past that,
 * and the database is a copy in memory, thrown away on exit. A semicolon or
 * comment marker inside a quoted string is refused too, which only costs
 * rewording the query.
 *
 * Backups hold people's search details. Select the
 * counts, keys and flags a question needs rather than whole rows, and don't
 * paste the output anywhere public.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const fileFlag = args.indexOf("--file");
const explicit = fileFlag >= 0 ? args.splice(fileFlag, 2)[1] : "";
const sql = args.join(" ").trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!sql) fail('usage: node server/inspect-backup.mjs [--file <backup.sql>] "SELECT ..."');

// One statement, starting with SELECT or WITH once comments are set aside. A
// trailing semicolon is allowed; a second statement after it is not.
const bare = sql
  .replace(/--[^\n]*/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .trim()
  .replace(/;\s*$/, "");
if (!/^(select|with)\b/i.test(bare) || bare.includes(";")) {
  fail("refused: only a single SELECT (or WITH ... SELECT) is run against a backup");
}

// The same folder backup-tracker.ps1 writes to.
function newestBackup() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = process.env.JOB_SEARCH_DATA_DIR || path.join(repo, "private");
  const dir = path.join(dataDir, "backups");
  if (!fs.existsSync(dir)) fail(`no backups folder at ${dir} - run scripts/backup-tracker.ps1, or pass --file`);
  // The file name carries the date and time, so name order is time order.
  const newest = fs
    .readdirSync(dir)
    .filter((f) => /^d1-.*\d{4}-\d{2}-\d{2}-\d{6}\.sql$/.test(f))
    .sort()
    .pop();
  if (!newest) fail(`no backup in ${dir} - run scripts/backup-tracker.ps1, or pass --file`);
  return path.join(dir, newest);
}

const file = explicit || newestBackup();
if (!fs.existsSync(file)) fail(`no file at ${file}`);

const db = new DatabaseSync(":memory:");
db.exec(fs.readFileSync(file, "utf8"));
// SQLite then refuses any write, including one the text check can't see, such
// as WITH ... DELETE.
db.exec("PRAGMA query_only = ON");

let rows;
try {
  rows = db.prepare(bare).all();
} catch (err) {
  fail(`query failed: ${err.message}`);
}

console.log(`backup: ${path.basename(file)}`);
if (rows.length === 0) console.log("(no rows)");
else console.table(rows);
