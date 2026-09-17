// Checks every relative Markdown link in tracked .md files, and every relative
// href in docs/*.html: the target file must exist, and a #fragment must match a
// heading slug in the target (GitHub's rules). Links inside fenced code blocks
// and inline code are ignored. Plans (docs/*-plan.md) are reported separately
// and don't fail the check, because plans are never rewritten. Run from the
// repo root; exits 1 on a broken link outside a plan.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const mdFiles = tracked.filter((f) => f.endsWith(".md") && !f.includes("node_modules"));
const htmlFiles = tracked.filter((f) => /^docs\/.*\.html$/.test(f));

const read = (f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const stripCode = (s) => s.replace(/^```[\s\S]*?^```/gm, "").replace(/^~~~[\s\S]*?^~~~/gm, "").replace(/`[^`\n]*`/g, "");

// GitHub heading slugs: lowercase, drop punctuation except - and _, spaces to -,
// repeated slugs get -1, -2...
const slugCache = new Map();
function slugsFor(file) {
  if (slugCache.has(file)) return slugCache.get(file);
  const seen = new Map(), slugs = new Set();
  const text = read(file).replace(/^```[\s\S]*?^```/gm, "");
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const plain = m[1].replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "");
    let slug = plain.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/ /g, "-");
    const n = seen.get(slug) || 0;
    seen.set(slug, n + 1);
    if (n) slug = `${slug}-${n}`;
    slugs.add(slug);
  }
  for (const m of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) slugs.add(m[1]);
  slugCache.set(file, slugs);
  return slugs;
}

const problems = [], planProblems = [];
let checked = 0;
function checkLink(from, target) {
  if (/^(https?:|mailto:|data:|javascript:)/i.test(target) || target === "") return;
  checked++;
  const [pathPart, frag] = target.split("#");
  const resolved = pathPart ? normalize(join(dirname(from), decodeURI(pathPart))).replace(/\\/g, "/") : from;
  const isPlan = /^docs\/.*-plan\.md$/.test(from);
  const bucket = isPlan ? planProblems : problems;
  if (!existsSync(resolved)) { bucket.push(`${from}: missing file -> ${target}`); return; }
  if (frag && statSync(resolved).isFile() && resolved.endsWith(".md")) {
    if (!slugsFor(resolved).has(decodeURI(frag).toLowerCase())) bucket.push(`${from}: missing anchor -> ${target}`);
  }
}

for (const f of mdFiles) {
  const text = stripCode(read(f));
  for (const m of text.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) checkLink(f, m[1]);
  for (const m of text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)) checkLink(f, m[1]);
}
for (const f of htmlFiles) {
  for (const m of read(f).matchAll(/href="([^"]+)"/g)) checkLink(f, m[1]);
}

console.log(`${checked} relative links checked in ${mdFiles.length} .md and ${htmlFiles.length} .html files`);
console.log(problems.length ? `\nBROKEN (${problems.length}):\n  ` + problems.join("\n  ") : "\nno broken links outside plans");
if (planProblems.length) console.log(`\nin plans, not edited (${planProblems.length}):\n  ` + planProblems.join("\n  "));
process.exit(problems.length ? 1 : 0);
