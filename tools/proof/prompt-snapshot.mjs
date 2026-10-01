// Usage (from any checkout): node tools/proof/prompt-snapshot.mjs <outDir> [--root <checkout>] [--configs <dir>]
//
// Composes the nightly prompts from <checkout>'s server/src/prompt.js (default:
// this checkout) and writes one .txt per shape to <outDir>. Run it once against
// main and once against a branch, then `diff -r` the two folders: a refactor of
// prompt.js passes only when there is no difference, and a behaviour change
// shows exactly the lines it meant to change.
//
// The shapes below are invented, and the run says whether they still cover every
// optional part: it exits 1 naming any field the prompt reads that no shape gives
// a value to, or any field a shape sets that the prompt has stopped reading.
// Without that, a branch nothing composes is identical in both runs and its
// empty diff reads as proof.
// --configs adds real ones: a folder of JSON files, each
// { "track": {...}, "fed_tabs": [...], "settings": {...} } as GET /api/config
// returns them. Those are private - keep that folder outside the repo.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = args[0];
if (!outDir || outDir.startsWith("--")) {
  console.error("usage: node tools/proof/prompt-snapshot.mjs <outDir> [--root <checkout>] [--configs <dir>]");
  process.exit(2);
}
const root = resolve(flag("--root") || ".");
const { buildSearchPrompt, buildAutofillPrompt } = await import(pathToFileURL(join(root, "server/src/prompt.js")).href);

const user = { id: "u-1", name: "Ada" };
const baseSettings = {
  pronouns: "she/her",
  excluded_companies: [],
  priority_locations: "",
  search_locations: "",
  excluded_locations: "",
  location_note: "",
  footer_note: "",
};
const baseTrack = {
  key: "eng",
  label: "Engineering",
  full_description: "Backend and platform engineering roles",
  schedule_time: "01:30",
  doc_file: "",
  doc_summary: "",
  intro_note: "",
  leads_note: "",
  fit_filter_step: "",
  doc_update_line: "",
  search_note: "",
  documents: JSON.stringify(["docs/tracked_eng_postings.md", "resumes/Ada_Resume.pdf"]),
  resume_line: "",
  profile_stale_since: "",
  resume_was: "",
  role_search_line: "senior backend engineer roles",
  fit_clause: "",
  fit_disqualifier: "",
  screened_examples: "",
  report_line: "",
};
const fedTrack = { ...baseTrack, key: "infra", label: "Infrastructure", full_description: "SRE and infrastructure roles" };

const shapes = {
  "single-tab": { track: baseTrack, settings: baseSettings },
  "multi-tab": { track: baseTrack, settings: baseSettings, feeds: [fedTrack] },
  "multi-tab-two-feeds": {
    track: baseTrack,
    settings: baseSettings,
    feeds: [fedTrack, { ...fedTrack, key: "data", label: "Data", full_description: "" }],
  },
  "fit-filter-step": { track: { ...baseTrack, fit_filter_step: "Skip roles needing an active clearance." }, settings: baseSettings },
  "fit-clause": { track: { ...baseTrack, fit_clause: "at Senior or Staff level", fit_disqualifier: "not engineering work" }, settings: baseSettings },
  "locations-ranked": {
    track: baseTrack,
    settings: { ...baseSettings, priority_locations: "Seattle area, Portland OR, Remote US" },
  },
  "locations-all-four": {
    track: baseTrack,
    settings: {
      ...baseSettings,
      priority_locations: "Seattle area, Remote US",
      search_locations: "Anywhere in Washington",
      excluded_locations: "The Bay Area",
      location_note: "Would move for the right team.",
    },
  },
  "locations-searched-only": {
    track: baseTrack,
    settings: { ...baseSettings, search_locations: "Anywhere in Washington", excluded_locations: "Spokane, WA" },
  },
  "pay-floor-year": { track: { ...baseTrack, pay_floor: "180,000", pay_floor_unit: "year" }, settings: baseSettings },
  "pay-floor-hour": { track: { ...baseTrack, pay_floor: "$95", pay_floor_unit: "hour" }, settings: baseSettings },
  "stale-profile": { track: { ...baseTrack, profile_stale_since: "2026-09-16T10:00:00Z", resume_was: "resumes/Old.pdf" }, settings: baseSettings },
  "stale-profile-no-resume-was": { track: { ...baseTrack, profile_stale_since: "2026-09-16T10:00:00Z" }, settings: baseSettings },
  "unreadable-documents": { track: { ...baseTrack, documents: JSON.stringify(["docs/tracked_eng_postings.md", "resumes/Ada.docx"]), resume_line: "Use the text copy if the docx won't open." }, settings: baseSettings },
  "no-documents": { track: { ...baseTrack, documents: "" }, settings: baseSettings },
  "reference-only-resume": { track: { ...baseTrack, documents: JSON.stringify(["reference/Ada.txt"]) }, settings: baseSettings },
  "excluded-companies": { track: baseTrack, settings: { ...baseSettings, excluded_companies: ["Initech", "Globex", "any company Initech owns"] } },
  "one-excluded-company": { track: baseTrack, settings: { ...baseSettings, excluded_companies: ["Initech", "  ", 7] } },
  "doc-budget": { track: baseTrack, settings: baseSettings, docBudget: 2500 },
  "every-override": {
    track: {
      ...baseTrack,
      doc_file: "docs/custom.md",
      doc_summary: "a custom summary",
      intro_note: "Pivot search.",
      leads_note: "`fit` is required",
      fit_filter_step: "Screen for pivot fit.",
      doc_update_line: "Custom doc update line.",
      search_note: "Prefer startups.",
      fit_clause: "a fit for the pivot",
      fit_disqualifier: "no pivot path",
      screened_examples: '"too senior"',
      report_line: "Report briefly.",
      schedule_time: "",
      role_search_line: "",
    },
    settings: {
      ...baseSettings,
      pronouns: "",
      priority_locations: "Remote US",
      excluded_locations: "Anywhere needing a daily commute",
      location_note: "Open to a move for the right team.",
      footer_note: "Footer.",
    },
    feeds: [fedTrack],
  },
};

// Each real config twice, as it is and with a stale profile, since the refresh
// step is the other half of the prompt a live config reaches.
// Captured before any real config joins them: the gate judges the shapes this
// file is responsible for, on every run. A real config fills whatever that
// person happens to have set, so a field nobody has set yet would read as this
// tool's fault - but leaving them out must not mean leaving the gate out, which
// is what `--configs` would otherwise do on the one run that matters most.
const inventedShapes = { ...shapes };
const configDir = flag("--configs");
if (configDir) {
  for (const file of readdirSync(configDir).filter((f) => f.endsWith(".json"))) {
    const c = JSON.parse(readFileSync(join(configDir, file), "utf8"));
    const name = basename(file, ".json");
    shapes[`config-${name}`] = { track: c.track, settings: c.settings, feeds: c.fed_tabs || [] };
    shapes[`config-${name}-stale`] = {
      track: { ...c.track, profile_stale_since: "2026-09-16T10:00:00Z", resume_was: "resumes/Old.pdf" },
      settings: c.settings,
      feeds: c.fed_tabs || [],
    };
  }
}

// Whether the shapes still cover the prompt, which the snapshots themselves
// cannot say: a branch no shape composes is identical in both runs, so its diff
// is empty and reads as proof. Both lists are the same mistake from either end -
// a field the prompt reads that no shape gives a value to is a branch nothing
// tests, and a field a shape sets that the prompt no longer reads is a shape
// kept alive past the feature it was written for, which is how a retired
// override sat here composing nothing.
//
// A read is counted through a Proxy rather than found by reading the source, so
// the answer comes from what the prompt does. That sets three ceilings. Any truthy
// value counts as covered, so this catches "no shape composes this at all" and
// nothing finer - not which branch a value took. And a field read only inside a
// branch no shape reaches is never accessed, so the first list cannot name it
// yet: a clean run means nothing is missing among the branches these shapes
// reach. The field gating that branch is named instead, so adding a shape for it
// surfaces the inner one on the next run - re-run after adding a shape rather
// than reading one clean result as the end of it. And the reads are named
// property accesses: prompt.js reaches for its fields one at a time today, and
// the day it spreads or stringifies a track or the settings instead, every own
// key counts as read and the second list empties for good, reporting clean. A
// gate that can go quiet is worth knowing about, so if you add a spread there,
// this is the file that needs a different way to count.
function coverage() {
  const read = new Set();
  const gaveAValue = new Set();
  const setByAShape = new Set();
  const watch = (obj) =>
    new Proxy(obj, {
      get(target, prop) {
        if (typeof prop === "string") {
          read.add(prop);
          const v = target[prop];
          if (v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) {
            gaveAValue.add(prop);
          }
        }
        return target[prop];
      },
    });
  for (const shape of Object.values(inventedShapes)) {
    for (const key of Object.keys(shape.track || {})) setByAShape.add(key);
    for (const key of Object.keys(shape.settings || {})) setByAShape.add(key);
    buildSearchPrompt({ user, ...shape, track: watch(shape.track || {}), settings: watch(shape.settings || {}) });
  }
  return {
    neverGivenAValue: [...read].filter((f) => !gaveAValue.has(f)).sort(),
    neverRead: [...setByAShape].filter((f) => !read.has(f)).sort(),
  };
}

mkdirSync(outDir, { recursive: true });
for (const [name, shape] of Object.entries(shapes)) {
  writeFileSync(join(outDir, `${name}.txt`), buildSearchPrompt({ user, ...shape }));
}
writeFileSync(join(outDir, "autofill.txt"), buildAutofillPrompt());
console.log(`${Object.keys(shapes).length + 1} prompts from ${root} -> ${outDir}`);

// Reported after the snapshots are written, so a run with a gap still leaves the
// folder to diff - the gap is a hole in the proof, not a reason to withhold it.
const { neverGivenAValue, neverRead } = coverage();
for (const [label, fields] of [
  ["read by prompt.js, given a value by no shape", neverGivenAValue],
  ["set by a shape, read by prompt.js nowhere", neverRead],
]) {
  console.log(`${label}: ${fields.length ? fields.join(", ") : "none"}`);
}
if (neverGivenAValue.length || neverRead.length) {
  console.log("A diff of these snapshots proves nothing about those fields - add a shape, or drop the dead one.");
  process.exitCode = 1;
}
