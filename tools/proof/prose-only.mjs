// Answers one question about a branch: does every file it changes qualify as
// prose or comments, so the change needs one reviewer rather than the full set?
// Usage, from the repo root:
//   node tools/proof/prose-only.mjs [--base=<ref>]
// The default base is origin/main, which is the question a PR asks; --base=HEAD
// answers it for uncommitted edits.
//
// A file qualifies when it is prose a person reads - a `.md` under docs/, any
// README, anything under private.example/ - or when the comments-only check
// passes it (tools/proof/check-comment-only.mjs, or check-ps1-tokens.ps1 for a
// .ps1). Everything else refuses, including a file type neither check covers.
//
// The instructions every session acts on never qualify, though they are
// Markdown: CLAUDE.md, .claude/skills/ and the rest of .claude/. A wrong line
// there is followed by the whole team and by a fresh machine's team, and a
// one-word change is exactly the diff a single reader skims.
import { execFileSync, execSync } from "node:child_process";

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("--base=")) ?? "--base=origin/main").slice("--base=".length);

const isInstruction = (f) => f === "CLAUDE.md" || f.startsWith(".claude/");
const isProse = (f) =>
  (f.startsWith("docs/") && f.endsWith(".md")) ||
  f === "README.md" ||
  f.endsWith("/README.md") ||
  f.startsWith("private.example/");

const isNew = new Set();
let changed;
try {
  const tracked = execSync(`git diff --name-only "${base}"`, { encoding: "utf8" }).split("\n").filter(Boolean);
  // A file not yet committed is part of the change too, and a new one refuses
  // unless it is prose: the comments-only check has nothing to compare it to.
  const untracked = execSync("git ls-files --others --exclude-standard", { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of untracked) isNew.add(f);
  changed = [...new Set([...tracked, ...untracked])].sort();
} catch {
  console.error(`cannot diff against ${base}: fetch it first, or pass --base=<ref>.`);
  process.exit(2);
}
if (changed.length === 0) {
  console.log(`no files changed against ${base}`);
  process.exit(1);
}

// One run of each checker for all the files it covers, rather than one per
// file: both report a line per file, which is what this reads.
function checkedFiles(command, args, files) {
  if (files.length === 0) return new Map();
  let output = "";
  try {
    output = execFileSync(command, args, { encoding: "utf8" });
  } catch (e) {
    // A failing check exits non-zero and still prints its per-file lines.
    output = (e.stdout || "") + (e.stderr || "");
  }
  const verdicts = new Map();
  // Split on either ending: a line kept as "...\r" never matches, because `.`
  // doesn't match a carriage return and the PowerShell check writes CRLF.
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*(PASS|FAIL)\s+(\S+)\s*(?:--\s*(.*))?$/);
    if (m) verdicts.set(m[2].replace(/\\/g, "/"), { ok: m[1] === "PASS", detail: (m[3] || "").trim() });
  }
  // A file neither checker reported on was skipped: a type it doesn't cover, or
  // a file that isn't in the base for it to compare against.
  const unreported = (f) => ({
    ok: false,
    detail: isNew.has(f) ? "a new file, with nothing to compare it to" : "no check covers this file type",
  });
  return new Map(files.map((f) => [f, verdicts.get(f) ?? unreported(f)]));
}

const toCheck = changed.filter((f) => !isInstruction(f) && !isProse(f));
const scripts = toCheck.filter((f) => f.toLowerCase().endsWith(".ps1"));
const code = toCheck.filter((f) => !f.toLowerCase().endsWith(".ps1"));

const verdicts = new Map([
  ...checkedFiles("node", ["tools/proof/check-comment-only.mjs", `--base=${base}`, ...code], code),
  ...checkedFiles(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tools/proof/check-ps1-tokens.ps1", "-Base", base],
    scripts,
  ),
]);

let refused = 0;
for (const f of changed) {
  if (isInstruction(f)) {
    refused++;
    console.log(`  NO    ${f} -- instructions every session acts on, never a one-reviewer change`);
  } else if (isProse(f)) {
    console.log(`  prose ${f}`);
  } else {
    const v = verdicts.get(f);
    if (v?.ok) console.log(`  code  ${f} -- comments only`);
    else {
      refused++;
      console.log(`  NO    ${f} -- ${v?.detail || "changed outside its comments"}`);
    }
  }
}

console.log(
  refused === 0
    ? `\nprose only: ${changed.length} file(s) against ${base}. One reviewer is enough.`
    : `\nnot prose only: ${refused} of ${changed.length} file(s) against ${base} need the full review.`,
);
process.exit(refused === 0 ? 0 : 1);
