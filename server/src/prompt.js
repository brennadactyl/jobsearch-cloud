/**
 * Composes one track's daily search prompt from its D1 config, served by
 * GET /api/prompt/:key and run by scripts/run-search.ps1.
 *
 * This replaces the per-track prompt files that used to live in each
 * installer's private data folder (and the skill template that generated
 * them). Two reasons it moved here:
 *
 * 1. Steps 1b/8/9/9b/9c are this API's own calling convention. They were
 *    byte-identical across every hand-maintained copy, and a copy that
 *    silently lacked 9c was a real, documented failure mode - the run record
 *    is the only thing that distinguishes "searched, found nothing" from
 *    "stopped running weeks ago". They now have exactly one definition, in
 *    the same repo as the routes they call.
 * 2. A search is now defined by (user_id, track key) in the database, not by
 *    a file on one particular machine, which is what lets one machine run
 *    several people's searches - and what lets a search be reconfigured
 *    without touching that machine at all.
 *
 * ---- Why those steps now name a command instead of describing a call.
 * The calling convention having one definition did not stop it being expensive
 * to state: the six HTTP calls a run makes came to about 15,000 characters,
 * half of the composed prompt, paid by four scheduled runs a night to describe
 * something that never changes. Worse, most of it was prose asking for what
 * only code can guarantee - "`search` must be this run's own key", "`on` is
 * today's *local* date", "report by url, never by id", "omit the key rather
 * than sending an empty string". Each has exactly one right answer, and each
 * was restated nightly in the hope the model applied it.
 *
 * scripts/tracker.ps1 decides all of them now, from the run's own environment,
 * and run-search.ps1 materializes it into the working directory beside the
 * documents. So the steps below name a command (`./tracker leads leads.json`)
 * and say only what the run alone knows: which postings are new, which it
 * confirmed dead, which companies it managed to read. See
 * docs/prompt-size-plan.md.
 *
 * ---- Why the rationale for a rule lives here and not in the text.
 * A lot of what used to be emitted explained why a rule exists: what went
 * wrong on a particular date, what an earlier approach got wrong, what the
 * failure looked like on the page. That is maintenance context for whoever
 * edits this file, and it is kept - in the comments around each piece below,
 * where it is read by the person who might undo the rule. What reaches the
 * model is the operative sentence. The exception is step 4's verification
 * requirement, which is stated at whatever length it takes: it is the premise
 * the whole system rests on, and it is the first thing a shortened prompt is
 * tempted to soften.
 *
 * ---- Why so much of this is stored prose rather than structured fields.
 * The live prompts had drifted from the template that generated them, and the
 * drift was load-bearing: a resume line naming a text fallback the machine
 * genuinely depends on (it can't read .docx), a sentence widening a company
 * list beyond its apparent industry, doc filenames predating the current
 * naming convention, worked examples of what counts as out-of-scope. Store a
 * keyword and regenerate the sentence, and all of that is silently gone. So
 * only the fields the *app* reads are structured (key, label, sort_order,
 * schedule_time, target_companies); everything only the model reads is kept
 * verbatim and interpolated as-is. See docs/multi-user-plan.md's appendix.
 */

// Subject pronoun for the sentences that refer to the person whose search this
// is. Defaults to they/them for anyone who hasn't set one - which is also the
// right answer for a name the server has no other information about.
const PRONOUNS = {
  "she/her": { subj: "she", obj: "her", poss: "her" },
  "he/him": { subj: "he", obj: "him", poss: "his" },
  "they/them": { subj: "they", obj: "them", poss: "their" },
};

// "a, b, and c" - the phrasing the live step 7 uses at both three and four
// items, which is why this isn't a plain join.
function joinAnd(parts) {
  const p = parts.filter(Boolean);
  if (p.length <= 1) return p[0] || "";
  return p.slice(0, -1).join(", ") + ", and " + p[p.length - 1];
}

const DEFAULT_LOCATION_GUIDANCE =
  "Write accurate location strings - the tracker derives priority from them " +
  "automatically, so precision matters. There is no priority field to set - " +
  "just get the location text right.";

const DEFAULT_SCREENED_EXAMPLES =
  '"outside scope: London, UK", "404 - closed", "duplicate of req 7829580003", "below target level"';

const DEFAULT_REPORT_LINE =
  'Report: if there are new verified postings, list each (company, title, ' +
  'location, URL) as "New today - verified live", and say whether the webpage ' +
  "sync succeeded. Mention the screened-out count too, if any. Say whether the " +
  "step-9c run record was accepted. If nothing new either way, say so plainly - " +
  "don't pad.";

/**
 * @param {{user: {id: string, name: string}, track: import("./db.js").Track, settings: import("./db.js").Settings, feeds?: import("./db.js").Track[]}} args
 * @param {import("./db.js").Track[]} [args.feeds] tracks whose `fed_by` names
 *   this one - tabs this run also fills. See migrations/0003_branched_tracks.sql.
 * @returns {string} the full prompt text
 */
export function buildSearchPrompt({ user, track, settings, feeds }) {
  const name = user.name;
  const pn = PRONOUNS[settings.pronouns] || PRONOUNS["they/them"];
  const key = track.key;

  // The other tabs this one run fills. A branched search - one set of
  // companies, one resume, results split by level rather than by search - is
  // the case this exists for: running it twice would re-fetch the same job
  // boards to sort the same postings differently. Empty for an ordinary
  // single-tab track, and every branch below collapses back to the text it had
  // before this existed when it is.
  const fed = (Array.isArray(feeds) ? feeds : []).filter((t) => t && t.key && t.key !== key);
  const multi = fed.length > 0;
  const allKeys = [key, ...fed.map((t) => t.key)];
  // What belongs in each tab, for the filing step. That's what a tab's
  // subtitle already is, so it does double duty rather than earning a field of
  // its own - which also means the two can't drift apart.
  const branchOf = (t) => t.full_description || t.label;

  const doc = track.doc_file || `docs/tracked_${key}_postings.md`;
  const docSummary =
    track.doc_summary ||
    "candidate profile, target companies, verification requirement, and per-company fetch-reliability notes";
  // Runs straight into "Do the following:" as one paragraph, the way the
  // hand-written prompts did - a track's "this is not the sibling searches,
  // don't merge them" note reads as preamble, not as a heading.
  const intro = track.intro_note ? `${track.intro_note} ` : "";
  // An extra clause on step 9's "search must be X" sentence, for a track where
  // one of the optional lead fields isn't optional (CPM's `fit`, which is the
  // whole question for a pivot search).
  const leadsNote = track.leads_note ? `, and ${track.leads_note}` : "";

  // A track can insert a whole screening step of its own before the capture
  // step - which pushes the capture step from 6b to 6c. The number has to be
  // computed rather than written down, because step 9 refers back to it by
  // name ("the step-6b fields"), and a cross-reference that says 6b while the
  // step is numbered 6c is worse than no cross-reference at all.
  const fitFilterStep = track.fit_filter_step ? `6b. ${track.fit_filter_step}\n` : "";
  const captureNum = track.fit_filter_step ? "6c" : "6b";

  const docUpdateLine =
    track.doc_update_line ||
    'If you learned something worth keeping about this search - a company ' +
      'worth promoting from "expanded net" to "core" - update the relevant ' +
      `section of \`${doc}\`. A blocked domain or a working URL format is not a ` +
      "doc edit: it is a `wall`, `endpoint` or `url_shape` in step 9d, where every " +
      "search reads it. Do not add a found-postings table or a screened/dead-link " +
      "list back to the doc; those live in the tracker only.";

  let companies = "";
  try {
    const parsed = JSON.parse(track.target_companies || "[]");
    companies = Array.isArray(parsed) ? parsed.join(", ") : String(track.target_companies || "");
  } catch {
    // Stored by hand as a plain string rather than JSON - use it as written
    // rather than losing the whole company list to a parse error.
    companies = String(track.target_companies || "");
  }
  const searchNote = track.search_note ? ` ${track.search_note}` : "";

  // Companies this person won't work for, rendered from a list rather than
  // written into each track's prose. The prose version drifted immediately:
  // one exclusion ended up inside target_companies and the next inside
  // search_note, so answering "is this company excluded?" meant grepping two
  // free-text fields and knowing which one to look in. A list is a lookup, and
  // adding one is an append. Entries can be a plain name or a catch-all phrase
  // ("any other company X owns or leads"), so the sentence reads either way.
  const excluded = Array.isArray(settings.excluded_companies)
    ? settings.excluded_companies.filter((c) => typeof c === "string" && c.trim())
    : [];
  //
  // The last sentence used to say the tracker drops these on the way in
  // regardless, so this is here to save the fetch rather than to be the thing
  // enforcing it. True, and the reason the clause can stay this short - but it
  // is a fact about the server, which is where it now lives (see exclude.js).
  const exclusionNote = excluded.length
    ? ` Don't spend the run's time on ${joinAnd(excluded)} - permanently excluded, including via broader discovery. Skip a hit there rather than verifying it, and don't screen it either: an exclusion isn't a candidate that was considered and ruled out, so it earns no row.`
    : "";

  const resumeLine = track.resume_line || "Read the resume.";
  const roleLine = track.role_search_line || "roles matching the resume";

  // What makes a candidate a finding, and the mirror list of what disqualifies
  // one. Both are assembled from parts so a track with no fit filter and no
  // geographic scope reads naturally instead of leaving empty clauses behind.
  const findingIs = joinAnd([
    "genuinely new",
    "verified live",
    settings.scope_clause,
    track.fit_clause,
  ]);
  const disqualified = [
    "dead-on-arrival",
    settings.scope_disqualifier,
    track.fit_disqualifier,
    "wrong level",
    "duplicate of an existing lead",
  ]
    .filter(Boolean)
    .join(", ");

  const geoStep = settings.geo_scope_line
    ? settings.geo_scope_line
    : "No geographic restriction is configured for this search - don't exclude a posting on location alone.";
  // Unlike the others, this one can't be emptied into nothing: it's a whole
  // numbered step, and the generic version still earns its place even with no
  // priority locations set, because the tracker derives a lead's priority from
  // the location text either way.
  const locationGuidance = settings.location_guidance || DEFAULT_LOCATION_GUIDANCE;
  const screenedExamples = track.screened_examples || DEFAULT_SCREENED_EXAMPLES;
  const report = track.report_line || DEFAULT_REPORT_LINE;
  const footer = settings.footer_note ? ` ${settings.footer_note}` : "";

  // ---- The multi-tab pieces. Every one of them is the empty string when this
  // run fills a single tab, so an ordinary track's prompt is unchanged.
  const alsoFills = multi
    ? `\n# Also fills: ${fed.map((t) => `${t.key} (${t.label})`).join(", ")} - one search, ${allKeys.length} tabs`
    : "";
  // Which keys to fetch is no longer said here: `./tracker dedup` asks the
  // config which tracks this one feeds and merges them itself. What the run
  // still has to be told is how to read the merged result - that a posting
  // tracked under any of these tabs is not new, whichever tab tonight would
  // have filed it under.
  const dedupNote = multi
    ? ` It covers all ${allKeys.length} tabs this run fills (${allKeys.join(", ")}) and merges them: a posting already tracked under any of them is not new, whichever tab tonight's run would file it under.`
    : "";
  // Slots in after the sorting step, because it only applies to what sorting
  // has already decided is a finding - a screened-out posting needs no tab.
  //
  // The tie-break used to be "file it under `key`", the feeding track. That
  // reads as a reasonable default right up until you notice `key` is whichever
  // tab happens to own the scheduled search, not a general-purpose one - here
  // it's the narrowest tab on the board. A run filed a Senior SWE role at an
  // insurance company under Eng - Gaming and said so in its own note: it read
  // as swe-tech-or-swe-industry, and the rule turned a tab it had already
  // ruled out into the answer. Breaking the tie *among the tabs it does read
  // as* keeps everything the rule was for - one deterministic answer, no
  // second verification pass - and drops the part that put an insurer in the
  // games tab. First-in-the-list is the deterministic part: `[track, ...fed]`
  // is sort_order, which is the tab order on the page.
  const filingStep = multi
    ? `7b. FILE EACH FINDING UNDER THE RIGHT TAB. This one search fills ${allKeys.length} tabs, and every finding from step 7 belongs to exactly one of them:\n${[track, ...fed]
        .map((t) => `   - \`${t.key}\` (${t.label}): ${branchOf(t)}`)
        .join("\n")}\n   Decide from what the posting and the company actually are, reading the tab descriptions above as written - not from a job title alone, which means different things at different companies. \`${doc}\` is where any finer rule for this split lives; follow it. If a posting genuinely reads more than one way after checking, file it under whichever of *those* tabs comes first in the list above, and name those ones in your report. The tie is only ever between the tabs it actually reads as: a tab you have already ruled out is never the answer, and that includes \`${key}\` - the tab that happens to own this search, which is not a reason for a posting to show up in it. Don't spend a second verification pass on the question: the posting is already verified, this only decides which tab shows it. The answer is the \`"search"\` value in step 9.\n`
    : "";
  // Single-tab: nothing to say. tracker.ps1 stamps `search` from
  // TRACKER_SEARCH, so a run cannot file a posting under the wrong key or
  // forget the field, and the sentence that used to ask for it is gone.
  const searchValueRule = multi
    ? `is the key step 7b filed that posting under - ${allKeys
        .map((k) => `\`"${k}"\``)
        .join(" or ")}; one file can carry rows for several tabs`
    : `is stamped by the helper`;
  // Step 8's two reports took one "search" each, and for a multi-tab run that
  // raised the obvious question of which tab a dead posting from a fed tab got
  // reported under. The answer is "this run's own key, always" - the tracker
  // matches a reported url against every lead this person has, whatever tab
  // holds it (see db.getLeadsForUrlMatch) - and it had to be said out loud,
  // because the alternative a run would otherwise invent (one call per tab,
  // splitting the urls by which dedup response they came from) is exactly the
  // id-and-tab bookkeeping taking urls was meant to stop.
  //
  // tracker.ps1 sends the key itself, from TRACKER_SEARCH, so there is no
  // longer a question to answer and the note is gone. The rule it encoded is
  // in the helper's `verified`/`delist` branch.
  const delistTabNote = multi
    ? ` One file each covers all ${allKeys.length} tabs: the tracker matches a url against every lead ${name} has, whatever tab holds it.`
    : "";
  // There used to be a sentence here telling a multi-tab run to file every
  // screened row under the feeding track regardless of which tab the posting
  // would have gone in. The server does that itself now - handleAddScreened
  // rewrites `search` to the track that owns the search - so the sentence was
  // asking the model to reproduce a rule it cannot get wrong any more, which
  // is the kind of prose this whole change is about deleting.
  // Steps 1c, 9d and 9e go to every search, unconditionally. They used to wait
  // for the company list to have something on it, which could never happen
  // for a deployment that started empty: 9d is the only step that adds a
  // company. An empty list is not an error - step 1c gets no companies back,
  // step 3 falls back to the track's own target_companies, and 9d starts the
  // list from what the run covered.
  // The cursor mechanics ("a fixed list with a cursor, you get the next batch
  // from cursor, it wraps") are why re-fetching in 9e is safe and why nothing
  // has to be filtered by date. That belongs in coverage.js, which implements
  // it; what the run needs is the consequence, which 9e states in one line.
  const coverageStep = `1c. Get this run's companies: \`./tracker companies\`. It writes \`companies.json\` - \`{companies: [{company, last_swept, board, note}], total, batch, cursor}\` - and lists them. The server picks them, capped at what one run can actually verify. **Cover exactly these, all of them**, and don't reach past them into the rest of the list in step 3: that list is longer than one run can do properly, and the failure mode isn't a company going uncovered for a day, it's every company being skimmed. They come back round - everything is reached once per cycle before anything is reached twice. \`board\` is a JSON endpoint already confirmed for that company (\`greenhouse\`, \`ashby\`, \`workday cxs\`, ...); it makes a company cheap to cover, not privileged - use it where it's there. The cap is about *this* list: "don't reach past them" means don't help yourself to the rest of the rotation early, and step 3b sends you outside it on purpose.
`;
  // ---- Why 9d asks for endpoint/url_shape but not dead_signal.
  //
  // PR #1 gave /api/coverage three shared fields - endpoint, url_shape,
  // dead_signal - and for three days no run could reach any of them: this step
  // named `{company, board, note}` and tracker.ps1 whitelisted the same two,
  // so the API accepted fields nothing could send. 58 of the shared table's 63
  // rows had a board kind and no endpoint as a result. That is fixed above for
  // the two fields that are pure fetch mechanics.
  //
  // dead_signal stays out on purpose. migrations/0010 says to "read the
  // warning in the run prompt before writing this field", and that warning
  // does not exist yet - because writing it is not a sentence, it is the
  // careful version of what went wrong on 2026-09-08: a run compared pages it
  // could not read, found two strings they had in common, decided those meant
  // "closed", and delisted ten live postings on the strength of it. The
  // strings were boilerplate every response from that host carried. A field
  // that turns one run's pattern-match into a delisting rule every search
  // trusts needs that warning written properly first, and it is worth nothing
  // until then: endpoint and url_shape are where the value is.
  //
  // Two things dropped from 9e's emitted text and kept here, because both are
  // arguments against changes someone would otherwise make to this file:
  //
  // - Why the re-fetch is a second call rather than something 9d hands back.
  //   Reading the list changes nothing and can be repeated safely; recording a
  //   sweep is the only thing that marks work as done. Apart, a run that dies
  //   at any point has either recorded what it actually did or recorded
  //   nothing, and never sits holding companies the rotation believes are
  //   covered.
  // - Why "record first, then fetch" is an order and not a preference. The
  //   cursor only moves when a sweep is recorded, so fetching first hands back
  //   the same companies - and a run that died in between would have taken
  //   work nothing says it attempted.
  const sweepStep = `9d. RECORD WHAT YOU COVERED. Write every company this run actually
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

  // Step 9c used to carry the largest and most error-prone block of text in
  // this whole prompt: a per-branch explanation of how to split the run's own
  // counts across the tabs it fills, and a rule that a multi-tab run must post
  // one record per tab. It was not followed. On 2026-09-01 the live `SWE` run
  // reported a combined 97 leads against a tab that holds 89 in total, and the
  // three tabs it feeds recorded nothing at all on a morning one of them took
  // 133 leads - reading, on the page, as searches that had never run.
  //
  // Both jobs now belong to the server: POST /api/runs derives all three
  // counts from the rows that actually landed and writes a record for each fed
  // tab itself (see routes/runs.js's handleRecordRun). What's left in 9c is
  // only what the run alone knows - which track it is, whether it worked, its
  // local date, and a sentence for the page. The route still accepts
  // leadsAdded/screenedAdded/delisted and ignores them, so a run that fetched
  // this prompt before the change and is still going records correctly too.
  const runFanoutNote = multi
    ? ` One call covers every tab this run fills: the tracker writes a record for ${fed
        .map((t) => `\`${t.key}\``)
        .join(", ")} too, counted from the rows that landed in each. Don't run it once per tab.`
    : "";

  // Two post-mortems that used to be in the emitted text, kept because each is
  // the argument against deleting the step it belongs to:
  //
  // - Step 3b (broader discovery). This search ran for eight days with a
  //   broader-discovery step in its doc, added nothing to its rotation, and by
  //   day six was finding nothing at all, because everything its original
  //   companies had open was already tracked or screened. That is why 3b names
  //   step 9d rather than telling a run to write the name down somewhere.
  // - Step 9 and 9b's "`on` is today's **local** date". Left out, the server
  //   falls back to its own UTC date, which for an evening run is already
  //   tomorrow: the rows land fine and the run then records having found
  //   nothing. tracker.ps1 sends the local date and no step asks for one.
  // - Step 4's truncated-vs-blocked rule. The company it was written for is
  //   Google Careers, whose job pages are ~1.3MB of mostly navigation and
  //   served the location and the pay range in plain HTML the whole time it
  //   was being recorded as a wall. The rule stays in the text at length -
  //   step 4 is the premise of the whole system - but the case history is
  //   here, where someone deciding whether the paragraph still earns its
  //   place will read it.
  //
  // The helper paragraph below is the collapsed form of what used to be
  // repeated in five steps: how to check a response, that the environment
  // variables are already set, and when to skip a call because there is
  // nothing to send.
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

1. Read \`${doc}\` - ${docSummary}. Follow its numbered process. The doc doesn't keep a found-postings table or a screened/dead-link list of its own - dedup data comes from step 1b instead.
1b. Fetch what this track has already seen: \`./tracker dedup\`. It writes \`dedup.json\`: \`leads[]\` as \`{url, status}\` - postings already tracked, where \`url\` is what step 8 reports back and \`status\` is context for your report (that's how you tell a stale lead nobody's touched from one ${name} has already applied to) - and \`screened[]\`, a plain list of urls already looked at and rejected, which is what stops you re-verifying the same dead or out-of-scope candidate every run.${dedupNote}
${coverageStep}2. ${resumeLine}
3. Search the step-1c companies' careers sites (web search as backup) for current ${roleLine}. Step 1c is the list for today, drawn from: ${companies}.${searchNote}${exclusionNote}
3b. NOW LOOK OUTSIDE THAT LIST. Step 3 is the companies already known to be worth checking; this step is how that list ever grows, and it is not optional. Search for ${roleLine} at companies **not named anywhere above** - including outside tech entirely: travel, insurance, hotels, food service, grocery and retail, healthcare systems, logistics, banking, utilities, manufacturing, and sports (leagues and the larger franchises, plus the data, streaming and betting companies built around them). All of them run real engineering orgs and all of them are easy to miss when the named list reads as big tech. Rotate through a couple of verticals per run rather than attempting all of them.

   Every candidate this turns up faces the same mandatory verification in step 4 - a company being new is not a reason to trust a search snippet about it.

   **A company you find here joins the rotation in step 9d, or tonight is the last time it is ever looked at.** Record it with the others as soon as it yields a verified posting, whether that posting became a lead or was screened: either way you have established the company is worth a look. The rotation is the only list a future run reads, and writing a name into the doc's prose instead does nothing.

   Say in your step-10 report how many companies outside the list you tried and what came of them, even when the answer is none and nothing. A run that quietly skips this looks exactly like a run where the market was quiet, which is the confusion the whole tracker exists to prevent.
4. MANDATORY VERIFICATION: fetch every candidate URL directly and confirm it renders an actual job description (real title, responsibilities/qualifications - not a landing page, 404, "job not found," a loading placeholder, or a listing/index page that merely contains the title text). A search-snippet URL is a lead, not a finding, until opened and confirmed. If a site won't reveal real content, skip that company today rather than report something unverified.

   **Before you write a domain off as a wall, check what the HTML actually carried.** Three things survive on a page whose body renders client-side, and each is the page stating something rather than you inferring it: a \`JobPosting\` block in \`<script type="application/ld+json">\` (Ashby, Greenhouse, Lever, Workday and iCIMS all emit one - \`title\`, \`hiringOrganization\`, \`jobLocation\`, \`employmentType\`, \`baseSalary\`, usually the whole description); \`og:title\` / \`og:description\` meta tags; and the \`<title>\` tag. A JSON-LD \`JobPosting\` carrying a real description **is** the job description rendering - the same document in machine-readable form - so verify from it rather than calling the posting unconfirmable. A \`<title>\` naming no role ("Careers", "Job Board") states nothing, and an \`ItemList\` is a listing page, not a posting.

   **And tell a truncated page apart from an empty one.** A fetch that returned a megabyte of navigation and got cut off before the description is a size problem, not a block - the content is there, and the workaround for that domain (a reader-proxy, an ATS JSON endpoint, a different URL format) goes in step 9d as an \`endpoint\` or \`url_shape\`. Recording "truncated" as "blocked" is how a company that is perfectly readable ends up skipped for weeks.
5. ${geoStep}
6. ${locationGuidance}
${fitFilterStep}${captureNum}. While the posting is open, also capture - only when it's stated plainly, never inferred or guessed - the team/org named for the role (\`team\`), the stated work arrangement (\`setup\`, e.g. "Remote", "Hybrid - 3 days/week onsite", "Onsite"), and any posted compensation range (\`comp\`, e.g. "$180,000-$230,000/yr"; many US states disclose this by law). Leave any of these as an empty string when the posting doesn't say. These land in the tracker's per-lead "Details" panel alongside referral/resume/next-action fields that are ${name}'s alone to fill in by hand - this search never touches those.
7. Compare candidate URLs against \`leads[]\` and \`screened[]\` from step 1b (not a doc table). Sort each candidate into: (a) already tracked or already screened - skip it; (b) ${findingIs} - a finding, goes to step 9; (c) genuinely new but disqualified (${disqualified}) - goes to step 9b instead of being dropped silently.
${filingStep}8. REPORT WHAT THE RE-CHECK OF ALREADY-TRACKED LEADS FOUND. For the postings from step 1b's \`leads[]\` that you re-checked tonight, **never delete or move anything yourself** - report what you saw and let the tracker decide what to do with it. Both reports are a JSON array of the urls you actually opened; send the URL you opened rather than matching it against step 1b's spelling first, because the tracker matches on posting identity, so a \`?gh_jid=\` suffix, a tracking param or a missing slug still finds the right lead.${delistTabNote}

   - **Still live**: write them to \`live.json\`, then \`./tracker verified live.json\`. This is the only thing in the whole system that writes a lead's "Confirmed live" date, and that date is the only measure of how long a lead still sitting in a tab has been presumed live. It changes nothing else, so being honest about which ones you actually opened is the whole of it.
   - **Confirmed dead**: write them to \`dead.json\`, then \`./tracker delist dead.json\`. Don't also screen these - this one report is the whole of it. List a dead posting whatever \`status\` its lead is in; the tracker keeps ${name}'s applied-to leads and reports them back as \`kept\`.

   **There is no undoing the delist report.** A removed lead's row is gone and its URL is screened from then on, so step 7 skips it for good: if the posting turns out to be live after all, no future run puts it back.

   **So only list a posting you have actually confirmed dead** - a page that loads and says the role is closed or filled, or a genuine 404. Not being able to check is not the same as dead: a fetch timeout, a blocked domain, a 403/429, truncated content, or a JS shell that renders nothing all mean *unknown*, and an unknown belongs in **neither** file - it leaves the lead exactly as it is while you note the tooling problem in your report. Reporting a live posting as dead takes a real opening off ${pn.poss} board. When in doubt, leave it out of both and say so.

   A url reported back as unmatched means you believe you're tracking something the tracker has no lead for - report that plainly rather than retrying it.
8b. ${docUpdateLine}
9. SYNC NEW POSTINGS TO THE LIVE TRACKER WEBPAGE. Write today's new verified
   postings to \`leads.json\` - a JSON array of
   \`{company, title, location, url, fit, team, setup, comp}\` - then run
   \`./tracker leads leads.json\`. \`team\`, \`setup\` and \`comp\` are the
   step-${captureNum} fields; leave a key out entirely for anything the posting
   didn't state. Every row's \`"search"\` ${searchValueRule}${leadsNote}.
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
   unnoticed for weeks.${runFanoutNote}

   Send \`--status error\` instead if the run couldn't do its job properly - the
   tracker unreachable, search or fetch tooling failing broadly enough that the
   zero result isn't trustworthy, a required file missing - and put the reason
   in the note. A wrongly-cheerful "ok" is worse than no record at all: it's
   what stops the webpage flagging a search that has quietly broken.

   No counts to send or tally: the tracker derives them from what steps 8, 9
   and 9b wrote${multi ? ", per tab and from that tab's own rows" : ""}.
${sweepStep}10. ${report}

Never add an unverified link to any output.${footer}
`;
}

/**
 * The nightly fill for applications added as nothing but a URL.
 *
 * A second prompt in this file rather than a step bolted onto a track's
 * search, because it is not a search: it has no companies, no fit rule, no
 * geographic scope, and nothing it does depends on which track a person is
 * running. Folding it into the track prompts would also mean every track
 * running it - one queue, several runs racing to read the same postings.
 *
 * Served as the reserved key `_applications` under GET /api/prompt (see
 * routes/index.js) and run by scripts/run-fill.ps1 as a single nightly task
 * for the whole machine.
 *
 * ---- Why this one prompt covers everybody.
 * It is one job, not one job per person: the work is "read the postings behind
 * the applications that still have a gap", and whose they are changes nothing
 * about how it is done. A task per account would mean N headless CLI runs a
 * night, nearly all of them starting up only to find an empty queue.
 *
 * ---- Why the reading fans out to subagents.
 * Pulling the rows is one cheap query per account; reading the postings behind
 * them is the slow part, and every posting is independent of every other. So
 * the run gathers the whole list first and then dispatches a subagent per
 * posting, in batches, rather than walking the list serially. The split is also
 * a boundary worth having: a subagent gets one URL and no token, no account and
 * no row id, so it cannot write anywhere or confuse one person's row with
 * another's. Every write stays in the main turn, with the right account's
 * token.
 *
 * The database is still only ever read one account at a time, and that is not
 * a compromise - it is what lets this exist without a cross-user route. Every
 * route stays session-scoped exactly as it is for the search runs (see
 * db.js's constructor), and the runner hands the model one bearer token per
 * account in the environment. So this text is written for "each account you
 * were given" and takes no user: it is identical for everyone, and the wrapper
 * scripts/run-fill.ps1 puts in front of it is what says how many accounts
 * there are tonight and which variable holds each one's token.
 *
 * ---- Why there is no run record for this one.
 * Every search records itself to /api/runs because a search that finds nothing
 * writes nothing, so a search that quietly stopped firing looks identical to a
 * quiet night. The stakes here are lower by design: this fills in fields the
 * person can always type themselves, on rows that are already in front of them
 * on the Applications tab, and it is deliberately invisible while it works. A
 * run record would be a status readout for a thing with no status - the
 * evidence that it stopped is a row that stayed blank, and the fix for that
 * row is the same either way.
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

   Collect every account's list before going on to step 2, keeping each row's
   account alongside its \`id\` and \`link\`. Step 2 reads them all together.

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
     -d '{"filled":[{"id":123,"company":"...","title":"...","location":"...","team":"...","setup":"...","comp":"..."}],
          "failed":[{"id":456,"reason":"posting has been taken down"}]}'
   \`\`\`

   Pair each subagent's answer back up with the account and \`id\` you dispatched
   it for, and send each account's rows with that account's token. \`id\` is the
   id from that account's step 1, unchanged. Send both lists in the one call;
   either may be omitted if it's empty. A \`filled\` row may carry a \`"note"\`
   alongside its fields - pass through whatever \`note\` the subagent returned,
   unchanged.

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

   The response is \`{"filled":N,"failed":N,"unmatched":[id,...]}\`. An id in
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
