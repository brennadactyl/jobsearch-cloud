/**
 * Checks docs/schema.md against the schema server/migrations/ builds.
 *
 *   node verify-schema-doc.mjs
 *
 * Applies every migration, in filename order, to a throwaway in-process
 * `node:sqlite` database and compares the result with the doc: the diagram's
 * tables, columns, types and keys, and the claims in the prose that have a
 * checkable shape - the migration range, the no-default list, the tables with
 * no user_id, the column each table's notes lead with, the files and constants
 * the doc cites. No wrangler, no dev worker, nothing to clean up. CI runs it on
 * every push to main and every pull request (.github/workflows/checks.yml).
 *
 * It checks that the doc and the migrations agree, never what the schema
 * should be, so a migration that updates the doc in the same change passes.
 * What a column is *for* is prose, and is not checked.
 *
 * A FAIL saying a sentence was not found means the doc was reworded. Update
 * the pattern here to match.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(SERVER, "..");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "\n          " + detail : ""}`); }
};
const sorted = (xs) => [...new Set(xs)].sort();
const sameSet = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const vs = (doc, built) => `doc: ${JSON.stringify(doc)}\n          migrations: ${JSON.stringify(built)}`;
const notFound = (text) => `no text starting ${JSON.stringify(text)} in docs/schema.md - if it was reworded, update this check`;

// ------------------------------------------------- what the migrations build --

const migrations = readdirSync(join(SERVER, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const db = new DatabaseSync(":memory:");
for (const f of migrations) db.exec(readFileSync(join(SERVER, "migrations", f), "utf8"));

const schema = {};
for (const { name, sql } of db
  .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .all()) {
  schema[name] = {
    sql,
    cols: db.prepare(`PRAGMA table_info(${name})`).all(),
    fks: db.prepare(`PRAGMA foreign_key_list(${name})`).all(),
    indexes: db.prepare(`PRAGMA index_list(${name})`).all().map((i) => ({
      ...i,
      columns: db.prepare(`PRAGMA index_info(${i.name})`).all().map((c) => c.name),
    })),
  };
}
const tables = Object.keys(schema);
const isTable = (s) => Object.hasOwn(schema, s);
const colNames = (t) => schema[t].cols.map((c) => c.name);
const allCols = tables.flatMap((t) => schema[t].cols.map((c) => ({ ...c, table: t, ref: `${t}.${c.name}` })));

// --------------------------------------------------------------- the doc --

const doc = readFileSync(join(ROOT, "docs", "schema.md"), "utf8").replace(/\r\n/g, "\n");
const prose = doc.replace(/```[\s\S]*?```/g, "");
const ticks = (s) => [...s.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const refsIn = (s) =>
  ticks(s).map((x) => x.match(/^(\w+)\.(\w+)$/)).filter((m) => m && isTable(m[1])).map((m) => m[0]);
// Paragraphs and bullets, each as one string.
const chunks = prose.split(/\n(?=- |#)|\n\n/);
const chunkStarting = (start) => chunks.find((c) => c.startsWith(start));
const sections = prose.split(/^### /m).slice(1).map((s) => ({ name: s.slice(0, s.indexOf("\n")).trim(), body: s }));

const diagram = {};
const rels = [];
const mermaid = doc.match(/```mermaid\n([\s\S]*?)```/);

console.log("\n== the diagram ==");
if (!mermaid) {
  check("docs/schema.md has a mermaid diagram", false);
} else {
  let entity = null;
  for (const line of mermaid[1].split("\n")) {
    let m;
    if (!line.trim() || line.trim() === "erDiagram") continue;
    if ((m = line.match(/^\s*(\w+) \{$/))) { entity = diagram[m[1]] = []; continue; }
    if (/^\s*\}$/.test(line)) { entity = null; continue; }
    if (entity && (m = line.match(/^\s*(\w+) (\w+)(?: ((?:PK|FK|UK)(?:, (?:PK|FK|UK))*))?(?: "[^"]*")?$/))) {
      entity.push({ type: m[1], name: m[2], keys: m[3] ? m[3].split(", ") : [] });
      continue;
    }
    if (!entity && (m = line.match(/^\s*(\w+)\s+\S+--\S+\s+(\w+)\s*:/))) { rels.push([m[1], m[2]]); continue; }
    check(`diagram line is understood: ${line.trim()}`, false);
  }
}

check("draws every table the migrations build, and no others",
  sameSet(Object.keys(diagram), tables), vs(sorted(Object.keys(diagram)), sorted(tables)));
for (const [a, b] of rels) check(`relationship ${a} - ${b} joins tables that exist`, isTable(a) && isTable(b));

for (const t of tables.filter((t) => diagram[t])) {
  const drawn = diagram[t];
  const names = drawn.map((c) => c.name);
  check(`${t}: columns, in order`, JSON.stringify(names) === JSON.stringify(colNames(t)), vs(names, colNames(t)));
  const wrongType = drawn
    .filter((c) => schema[t].cols.find((x) => x.name === c.name)?.type !== c.type)
    .map((c) => `${c.name} drawn ${c.type}, built ${schema[t].cols.find((x) => x.name === c.name)?.type ?? "missing"}`);
  check(`${t}: types`, wrongType.length === 0, wrongType.join("; "));
  const marked = (k) => drawn.filter((c) => c.keys.includes(k)).map((c) => c.name);
  const pk = schema[t].cols.filter((c) => c.pk > 0).map((c) => c.name);
  check(`${t}: PK marks`, sameSet(marked("PK"), pk), vs(marked("PK"), pk));
  const uk = schema[t].indexes.filter((i) => i.unique && i.origin === "u").flatMap((i) => i.columns);
  check(`${t}: UK marks`, sameSet(marked("UK"), uk), vs(marked("UK"), uk));
  if (colNames(t).includes("user_id")) check(`${t}: user_id is marked FK`, marked("FK").includes("user_id"));
}

console.log("\n== the opening sentence ==");
const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const intro = prose.match(/(\w+)\s+tables,\s+from\s+`(\d{4}_\w+\.sql)`\s+through\s+`(\d{4}_\w+\.sql)`/);
if (!intro) {
  check("names the table count and the migration range", false, notFound("<n> tables, from `NNNN_a.sql` through `NNNN_b.sql`"));
} else {
  const n = /^\d+$/.test(intro[1]) ? Number(intro[1]) : NUMBERS.indexOf(intro[1].toLowerCase());
  check(`table count ("${intro[1]}")`, n === tables.length, `the migrations build ${tables.length}`);
  check(`first migration (${intro[2]})`, intro[2] === migrations[0], `the first is ${migrations[0]}`);
  check(`last migration (${intro[3]})`, intro[3] === migrations.at(-1), `the last is ${migrations.at(-1)}`);
}

console.log("\n== what the column names don't show ==");
if (prose.includes("**There are no foreign keys.**")) {
  const withFks = tables.filter((t) => schema[t].fks.length);
  check("no table declares a foreign key", withFks.length === 0, `declared on: ${withFks.join(", ")}`);
}
{
  const start = "**Apart from";
  const chunk = chunkStarting(start);
  const built = tables.filter((t) => !colNames(t).includes("user_id"));
  if (!chunk) check("the tables with no user_id", false, notFound(start));
  else {
    const named = ticks(chunk).filter(isTable);
    check("the tables with no user_id", sameSet(named, built), vs(sorted(named), sorted(built)));
  }
}
{
  const example = prose.match(/`([^`]+)` is stored under\s+`([^`]+)`/);
  if (example) {
    const { normalize } = await import(pathToFileURL(join(SERVER, "src", "exclude.js")).href);
    check(`normalize(${JSON.stringify(example[1])}) is ${JSON.stringify(example[2])}`,
      normalize(example[1]) === example[2], `it is ${JSON.stringify(normalize(example[1]))}`);
  }
}

console.log("\n== conventions ==");
if (prose.includes("Every column outside a primary key is `NOT NULL`")) {
  const nullable = allCols.filter((c) => c.pk === 0 && !c.notnull).map((c) => c.ref);
  check("every column outside a primary key is NOT NULL", nullable.length === 0, `nullable: ${nullable.join(", ")}`);
}
{
  const start = "- Columns with no default";
  const chunk = chunkStarting(start);
  const built = allCols.filter((c) => c.pk === 0 && c.notnull && c.dflt_value === null).map((c) => c.ref);
  if (!chunk) check("the no-default list", false, notFound(start));
  else check("the no-default list", sameSet(refsIn(chunk), built), vs(sorted(refsIn(chunk)), sorted(built)));
}
{
  const start = "- The only defaults other than";
  const chunk = chunkStarting(start);
  const built = allCols
    .filter((c) => c.dflt_value !== null && c.dflt_value !== "''" && c.dflt_value !== "0")
    .map((c) => `${c.ref} = ${c.dflt_value.replace(/^'(.*)'$/, "$1")}`);
  if (!chunk) check("the non-empty defaults", false, notFound(start));
  else {
    const said = [...chunk.matchAll(/`(\w+\.\w+)`\s+\(`([^`]*)`\)/g)].map((m) => `${m[1]} = ${m[2]}`);
    check("the non-empty defaults", sameSet(said, built), vs(sorted(said), sorted(built)));
  }
}
{
  const chunk = chunks.find((c) => c.startsWith("- ") && c.includes("`AUTOINCREMENT`"));
  const built = tables.filter((t) => /\bAUTOINCREMENT\b/i.test(schema[t].sql));
  if (!chunk) check("the AUTOINCREMENT tables", false, notFound("- ... `AUTOINCREMENT`"));
  else {
    const named = refsIn(chunk).map((r) => r.split(".")[0]);
    check("the AUTOINCREMENT tables", sameSet(named, built), vs(sorted(named), sorted(built)));
  }
}
{
  const start = "- `user_id` has its own index on";
  const chunk = chunkStarting(start);
  const built = tables.filter((t) => schema[t].indexes.some((i) => i.origin === "c" && i.columns.join() === "user_id"));
  if (!chunk) check("the tables with a user_id index", false, notFound(start));
  else {
    const named = ticks(chunk).filter(isTable);
    check("the tables with a user_id index", sameSet(named, built), vs(sorted(named), sorted(built)));
    const rest = tables.filter((t) => colNames(t).includes("user_id") && !built.includes(t));
    const notLeading = rest.filter((t) => schema[t].cols.find((c) => c.pk === 1)?.name !== "user_id");
    check("the other user-scoped tables lead their primary key with user_id", notLeading.length === 0, notLeading.join(", "));
  }
}

console.log("\n== each table's notes ==");
check("every table has a ### section, and every section is a table",
  sameSet(sections.map((s) => s.name), tables), vs(sorted(sections.map((s) => s.name)), sorted(tables)));
for (const { name, body } of sections.filter((s) => isTable(s.name) && s.name !== "meta")) {
  const leading = [...body.matchAll(/^- `(\w+)`/gm)].map((m) => m[1]);
  const unknown = leading.filter((c) => !colNames(name).includes(c));
  check(`${name}: every note leads with a column it has`, unknown.length === 0, `not a column: ${unknown.join(", ")}`);
}
{
  const meta = sections.find((s) => s.name === "meta");
  if (meta) {
    const src = readFileSync(join(SERVER, "src", "db.js"), "utf8");
    const { DEFAULT_SETTINGS } = await import(pathToFileURL(join(SERVER, "src", "db.js")).href);
    const literal = [...src.matchAll(/INTO meta \(user_id, key, value\) VALUES \(\?, '(\w+)'/g)].map((m) => m[1]);
    const built = [...Object.keys(DEFAULT_SETTINGS), ...literal];
    const listed = [...meta.body.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]);
    check("meta: the keys listed are the keys db.js uses", sameSet(listed, built), vs(sorted(listed), sorted(built)));
  }
}

console.log("\n== what the doc cites ==");
{
  const spans = ticks(prose);
  // Not preceded by a slash or dot, so `server/src/routes/leads.js` is a path,
  // not a mention of a `js` column on `leads`.
  const mentioned = sorted(spans.flatMap((s) => [...s.matchAll(/(?<![\w/.])(\w+)\.(\w+)(?![\w.])/g)])
    .filter((m) => isTable(m[1])).map((m) => m[0]));
  const missing = mentioned.filter((r) => !allCols.some((c) => c.ref === r));
  check(`${mentioned.length} table.column mentions are all real columns`, missing.length === 0, `missing: ${missing.join(", ")}`);

  const paths = sorted(spans.filter((s) => /^(server|scripts|docs|client|client-react)\/[\w./-]+\.\w+$/.test(s)));
  const noFile = paths.filter((p) => !existsSync(join(ROOT, p)));
  check(`${paths.length} cited paths exist`, noFile.length === 0, `missing: ${noFile.join(", ")}`);

  const migRefs = sorted(spans.filter((s) => /^\d{4}_\w+\.sql$/.test(s)));
  const noMig = migRefs.filter((f) => !migrations.includes(f));
  check(`${migRefs.length} cited migrations exist`, noMig.length === 0, `missing: ${noMig.join(", ")}`);

  const src = readdirSync(join(SERVER, "src"), { recursive: true })
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(SERVER, "src", f), "utf8"))
    .join("\n");
  const constants = sorted(spans.filter((s) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(s)));
  const unexported = constants.filter((c) => !new RegExp(`export const ${c}\\b`).test(src));
  check(`${constants.length} cited constants are exported from server/src`, unexported.length === 0, `not found: ${unexported.join(", ")}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\ndocs/schema.md no longer matches server/migrations/. Update the doc in the same change as the migration.");
  process.exit(1);
}
