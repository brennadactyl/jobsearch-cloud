/**
 * Composes one track's daily search prompt from its D1 config, served by
 * GET /api/prompt/:key and run by scripts/run-search.ps1.
 *
 * Steps that call the tracker name a `./tracker` command (scripts/tracker.ps1).
 * The helper owns the track key, the local date and each payload's shape, so
 * the text says only what the run alone knows: which postings are new, which
 * it confirmed dead, which companies it managed to read.
 *
 * A rule's rationale goes in a comment beside it, not in the emitted text. The
 * exception is step 4's verification requirement, stated in full because the
 * whole system rests on it.
 *
 * Only fields the app reads are structured (key, label, sort_order,
 * schedule_time); everything only the model reads is stored
 * prose, interpolated verbatim - see server/README.md, "Config fields are
 * mostly prose, on purpose".
 */

import { parseDocumentList } from "./db.js";
import { documentExtension, READABLE_DOCUMENT_EXTENSIONS } from "./validate.js";

// Unset falls back to they/them: the server knows nothing about a name beyond
// the name. POST /api/intake accepts exactly these keys, and the page offers
// the same three (PRONOUNS in client/src/api/schema.ts).
export const PRONOUNS = {
  "she/her": { subj: "she", obj: "her", poss: "her" },
  "he/him": { subj: "he", obj: "him", poss: "his" },
  "they/them": { subj: "they", obj: "them", poss: "their" },
};

// "a, b, and c" - the serial comma a plain join can't produce.
function joinAnd(parts) {
  const p = parts.filter(Boolean);
  if (p.length <= 1) return p[0] || "";
  return p.slice(0, -1).join(", ") + ", and " + p[p.length - 1];
}

// How much a run may add to its doc in one night, when the caller names no
// budget. run-search.ps1 passes its own and refuses an edit well over it, so the
// number a run is told and the number it is held to come from one place; this
// default is what a prompt read without one shows.
export const DEFAULT_DOC_BUDGET_BYTES = 1000;

// How a lead's `location` is written, the same for every search. The page tiers
// a lead by matching this text against the places ranked first, and its matcher
// is tested over exactly these forms (client/src/domain/location-forms.json,
// which verify-local checks this sentence against), so a lead written any other
// way can silently lose its tier.
const LOCATION_FORMS_STEP =
  "Write each lead's `location` in one of these forms, as the posting gives it, so the " +
  "page can rank it: \"City, ST\" for a US city (\"Seattle, WA\"); \"City, Country\" " +
  "anywhere else (\"Toronto, Canada\"); \"Remote (US)\" or \"Remote (<country>)\" for a " +
  "remote role (\"Remote (Canada)\"); and several locations joined with \"; \" " +
  "(\"Seattle, WA; Remote (US)\"). Not a bare \"Remote\", and not a bare state or country: " +
  "neither says enough to rank. There is no priority field to set - the location text is it.";

const DEFAULT_SCREENED_EXAMPLES =
  '"outside scope: London, UK", "404 - closed", "duplicate of req 7829580003", "below target level"';

const DEFAULT_REPORT_LINE =
  'Report: if there are new verified postings, list each (company, title, ' +
  'location, URL) as "New today - verified live", and say whether the webpage ' +
  "sync succeeded. Mention the screened-out count too, if any. Say whether the " +
  "step-9c run record was accepted. If nothing new either way, say so plainly - " +
  "don't pad.";

// Steps 1c, 9d and 9e go to every search, even with an empty company list:
// 9d is the only step that adds a company. Cursor mechanics live in
// routes/coverage.js; 9e states only their consequence.
const COVERAGE_STEP = `1c. Get this run's companies: \`./tracker companies\`. It writes \`companies.json\` - \`{companies: [{company, last_swept, board, note}], total, batch, cursor}\` - and lists them. The server picks them, capped at what one run can actually verify. **Cover exactly these, all of them**, and don't reach past them into the rest of the list in step 3: that list is longer than one run can do properly, and the failure mode isn't a company going uncovered for a day, it's every company being skimmed. They come back round - everything is reached once per cycle before anything is reached twice. \`board\` is a JSON endpoint already confirmed for that company (\`greenhouse\`, \`ashby\`, \`workday cxs\`, ...); it makes a company cheap to cover, not privileged - use it where it's there. The cap is about *this* list: "don't reach past them" means don't help yourself to the rest of the rotation early, and step 3b sends you outside it on purpose.
`;

// 9d omits dead_signal until the warning migrations/0010 asks writers to read
// exists: the field turns one run's pattern-match into a delisting rule every
// search trusts.
//
// 9e re-fetches with a separate call after 9d, because only a recorded sweep
// moves the cursor. Reading is safe to repeat and recording marks work done,
// so a run that dies mid-way has recorded what it did or nothing.
const SWEEP_STEP = `9d. RECORD WHAT YOU COVERED. Write every company this run actually
   attempted to \`swept.json\` - a JSON array of
   \`{company, board, endpoint, url_shape, wall, note}\` - and run
   \`./tracker swept swept.json\`.

   \`endpoint\` is the reachable thing itself - a slug, host or full URL
   (\`nflcareers\`, \`wd504\`, \`https://boards-api.greenhouse.io/v1/boards/roblox/jobs\`);
   "workday cxs" saves nobody anything while the tenant slug still has to be
   guessed. \`url_shape\` is how one posting's URL is built when the endpoint
   doesn't give it (\`apply.careers.microsoft.com/careers/job/<19-digit id>\`).
   Send both whenever this run's own fetch established them - including for a
   company with no matching roles, since a fetch that worked is true either way.
   Those two and \`board\` are pooled across every search here, so saying it once
   spares everyone the same fetch; \`note\` is not, and stays on this search's row.

   **Never copy \`board\`, \`endpoint\` or \`url_shape\` out of \`companies.json\`.**
   Report one only when your own fetch against it worked tonight. A reported
   board or endpoint is taken as proof the company is reachable and clears its
   \`wall\` for every search, so echoing a known board on a night the fetch
   failed silently deletes a true wall - and the tracker cannot tell an echo
   from a confirmation.

   This is the rotation's only memory. A run that covers companies without
   recording them leaves tomorrow's run covering the same ones, and the tail of
   the list never gets searched at all. Record a company you attempted and
   *couldn't* fetch too - the date tracks when a company was last attempted,
   not when it last worked, or a blocked domain comes back to the front of the
   queue every single run. Send \`board\` whenever you confirm one: that is what
   moves a company into the every-run tier. A company not already in the list is
   created by this call, so one that broader discovery turned up joins the
   rotation here.

   Put the reason a company gave you nothing in the field it belongs to. A
   \`wall\` means **no route to this company's listings worked tonight** - not
   the careers page, not a board API, not a mirror - and it is true for anyone
   who tried those same routes: "the careers site 403s a plain fetch and no
   board endpoint answers", "an empty client-side shell, and no JSON-LD or
   board behind it". If any route to the listings worked, it is not a wall:
   report that route as \`board\` or \`endpoint\` instead. A reason that turns on
   this search - the role, the level, the location - is a \`note\`: "no
   PM-titled openings besides two Director-level reqs". A \`wall\` is pooled
   across every search, so step 4 applies before you write one: a truncated
   page, or one whose JSON-LD carries the posting, is not a wall.

9e. REPLACE THE COMPANIES YOU COULDN'T READ. Count the ones in tonight's slice
   you got nothing usable out of - the domain refused the fetch, every job id
   404'd, the board only filters client-side, the page was an empty JS shell,
   or \`companies.json\` served it with a \`wall\` so you skipped it without
   fetching. A served wall means skip its listing tonight - the tracker stops
   serving it once it goes stale, and that is the re-test. It never stops a
   specific posting URL: step 4 requires every candidate URL to be opened, so a
   posting URL for that company still gets its one direct fetch. Not the ones
   you read fine that had nothing matching: those are ordinary covered sweeps
   and by far the common case.

   If that count is more than zero, run \`./tracker companies\` again and cover
   that many companies from what comes back, then record those with 9d and
   repeat until nothing in a slice was unreadable, or until you have spent the
   effort a run should. This is a replacement for wasted work, not a licence to
   run all night. Record first, then fetch, in that order: 9d is what moves the
   cursor, so what comes back is further along the list rather than the names
   you just did, and there is nothing to filter out.

   A way into a walled listing - an ATS mirror, a JSON endpoint behind a page
   that renders nothing - is an \`endpoint\`. Report it in 9d with **no**
   \`wall\`: you have just shown the listing is readable, and that clears the
   wall for every search. A single posting page that loads while the listing
   stays walled is different - record its \`url_shape\` alongside the \`wall\`,
   not instead of it. One page loading does not make the listing readable, so
   it leaves the wall standing.
`;


/**
 * The tabs this run fills: its own, and every track whose `fed_by` names it.
 * A branched search splits one set of companies across several tabs, so one
 * run fills them all rather than each re-fetching the same boards.
 */
function tabsThisRunFills(track, feeds) {
  const fed = (Array.isArray(feeds) ? feeds : []).filter((t) => t && t.key && t.key !== track.key);
  return { fed, multi: fed.length > 0, allKeys: [track.key, ...fed.map((t) => t.key)] };
}

/**
 * What a run may add to its doc is what has no other home. A rule that
 * screens postings belongs in the config, where the prompt reads it: written
 * into the doc as well, the two copies drift and nothing says which a run
 * follows. A dated note costs every later run a read, and outlives the
 * thing it described.
 */
function docUpdateLine(track, doc, docBudget) {
  const rule =
    track.doc_update_line ||
    'If this run learned something worth keeping that has nowhere else to go - ' +
      'why a company outside the shared list was tried, and what came of it - add ' +
      `it to \`${doc}\`'s Company notes, as things stand now: correct a line in place ` +
      'rather than adding a dated note or a correction beneath it. A refinement to ' +
      "what fits or to the scope is not a doc edit: the rules that screen a posting " +
      "live in this search's config, so say it in your step-10 report for a person " +
      'to change there. A blocked domain or a working URL format is not a doc edit ' +
      'either: it is a `wall`, `endpoint` or `url_shape` in step 9d, where every ' +
      'search reads it. Do not add a found-postings table or a screened/dead-link ' +
      'list to the doc; those live in the tracker only.';
  // Said for every track, override or not: the runner holds every doc to it.
  return (
    `${rule} Add at most ${docBudget} bytes to the doc in this run - one short line per company. ` +
    'An edit far over that is not saved, and everything it added is lost.'
  );
}

/**
 * A settings list rather than track prose, so "is this company excluded?" is
 * one lookup. Entries may be a name or a catch-all phrase ("any other company
 * X owns"), so the sentence reads either way. The tracker also drops them on
 * the way in (exclude.js); this clause only saves the fetch.
 */
function exclusionNote(settings) {
  const excluded = Array.isArray(settings.excluded_companies)
    ? settings.excluded_companies.filter((c) => typeof c === "string" && c.trim())
    : [];
  return excluded.length
    ? ` Don't spend the run's time on ${joinAnd(excluded)} - permanently excluded, including via broader discovery. Skip a hit there rather than verifying it, and don't screen it either: an exclusion isn't a candidate that was considered and ruled out, so it earns no row.`
    : "";
}

/**
 * The resume is whatever this search's documents list names - the one place a
 * resume is chosen - so choosing a new one can't leave prose pointing at the
 * old file. resume_line carries only how this search frames the resume. Files
 * under resumes/ are the resume; a list with none there (a text copy kept
 * under reference/) still names what the run can read.
 */
function resumeLine(track) {
  const readableDocuments = parseDocumentList(track.documents).filter((p) =>
    READABLE_DOCUMENT_EXTENSIONS.includes(documentExtension(p))
  );
  const resumeFiles = readableDocuments.filter((p) => p.startsWith("resumes/"));
  const resumeRead = resumeFiles.length ? resumeFiles : readableDocuments;
  return resumeRead.length
    ? `Read the resume: ${joinAnd(resumeRead.map((p) => `\`${p}\``))}.${track.resume_line ? ` ${track.resume_line}` : ""}`
    : track.resume_line || "Read the resume.";
}

/**
 * Step 2b, only when a resume was chosen since this search's profile was
 * written. The profile in the doc was drawn from the old one, so a run that
 * searched first would screen tonight's postings against a person who no
 * longer exists. The rewrite is confined to one section, and
 * scripts/run-search.ps1 refuses a doc changed anywhere else - so no other doc
 * edit is asked for on the same night.
 */
function profileRefreshStep(track, doc) {
  return track.profile_stale_since
    ? `2b. THE RESUME HAS CHANGED - REWRITE THE PROFILE BEFORE YOU SEARCH. ` +
      `This search's profile in \`${doc}\` was written from ` +
      `${track.resume_was ? `\`${track.resume_was}\`` : "an earlier resume"}, and step 2's resume replaces it. ` +
      `Rewrite the section of \`${doc}\` that starts at the heading beginning \`## Candidate Profile\` and runs to the next \`## \` heading: ` +
      `the candidate profile, the best-fit roles, and anything else there drawn from the resume, from the new one. ` +
      `Keep the heading beginning \`## Candidate Profile\`, and don't name a resume file in it. ` +
      `Change nothing else in the doc tonight - every other section must come back exactly as it was, ` +
      `or the whole doc is refused and the profile stays out of date. ` +
      `So skip step 8b's other doc edits tonight and put what you would have written in your step-10 report. ` +
      `Then search against the profile you just wrote.\n`
    : "";
}

// Step 7's two categories, built from optional parts so a track with no fit
// filter leaves no empty clauses. Where a posting may be is step 5's, so both
// point back at it rather than restating it.
function findingIs(track, settings) {
  const where = hasLocations(settings) ? "somewhere step 5 says qualifies" : "";
  return joinAnd(["genuinely new", "verified live", where, track.fit_clause]);
}
function disqualifiedReasons(track, settings) {
  return [
    "dead-on-arrival",
    hasLocations(settings) ? "a location step 5 rules out" : "",
    track.fit_disqualifier,
    "wrong level",
    "duplicate of an existing lead",
  ]
    .filter(Boolean)
    .join(", ");
}

// ---- Where the search looks.
//
// Three lists and a note, as the person typed them (docs/location-settings-plan.md).
// They are printed verbatim and the run interprets them - "WA", "Greater
// Seattle area" and "Portland, OR" are all places - but how the lists combine
// is fixed here, the same for every account, so no night's model decides it.
function locationLists(settings) {
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  return {
    preferred: text(settings.priority_locations),
    searched: text(settings.search_locations),
    excluded: text(settings.excluded_locations),
    note: text(settings.location_note),
  };
}
function hasLocations(settings) {
  const { preferred, searched, excluded } = locationLists(settings);
  return Boolean(preferred || searched || excluded);
}
function geoStep(settings, name) {
  const { preferred, searched, excluded, note } = locationLists(settings);
  if (!preferred && !searched && !excluded) {
    return "WHERE THIS SEARCH LOOKS: no locations are set for this search - don't exclude a posting on location alone.";
  }
  const lines = ["WHERE THIS SEARCH LOOKS. " + name + " listed these places, exactly as typed - read each entry as the place it names:"];
  if (preferred) lines.push(`   - **Wanted first, in this order, and always searched:** ${preferred}`);
  if (searched) lines.push(`   - **Also searched:** ${searched}`);
  if (excluded) lines.push(`   - **Ruled out:** ${excluded}`);
  if (note) lines.push(`   - **In ${name}'s words:** ${note}`);
  // With no searched list, the places wanted first are the whole search; with
  // neither, only the rule-outs narrow it.
  const lastly = searched
    ? "otherwise a searched place qualifies; anywhere else is out."
    : preferred
      ? "anywhere else is out."
      : "anywhere else qualifies.";
  const reachable = searched || preferred ? "a place that qualifies" : "a place not ruled out";
  lines.push(
    "",
    "   Decide each posting's location in this order, and stop at the first that applies: a place wanted first always qualifies, even if another list says otherwise; otherwise a place ruled out is out; " +
      lastly +
      " A posting listing several locations qualifies when any one of them does.",
    `   A remote role qualifies when it is open to someone in ${reachable}, and is out when it is restricted to a region or time zone that doesn't include one. An on-site or hybrid role somewhere that doesn't qualify is out, and never assume ${name} will relocate${note ? ` unless ${name}'s own words above say so` : ""}.`
  );
  return lines.join("\n");
}

// Step 9's `area`: which of the places ranked first a lead falls in, since the
// page tiers by it (docs/location-settings-plan.md, "Each lead carries its
// area"). The run judges it; tracker.ps1 and the leads route keep it only when
// it equals an entry, ignoring case, so the wording asks for a copy, never a
// paraphrase. A person with nothing ranked gets no area at all.
function areaStep(settings, name) {
  const ranked = typeof settings.priority_locations === "string" ? settings.priority_locations.trim() : "";
  if (!ranked) return { areaKey: "", areaRule: "" };
  return {
    areaKey: ", area",
    areaRule:
      ` \`area\` is the one place ${name} ranked first that the posting falls in - one entry from "${ranked}", ` +
      "copied as written - or leave it out when the posting falls in none of them. The posting's real " +
      "location stays in `location`; `area` only files it, and anything but one of those entries is dropped.",
  };
}

// ---- Multi-tab fragments: empty for a single-tab run unless noted.

function alsoFillsHeader({ fed, multi, allKeys }) {
  return multi
    ? `\n# Also fills: ${fed.map((t) => `${t.key} (${t.label})`).join(", ")} - one search, ${allKeys.length} tabs`
    : "";
}

// `./tracker dedup` fetches and merges every fed tab itself; the run only
// needs telling how to read the merged result.
function dedupNote({ multi, allKeys }) {
  return multi
    ? ` It covers all ${allKeys.length} tabs this run fills (${allKeys.join(", ")}) and merges them: a posting already tracked under any of them is not new, whichever tab tonight's run would file it under.`
    : "";
}

/**
 * Step 7b. After step 7, because only findings need a tab. A tie goes to the
 * first listed tab among those the posting reads as, never to the track's own
 * key by default: that is just the tab that owns the scheduled search, which
 * may be the narrowest one. Each tab is described with its page subtitle, so
 * the two can't drift.
 */
function filingStep(track, { fed, multi, allKeys }, doc) {
  const key = track.key;
  const branchOf = (t) => t.full_description || t.label;
  return multi
    ? `7b. FILE EACH FINDING UNDER THE RIGHT TAB. This one search fills ${allKeys.length} tabs, and every finding from step 7 belongs to exactly one of them:\n${[track, ...fed]
        .map((t) => `   - \`${t.key}\` (${t.label}): ${branchOf(t)}`)
        .join("\n")}\n   Decide from what the posting and the company actually are, reading the tab descriptions above as written - not from a job title alone, which means different things at different companies. \`${doc}\` is where any finer rule for this split lives; follow it. If a posting genuinely reads more than one way after checking, file it under whichever of *those* tabs comes first in the list above, and name those ones in your report. The tie is only ever between the tabs it actually reads as: a tab you have already ruled out is never the answer, and that includes \`${key}\` - the tab that happens to own this search, which is not a reason for a posting to show up in it. Don't spend a second verification pass on the question: the posting is already verified, this only decides which tab shows it. The answer is the \`"search"\` value in step 9.\n`
    : "";
}

// Not empty for a single tab: tracker.ps1 stamps `search` from TRACKER_SEARCH,
// so there is no key to choose.
function searchValueRule({ multi, allKeys }) {
  return multi
    ? `is the key step 7b filed that posting under - ${allKeys
        .map((k) => `\`"${k}"\``)
        .join(" or ")}; one file can carry rows for several tabs`
    : `is stamped by the helper`;
}

// The tracker matches a url against every lead the person has, whatever tab
// holds it (db.getLeadsForUrlMatch). Unsaid, a multi-tab run invents one
// call per tab.
function delistTabNote({ multi, allKeys }, name) {
  return multi
    ? ` One file each covers all ${allKeys.length} tabs: the tracker matches a url against every lead ${name} has, whatever tab holds it.`
    : "";
}

// 9c sends no counts: POST /api/runs derives them from the rows that landed
// and writes each fed tab's record too (routes/runs.js).
function runFanoutNote({ fed, multi }) {
  return multi
    ? ` One call covers every tab this run fills: the tracker writes a record for ${fed
        .map((t) => `\`${t.key}\``)
        .join(", ")} too, counted from the rows that landed in each. Don't run it once per tab.`
    : "";
}

/**
 * @param {{user: {id: string, name: string}, track: import("./db.js").Track, settings: import("./db.js").Settings, feeds?: import("./db.js").Track[], docBudget?: number}} args
 * @param {import("./db.js").Track[]} [args.feeds] tracks whose `fed_by` names
 *   this one - tabs this run also fills. See docs/glossary.md#searches-and-tracks.
 * @param {number} [args.docBudget] bytes step 8b says a run may add to its doc.
 * @returns {string} the full prompt text
 */
export function buildSearchPrompt({ user, track, settings, feeds, docBudget = DEFAULT_DOC_BUDGET_BYTES }) {
  const name = user.name;
  const pn = PRONOUNS[settings.pronouns] || PRONOUNS["they/them"];
  const key = track.key;
  const tabs = tabsThisRunFills(track, feeds);
  const { multi } = tabs;

  const doc = track.doc_file || `docs/tracked_${key}_postings.md`;
  const docSummary =
    track.doc_summary ||
    "candidate profile, what this search is looking for, how to weigh fit, and notes on companies tried";
  // Runs into "Do the following:" as one paragraph: a track's note reads as
  // preamble, not as a heading.
  const intro = track.intro_note ? `${track.intro_note} ` : "";
  // Extends step 9's `"search"` sentence for a track where an optional lead
  // field is required (e.g. `fit` on a career-pivot search).
  const leadsNote = track.leads_note ? `, and ${track.leads_note}` : "";

  // A track's own screening step pushes the capture step from 6b to 6c. The
  // number is computed because step 9 refers back to it ("the step-6b fields").
  const fitFilterStep = track.fit_filter_step ? `6b. ${track.fit_filter_step}\n` : "";
  const captureNum = track.fit_filter_step ? "6c" : "6b";

  // A search has no company list of its own. It covers the step-1c slice of the
  // one shared list and finds new employers in step 3b; a list kept per search
  // becomes a fixed set swept every night on top of the slice, which is what
  // makes a run long. target_companies may still hold one in D1; it is not read.
  const searchNote = track.search_note ? ` ${track.search_note}` : "";
  const roleLine = track.role_search_line || "roles matching the resume";

  const screenedExamples = track.screened_examples || DEFAULT_SCREENED_EXAMPLES;
  const report = track.report_line || DEFAULT_REPORT_LINE;
  const footer = settings.footer_note ? ` ${settings.footer_note}` : "";

  // The fragments that depend on this track, settings or tabs, each built by a
  // function above.
  const alsoFills = alsoFillsHeader(tabs);
  const docUpdate = docUpdateLine(track, doc, docBudget);
  const exclusion = exclusionNote(settings);
  const resume = resumeLine(track);
  const profileRefresh = profileRefreshStep(track, doc);
  const finding = findingIs(track, settings);
  const disqualified = disqualifiedReasons(track, settings);
  const geo = geoStep(settings, name);
  const dedup = dedupNote(tabs);
  const filing = filingStep(track, tabs, doc);
  const searchValue = searchValueRule(tabs);
  const delistTab = delistTabNote(tabs, name);
  const runFanout = runFanoutNote(tabs);
  const { areaKey, areaRule } = areaStep(settings, name);

  // Step 3b sends discoveries to 9d because a company written into the doc
  // never reaches the rotation, and a search left with only its original
  // companies runs dry. Step 4's truncated-vs-blocked rule stays because a
  // large page cut off before the description is a size problem, not a wall.
  return `# Scheduled task: ${track.label} - ${track.full_description}
# Schedule: ${track.schedule_time || "unscheduled"} local (headless, via Windows Task Scheduler + scripts\\run-search.ps1)
# Track key in the tracker data: ${key}${alsoFills}
# ---------------------------------------------------------------------------

Everything this run sends to the tracker goes through \`./tracker\`, a command
in this directory that the steps below name. It builds each call, stamps this
track's key and today's local date on every row, prints one line saying what
the tracker accepted, and exits non-zero on failure - report a failure plainly
rather than retrying around it. Where a step writes a file for it, write \`[]\`
and run the command anyway when there's nothing to send. (If \`./tracker\` won't
execute: \`powershell -NoProfile -ExecutionPolicy Bypass -File tracker.ps1\`,
same arguments.)

${intro}Do the following:

1. Read \`${doc}\` - ${docSummary}. Follow its numbered process. The doc doesn't keep a found-postings table or a screened/dead-link list - dedup data comes from step 1b instead.
1b. Fetch what this track has already seen: \`./tracker dedup\`. It writes \`dedup.json\`: \`leads[]\` as \`{url, status}\`, with \`recheck: true\` on the ones due a re-check tonight - postings already tracked, where \`url\` is what step 8 reports back and \`status\` is context for your report (that's how you tell a stale lead nobody's touched from one ${name} has already applied to) - and \`screened[]\`, urls already looked at and rejected at tonight's companies or in the last few days, which is what stops you re-verifying the same dead or out-of-scope candidate. Older rejections at other companies aren't in it; if you verify one of those and report it, the tracker recognises it, so it costs a check and never a duplicate.${dedup}
${COVERAGE_STEP}2. ${resume}
${profileRefresh}3. Search the step-1c companies' careers sites (web search as backup) for current ${roleLine}.${searchNote}${exclusion}
3b. NOW LOOK OUTSIDE THAT LIST. Step 3 is the companies already known to be worth checking; this step is how that list ever grows, and it is not optional. Search for ${roleLine} at companies **not already on the shared list** - including outside tech entirely: travel, insurance, hotels, food service, grocery and retail, healthcare systems, logistics, banking, utilities, manufacturing, and sports (leagues and the larger franchises, plus the data, streaming and betting companies built around them). All of them run real engineering orgs and all of them are easy to miss when the named list reads as big tech. Rotate through a couple of verticals per run rather than attempting all of them.

   **Check each company before you spend anything on it: \`./tracker known "<company>"\`.** Tonight's slice is a small part of the list, and another search may have added a company earlier tonight. If it says the company is on the list, skip it - its turn comes in the rotation.

   Every candidate this turns up faces the same mandatory verification in step 4 - a company being new is not a reason to trust a search snippet about it.

   **A company you find here joins the rotation in step 9d, or tonight is the last time it is ever looked at.** Record it with the others as soon as it yields a verified posting, whether that posting became a lead or was screened: either way you have established the company is worth a look. The rotation is the only list a future run reads, and writing a name into the doc's prose instead does nothing.

   Say in your step-10 report how many companies outside the list you tried and what came of them, even when the answer is none and nothing. A run that quietly skips this looks exactly like a run where the market was quiet, which is the confusion the whole tracker exists to prevent.
4. MANDATORY VERIFICATION: fetch every candidate URL directly and confirm it renders an actual job description (real title, responsibilities/qualifications - not a landing page, 404, "job not found," a loading placeholder, or a listing/index page that merely contains the title text). A search-snippet URL is a lead, not a finding, until opened and confirmed. If a site won't reveal real content, skip that company today rather than report something unverified.

   **Before you write a domain off as a wall, check what the HTML actually carried.** Three things survive on a page whose body renders client-side, and each is the page stating something rather than you inferring it: a \`JobPosting\` block in \`<script type="application/ld+json">\` (Ashby, Greenhouse, Lever, Workday and iCIMS all emit one - \`title\`, \`hiringOrganization\`, \`jobLocation\`, \`employmentType\`, \`baseSalary\`, usually the whole description); \`og:title\` / \`og:description\` meta tags; and the \`<title>\` tag. A JSON-LD \`JobPosting\` carrying a real description **is** the job description rendering - the same document in machine-readable form - so verify from it rather than calling the posting unconfirmable. A \`<title>\` naming no role ("Careers", "Job Board") states nothing, and an \`ItemList\` is a listing page, not a posting.

   **And tell a truncated page apart from an empty one.** A fetch that returned a megabyte of navigation and got cut off before the description is a size problem, not a block - the content is there, and the workaround for that domain (a reader-proxy, an ATS JSON endpoint, a different URL format) goes in step 9d as an \`endpoint\` or \`url_shape\`. Recording "truncated" as "blocked" is how a company that is perfectly readable ends up skipped for weeks.
5. ${geo}
6. ${LOCATION_FORMS_STEP}
${fitFilterStep}${captureNum}. While the posting is open, also capture - only when it's stated plainly, never inferred or guessed - the team/org named for the role (\`team\`), the stated work arrangement (\`setup\`, e.g. "Remote", "Hybrid - 3 days/week onsite", "Onsite"), and any posted compensation range (\`comp\`, e.g. "$180,000-$230,000/yr"; many US states disclose this by law). Leave any of these as an empty string when the posting doesn't say. These land in the tracker's per-lead "Details" panel alongside referral/resume/next-action fields that are ${name}'s alone to fill in by hand - this search never touches those.
7. Compare candidate URLs against \`leads[]\` and \`screened[]\` from step 1b (not a doc table). Sort each candidate into: (a) already tracked or already screened - skip it; (b) ${finding} - a finding, goes to step 9; (c) genuinely new but disqualified (${disqualified}) - goes to step 9b instead of being dropped silently.
${filing}8. RE-CHECK THE LEADS DUE TONIGHT, AND REPORT WHAT YOU FOUND. Open every lead step 1b marked \`recheck: true\`, and only those: the tracker picks them, longest-unconfirmed first, so every lead gets its turn without any run re-checking the whole list. If none are marked, there is nothing to re-check tonight. A tracked posting you happen to open for another reason can be reported too. For the postings you re-checked, **never delete or move anything yourself** - report what you saw and let the tracker decide what to do with it. Both reports are a JSON array of the urls you actually opened; send the URL you opened rather than matching it against step 1b's spelling first, because the tracker matches on posting identity, so a \`?gh_jid=\` suffix, a tracking param or a missing slug still finds the right lead.${delistTab}

   - **Still live**: write them to \`live.json\`, then \`./tracker verified live.json\`. This is the only thing in the whole system that writes a lead's "Confirmed live" date, and that date is the only measure of how long a lead still sitting in a tab has been presumed live. It changes nothing else, so being honest about which ones you actually opened is the whole of it.
   - **Confirmed dead**: write them to \`dead.json\`, then \`./tracker delist dead.json\`. Don't also screen these - this one report is the whole of it. List a dead posting whatever \`status\` its lead is in; the tracker keeps ${name}'s applied-to leads and reports them back as \`kept\`.

   **There is no undoing the delist report.** A removed lead's row is gone and its URL is screened from then on, so step 7 skips it for good: if the posting turns out to be live after all, no future run puts it back.

   **So only list a posting you have actually confirmed dead** - a page that loads and says the role is closed or filled, or a genuine 404. Not being able to check is not the same as dead: a fetch timeout, a blocked domain, a 403/429, truncated content, or a JS shell that renders nothing all mean *unknown*, and an unknown belongs in **neither** file - it leaves the lead exactly as it is while you note the tooling problem in your report. Reporting a live posting as dead takes a real opening off ${pn.poss} board. When in doubt, leave it out of both and say so.

   A url reported back as unmatched means you believe you're tracking something the tracker has no lead for - report that plainly rather than retrying it.
8b. ${docUpdate}
9. SYNC NEW POSTINGS TO THE LIVE TRACKER WEBPAGE. Write today's new verified
   postings to \`leads.json\` - a JSON array of
   \`{company, title, location, url, fit, team, setup, comp${areaKey}}\` - then run
   \`./tracker leads leads.json\`. \`team\`, \`setup\` and \`comp\` are the
   step-${captureNum} fields; leave a key out entirely for anything the posting
   didn't state.${areaRule} Every row's \`"search"\` ${searchValue}${leadsNote}.
9b. RECORD SCREENED-OUT CANDIDATES so tomorrow's run doesn't re-verify them.
   Write the disqualified-but-new candidates from step 7 to \`screened.json\` -
   \`{url, company, title, location, reason}\` - then run
   \`./tracker screened screened.json\`. \`reason\` is a short, specific,
   human-readable explanation (e.g. ${screenedExamples}); it is what makes the
   entry useful later, so don't leave it vague.
9c. RECORD THE RUN: \`./tracker run --status ok --note "one short line for the webpage"\`
   (e.g. \`--note "no new postings; 34 screened out"\`).

   **Do this every single run, without exception** - including runs that found
   nothing, runs where every candidate was screened out, and runs where steps
   8/9/9b sent nothing or failed. It is the one step with no skip clause,
   because a run that finds nothing writes nothing anywhere else. Without it a
   search that has quietly stopped (expired token, disabled scheduled task,
   machine asleep) looks exactly like a quiet night on the webpage, and can go
   unnoticed for weeks.${runFanout}

   Send \`--status error\` instead if the run couldn't do its job properly - the
   tracker unreachable, search or fetch tooling failing broadly enough that the
   zero result isn't trustworthy, a required file missing - and put the reason
   in the note. A wrongly-cheerful "ok" is worse than no record at all: it's
   what stops the webpage flagging a search that has quietly broken.

   Send no counts: the tracker derives them from what steps 8, 9
   and 9b wrote${multi ? ", per tab and from that tab's own rows" : ""}.
${SWEEP_STEP}10. ${report}

Never add an unverified link to any output.${footer}
`;
}

/**
 * The nightly fill for applications added as nothing but a URL. It is not a
 * search - no companies, fit rule or scope - so it is a separate prompt.
 *
 * Served as the reserved key `_applications` under GET /api/prompt (see
 * routes/index.js) and run once per machine by scripts/run-fill.ps1, which
 * hands the model one bearer token per account. So it takes no user.
 *
 * Subagents get a URL only, so every write stays in the main turn under the
 * right account's token. No run record, by design (see server/README.md).
 *
 * @returns {string} the full prompt text - the same for every caller
 */
export function buildAutofillPrompt() {
  return `# Scheduled task: fill in applications added by URL
# Schedule: nightly (headless, via Windows Task Scheduler + scripts\\run-fill.ps1)
# ---------------------------------------------------------------------------

People log an application on the tracker page by pasting the job posting's URL
and nothing else. Your whole job is to open those postings and write down what
they say, so that nobody has to copy company, title and location off a page by
hand. You are not searching for anything tonight, and you are not judging
whether any of these are a good fit - they have already been applied to.

None of this is visible on anyone's tracker page while it happens, and each
posting is read once and never again. So the standard you are held to is not
"did it look like it worked" - it is that whatever you write down is what the
posting actually said.

The one exception, and the only thing here anybody ever reads: a posting you
report as unreadable shows the reason you gave, on that row. See step 3.

**This run covers every account on this machine.** The note above this prompt
says how many there are and which environment variable holds each one's token
(\`$TRACKER_TOKEN_1\`, \`$TRACKER_TOKEN_2\`, ...). Do steps 1-3 once per account,
finishing one before starting the next. Ids are per account and mean different
rows in different accounts, so never carry an id from one account's queue into
another's report - that is the one mistake here that would write a posting's
details onto somebody else's application.

Do the following, for each account in turn:

1. GET THAT ACCOUNT'S QUEUE - the same call for each, with that account's token:

   \`\`\`
   curl -s "$TRACKER_URL/api/applications/pending" -H "Authorization: Bearer $TRACKER_TOKEN_1"
   \`\`\`

   It returns \`{"applications":[{"id":123,"link":"https://..."}]}\` - every
   application whose posting hasn't been read yet, with the URL to read and
   nothing else. The tracker decides what is on this list; don't go looking for
   other applications to fill in, and don't skip one because its URL looks
   unpromising.
   \`TRACKER_URL\` and the token variables are environment variables; run the
   curl as written and let the shell expand them rather than spending a step
   checking whether they're set, and never print or echo a token.

   **An empty list is the normal answer.** Most accounts on most nights have
   nothing waiting. Say so in one line and move to the next account; when every
   account is empty that is the whole run, and it is not a problem to
   investigate.

   For an account with anything waiting, also read the places it ranked first,
   for step 3's \`area\`:

   \`\`\`
   curl -s "$TRACKER_URL/api/config" -H "Authorization: Bearer $TRACKER_TOKEN_1"
   \`\`\`

   \`settings.priority_locations\` is that list, as the person typed it,
   comma-separated - "Seattle area, Portland OR, Remote US". Empty means they
   ranked nothing.

   Collect every account's list before going on to step 2, keeping each row's
   account alongside its \`id\`, \`link\` and that account's ranked places. Step 2
   reads them all together.

2. FAN THE READING OUT. Postings are slow to fetch and completely independent
   of each other, so **dispatch one subagent per posting and let them run in
   parallel** rather than opening them one after another yourself. Send them in
   batches of about ten so a long queue doesn't spawn dozens of agents at once,
   and wait for each batch before sending the next.

   Give each subagent exactly one URL and this brief, near enough word for
   word - it is the whole of what makes the result trustworthy, and a subagent
   only knows what you tell it:

   > Fetch this URL and report what the job posting *states*, as JSON with
   > these keys, omitting any key the page does not state plainly:
   > \`company\` (the employer's name as the posting gives it), \`title\` (the
   > role title), \`location\` (as posted - "Seattle, WA", "Remote (U.S.)",
   > "London, UK"), \`team\` (the team or org named for the role), \`setup\`
   > (the stated work arrangement - "Remote", "Hybrid - 3 days/week onsite",
   > "Onsite"), \`comp\` (any posted compensation range -
   > "$180,000-$230,000/yr").
   >
   > **Never infer, complete or tidy up any of these.** Not the company from
   > the domain name, not the location from an office you know the company
   > has, not a title from the URL slug. This is somebody's record of a job
   > they really applied to, and a plausible guess in it is worse than a blank
   > field: a blank field is visibly still to be filled in, while a wrong
   > company reads as fact forever. Omit a key entirely rather than returning
   > an empty string or a placeholder.
   >
   > Read the page itself. Don't web-search for the role to fill in what the
   > posting didn't say.
   >
   > **A body that needs JavaScript is not an unreadable page.** Modern job
   > boards render the description client-side but still ship the facts in the
   > HTML you already have, and that is the page stating them, not you guessing:
   >
   > - a \`JobPosting\` block in \`<script type="application/ld+json">\` -
   >   \`title\`, \`hiringOrganization\`, \`jobLocation\` / \`locationName\`,
   >   \`employmentType\`, \`baseSalary\`. Check for this first on any board that
   >   looks empty; Ashby, Greenhouse, Lever and Workday all emit one.
   > - \`og:title\` / \`og:description\` meta tags.
   > - the \`<title>\` tag, which on these boards is usually
   >   "Role Title @ Company" or "Role Title - Company".
   >
   > A \`<title>\` that names no role - "Careers", "Jobs at Acme", "Job Board" -
   > states nothing; don't read a role out of it. But one that plainly gives
   > the role and the employer has given you \`title\` and \`company\`.
   >
   > **A closed posting is still a posting.** "This job has been closed", "no
   > longer accepting applications", an expired-listing banner - if the page
   > still says what the role was, report it exactly as you would a live one.
   > Whether the listing outlived the application is beside the point here:
   > this is the record of a job somebody already applied to, not a check on
   > whether it is still open. Say it was closed in \`note\`, and fill in
   > everything the page still states. Only a closed page that has stopped
   > showing the details is a \`failed\`.
   >
   > **Partial is wanted.** Return every key you could establish, whatever you
   > could not - two fields beat none, and a field the person doesn't have to
   > type is worth having on its own. When you got some of it but not all,
   > add a \`"note"\` key saying in one short sentence what you couldn't read
   > and why, alongside the fields: e.g.
   > \`{"company":"...","title":"...","note":"the description needs JavaScript,
   > so only the page metadata was readable - no location or pay stated there"}\`.
   >
   > Use \`{"failed":"<short, specific reason in plain words>"}\` **only when you
   > established nothing at all** - it 404s, the posting has been taken down or
   > filled, it is behind a login wall or a CAPTCHA, the domain refused the
   > fetch, or the HTML carried no metadata either.
   >
   > **\`note\` and \`failed\` are both shown to the person whose application it
   > is**, on that row, so write them for them: say what you actually hit. Not
   > being able to check is not the same as the posting being gone, and they
   > need to know which it was - one means the details are gone, the other
   > means the page is sitting there and only you couldn't have it.

   Do not give a subagent a token, an account, an id, or anything to POST.
   They read one page and hand back what it said; every write in this run is
   yours to make, with the right account's token, in step 3. Keep your own note
   of which account and \`id\` each dispatched URL belongs to - the subagent
   never sees either, so nothing it returns can put a posting's details onto
   the wrong row.

   These subagents run inside this same turn and you wait for their results.
   That is the difference between this and backgrounding work, which the note
   at the top of this prompt rules out: nothing here outlives your turn.

3. REPORT WHAT THEY READ - one call per account, not one per row, and with that
   same account's token:

   \`\`\`
   curl -s -X POST "$TRACKER_URL/api/applications/autofill" \\
     -H "Authorization: Bearer $TRACKER_TOKEN_1" -H "Content-Type: application/json" \\
     -d '{"filled":[{"id":123,"company":"...","title":"...","location":"...","team":"...","setup":"...","comp":"...","area":"..."}],
          "failed":[{"id":456,"reason":"posting has been taken down"}]}'
   \`\`\`

   Pair each subagent's answer back up with the account and \`id\` you dispatched
   it for, and send each account's rows with that account's token. \`id\` is the
   id from that account's step 1, unchanged. Send both lists in the one call;
   either may be omitted if it's empty. A \`filled\` row may carry a \`"note"\`
   alongside its fields - pass through whatever \`note\` the subagent returned,
   unchanged.

   **Add \`area\` yourself**, not from the subagent: when a row's \`location\`
   falls in one of that account's ranked places, set \`area\` to that entry,
   copied as written from its list; otherwise leave \`area\` out. It files the
   application under the place the person ranked, while \`location\` stays as the
   posting gave it. The tracker keeps it only when it is one of that account's
   entries, so another account's place, or a near-miss like "Seattle" for
   "Seattle area", is simply dropped.

   **Anything a subagent established goes in \`filled\`, even one field.** Only a
   subagent that came back with \`failed\` - nothing established at all - goes in
   \`failed\`. A partial read is a result, not a failure: every field there is one
   the person doesn't have to type.

   Pass \`note\` and \`failed\` reasons through as the subagent wrote them rather
   than summarising, because **both are shown to the person on that row** -
   they are the only thing this whole job ever says on their page. A note
   explains why a filled-in row is still missing something; a \`failed\` reason
   explains why a row is blank and going to stay that way, since nothing
   retries it. Both have to be specific and true: "the posting has been taken
   down" and "the domain blocks automated fetches" ask completely different
   things of the reader. A vague one is worse than none, and a wrong one sends
   them looking for a page that is fine.

   Report every id every account gave you, in one list or the other. An id you
   report in neither comes back tomorrow night and every night after, which is
   the one outcome this is built to avoid - so a subagent that returned nothing
   usable at all, or that you never got an answer from, still gets a \`failed\`
   entry saying so.

   Nothing here overwrites anything. The tracker only writes into fields that
   are still empty, so if the person filled some of them in during the day,
   their version stays and yours is dropped. Send what came back and don't try
   to work out what is already in the row - you were not told, and that is
   deliberate.

   The response is \`{"filled":N,"failed":N,"unmatched":[id,...],"area_cleared":N}\`.
   \`area_cleared\` counts areas that matched none of that account's ranked places
   and were dropped; say so in your report when it isn't 0. An id in
   \`unmatched\` means that row was dealt with or deleted between step 1 and
   now - ordinary, and nothing to retry or work around.

4. Report in a few lines **per account**, naming which account each line is
   about: how many postings it gave you, what got filled in for each (company
   and title is enough), and every one that couldn't be read with the reason
   you sent. Nobody reads this in the normal course of things - it is the log
   someone checks when a row stayed blank - so be accurate rather than
   reassuring, and don't pad an account that had nothing.
`;
}
