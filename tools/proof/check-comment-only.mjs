// Proves every changed non-Markdown file changed only in comments.
// Usage, from the repo root:
//   node tools/proof/check-comment-only.mjs [--base=<ref>] [path-prefix ...]
// Compares the working copy against <ref>: the default HEAD checks uncommitted
// edits; --base=origin/main checks a committed branch. Needs client/'s npm
// install, which provides esbuild.
//   .js .mjs .ts .tsx .css  esbuild transform of base vs working copy (comments dropped)
//   .html                   each inline <script>/<style> via esbuild; markup with <!-- --> removed
//   .toml .yml .yaml .gitignore  full-line # comments and blank lines removed
//   .ps1 .md                skipped here (ps1: check-ps1-tokens.ps1)
// Also fails a file whose working-copy line endings aren't what a checkout of
// the base blob would produce (core.autocrlf), or whose BOM changed.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require(require.resolve("esbuild", { paths: [process.cwd() + "/client"] }));
} catch {
  console.error("esbuild not found: run npm install in client/, and run this from the repo root.");
  process.exit(2);
}

let AUTOCRLF = false;
try { AUTOCRLF = execSync("git config --get core.autocrlf", { encoding: "utf8" }).trim() === "true"; } catch { AUTOCRLF = false; }

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("--base=")) ?? "--base=HEAD").slice("--base=".length);
const prefixes = args.filter((a) => !a.startsWith("--base="));
const changed = execSync(`git diff --name-only "${base}"`, { encoding: "utf8" })
  .split("\n").filter(Boolean)
  .filter((f) => prefixes.length === 0 || prefixes.some((p) => f.startsWith(p)));
const baseVersion = (f) => execSync(`git show "${base}:${f}"`, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });

const eolStyle = (buf) => {
  const s = buf.toString("utf8");
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/(?<!\r)\n/g) || []).length;
  return crlf && lf ? "mixed" : crlf ? "crlf" : lf ? "lf" : "none";
};
const hasBom = (buf) => buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

const loaderFor = (f) => ({ js: "js", mjs: "js", cjs: "js", ts: "ts", tsx: "tsx", jsx: "jsx", css: "css" })[f.split(".").pop()];
// Syntax + whitespace minification drops comments esbuild otherwise keeps
// (inside object and array literals). Identifier minification stays OFF: esbuild
// picks short names from the source's character frequency, which comments are
// part of, so it renames differently once comments change.
const strip = (code, loader) =>
  esbuild.transformSync(code, {
    loader,
    legalComments: "none",
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    logLevel: "silent",
  }).code;

function htmlParts(src) {
  const parts = [];
  const re = /<(script|style)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let markup = "", last = 0, m;
  while ((m = re.exec(src))) {
    markup += src.slice(last, m.index) + `<${m[1]}${m[2] || ""}>@@BLOCK@@</${m[1]}>`;
    const attrs = m[2] || "";
    if (m[1].toLowerCase() === "script" && /\bsrc=/.test(attrs)) parts.push(["raw", m[3]]);
    else parts.push([m[1].toLowerCase() === "style" ? "css" : "js", m[3]]);
    last = re.lastIndex;
  }
  markup += src.slice(last);
  markup = markup.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
  return { markup, parts };
}

let fail = 0, pass = 0;
const skipped = [];
const report = (f, ok, detail) => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${f}${!ok && detail ? " -- " + detail : ""}`); };

for (const f of changed) {
  const ext = f.includes(".") ? f.split(".").pop().toLowerCase() : f;
  if (ext === "md" || ext === "ps1") { skipped.push(f); continue; }
  let before, after;
  try { before = baseVersion(f); } catch { report(f, false, `not in ${base} (new file?)`); continue; }
  try { after = readFileSync(f); } catch { report(f, false, "deleted in working copy"); continue; }

  // With core.autocrlf=true git normalizes endings on commit, so LF, CRLF or mixed
  // in the working copy all commit identically - note it, don't fail on it.
  const expectedEol = AUTOCRLF && eolStyle(before) === "lf" ? "crlf" : eolStyle(before);
  if (eolStyle(after) !== expectedEol) {
    if (AUTOCRLF) console.log(`  note  ${f} -- working-copy endings ${eolStyle(after)} (normalized on commit)`);
    else { report(f, false, `line endings: expected ${expectedEol}, found ${eolStyle(after)}`); continue; }
  }
  if (hasBom(before) !== hasBom(after)) { report(f, false, `BOM ${hasBom(before)} -> ${hasBom(after)}`); continue; }

  const b = before.toString("utf8"), a = after.toString("utf8");
  try {
    const loader = loaderFor(f);
    if (loader) {
      report(f, strip(b, loader) === strip(a, loader), "code differs after stripping comments");
    } else if (ext === "html") {
      const hb = htmlParts(b), ha = htmlParts(a);
      if (hb.markup !== ha.markup) { report(f, false, "markup outside comments differs"); continue; }
      if (hb.parts.length !== ha.parts.length) { report(f, false, "number of script/style blocks differs"); continue; }
      const bad = hb.parts.findIndex(([kind, code], i) => {
        const [kind2, code2] = ha.parts[i];
        if (kind !== kind2) return true;
        if (kind === "raw") return code !== code2;
        return strip(code, kind) !== strip(code2, kind);
      });
      report(f, bad === -1, `inline block #${bad} differs after stripping comments`);
    } else if (ext === "json" && /tsconfig|jsconfig/.test(f)) {
      // JSON with comments: compare the parsed data, so only comments may differ.
      const parse = (s) => JSON.parse(s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1"));
      report(f, JSON.stringify(parse(b)) === JSON.stringify(parse(a)), "parsed config differs");
    } else if (["toml", "yml", "yaml"].includes(ext) || f.endsWith(".gitignore") || /(^|\/)\.env[^/]*$/.test(f)) {
      const norm = (s) => s.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).join("\n");
      report(f, norm(b) === norm(a), "non-comment lines differ");
    } else {
      skipped.push(f + " (no comparer for this type)");
    }
  } catch (e) {
    report(f, false, "parse error: " + e.message.split("\n")[0]);
  }
}
console.log(`\n${pass} passed, ${fail} failed  (core.autocrlf=${AUTOCRLF})`);
if (skipped.length) console.log(`skipped here: ${skipped.join(", ")}`);
process.exit(fail ? 1 : 0);
