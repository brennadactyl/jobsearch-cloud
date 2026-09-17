// Usage (from any checkout): node tools/proof/prompt-snapshot.mjs <outDir> [--root <checkout>] [--configs <dir>]
//
// Composes the nightly prompts from <checkout>'s server/src/prompt.js (default:
// this checkout) and writes one .txt per shape to <outDir>. Run it once against
// main and once against a branch, then `diff -r` the two folders: a refactor of
// prompt.js passes only when there is no difference, and a behaviour change
// shows exactly the lines it meant to change.
//
// The shapes below are invented and cover every optional part of the prompt.
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
  scope_clause: "",
  scope_disqualifier: "",
  geo_scope_line: "",
  location_guidance: "",
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
  "geo-scope": { track: baseTrack, settings: { ...baseSettings, geo_scope_line: "Only US roles, remote or Seattle.", scope_clause: "in the US", scope_disqualifier: "outside the US" } },
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
    settings: { ...baseSettings, pronouns: "", location_guidance: "Custom location guidance.", footer_note: "Footer.", geo_scope_line: "Anywhere." },
    feeds: [fedTrack],
  },
};

// Each real config twice, as it is and with a stale profile, since the refresh
// step is the other half of the prompt a live config reaches.
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

mkdirSync(outDir, { recursive: true });
for (const [name, shape] of Object.entries(shapes)) {
  writeFileSync(join(outDir, `${name}.txt`), buildSearchPrompt({ user, ...shape }));
}
writeFileSync(join(outDir, "autofill.txt"), buildAutofillPrompt());
console.log(`${Object.keys(shapes).length + 1} prompts from ${root} -> ${outDir}`);
