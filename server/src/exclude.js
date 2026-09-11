/**
 * Whether a company is one this person has said they will not work for -
 * enforced in code, because a list rendered into a prompt is only a request.
 *
 * Pure (no D1, no env), so it can be replayed offline over the live corpus.
 *
 * ---- The rules.
 * An entry is written by a person, not typed as a key, so "/" and parentheses
 * are treated as "or": "Quillwork / Quill Industries" and
 * "Quill Industries (Quillwork)" are the same company written two ways, and
 * either spelling has to match either way round. Each alternative is matched as
 * a run of whole words, so "Vela" does not take out "Velabyte".
 *
 * An alternative of 2 characters or fewer must equal the entire company name.
 * "Q (formerly Quantex)" yields the alternative "q", and as a loose match "q"
 * takes out every Torque, Bosque and Marquee on the board. This accepts a false
 * negative to rule out a false positive: a missed exclusion is one row a human
 * sees and deletes, while an over-match is a board that quietly stops
 * containing jobs.
 *
 * Nothing cleverer than that - fix a miss by editing the list:
 *   - No qualifier stripping. "Q (formerly Quantex)" yields "q" and the dead
 *     alternative "formerly quantex", which matches nothing, so a posting under
 *     the old name needs the old name added to the list.
 *   - No article or suffix rewriting. "The Ridgeline Company" will not match
 *     "Ridgeline Company".
 *   - A catch-all entry ("any other company Dana Whitlock owns or leads") is an
 *     instruction to a language model, not a name, and matches nothing here:
 *     judging who owns what is the model's job.
 *
 * The examples are invented; the real list is private to a person's settings
 * row and does not belong in this repo.
 *
 * Replay any rule change over the full live corpus before shipping it:
 * over-matching is silent, it just returns a smaller board.
 */

/** At or below this length an alternative has to be the entire company name. */
const WHOLE_NAME_MAX = 2;

/**
 * Exported because company_fetch keys its rows on this
 * (migrations/0010_company_fetch.sql). Keep one normalizer: a second would let
 * an exclusion and a shared-intel lookup silently disagree on the same name.
 */
export function normalize(name) {
  return String(name == null ? "" : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Built once per request, then called per row.
 *
 * Total by design, like canonicalUrl - a missing or malformed list yields a
 * predicate that excludes nothing rather than throwing, so a bad settings value
 * never costs a run its batch.
 *
 * @param {string[]|null|undefined} excludedCompanies settings.excluded_companies
 * @returns {(companyName: string) => boolean}
 */
export function excludedCompanyMatcher(excludedCompanies) {
  const wholeName = new Set();
  const phrases = new Set();

  for (const entry of Array.isArray(excludedCompanies) ? excludedCompanies : []) {
    for (const piece of String(entry == null ? "" : entry).split(/[/()]/)) {
      const alt = normalize(piece);
      if (!alt) continue;
      // Padded, so the includes() below can only land on word boundaries.
      if (alt.length <= WHOLE_NAME_MAX) wholeName.add(alt);
      else phrases.add(` ${alt} `);
    }
  }

  return function isExcludedCompany(companyName) {
    const name = normalize(companyName);
    if (!name) return false;
    if (wholeName.has(name)) return true;
    const padded = ` ${name} `;
    for (const phrase of phrases) if (padded.includes(phrase)) return true;
    return false;
  };
}
