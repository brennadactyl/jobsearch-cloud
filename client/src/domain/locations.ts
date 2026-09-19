/**
 * Turns the setup form's "Which locations should come first?" answer - places
 * in order of preference, comma-separated - into `priority_locations` rules.
 *
 * Postings spell places many ways ("Remote (U.S.)", "USA - Remote"), so a
 * typed entry is expanded here from fixed tables rather than kept as typed,
 * and the same entry always produces the same rule. No term is a bare word of
 * three letters or fewer: "us" is inside "Austin", "ca" inside "Chicago".
 */
import type { PriorityLocation } from "../api/schema";

export type LocationEntry =
  | { text: string; rule: PriorityLocation; means: string }
  | { text: string; problem: string };

const COUNTRIES: Record<string, { name: string; terms: string[] }> = {
  us: {
    name: "the United States",
    terms: [
      "u.s.", "united states", "(us)", "(us/", "us/canada", "us-", "- us", ", us", "remote us", "remote-us", "us remote", "us - remote",
      "(usa)", "usa -", "- usa", ", usa", "usa,", "rest of us",
    ],
  },
  canada: { name: "Canada", terms: ["canada"] },
  uk: { name: "the United Kingdom", terms: ["united kingdom", "u.k.", "(uk)", ", uk", "england", "scotland", "wales"] },
};
const COUNTRY_ALIASES: Record<string, string> = {
  us: "us", usa: "us", "u.s.": "us", "u.s": "us", "united states": "us", america: "us",
  canada: "canada",
  uk: "uk", "u.k.": "uk", "united kingdom": "uk", britain: "uk", "great britain": "uk",
};

const STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
  ct: "connecticut", de: "delaware", dc: "district of columbia", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas",
  ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts",
  mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana",
  ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico",
  ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma",
  or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
  sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont",
  va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};
/** Canadian provinces, for the shared names that also exist there (Vancouver BC, Richmond BC). */
const PROVINCES: Record<string, string> = {
  bc: "british columbia", ab: "alberta", on: "ontario", qc: "quebec", ns: "nova scotia", mb: "manitoba",
};
const REGIONS: Record<string, string> = { ...STATES, ...PROVINCES };
const REGION_BY_NAME = Object.fromEntries(Object.entries(REGIONS).map(([abbr, name]) => [name, abbr]));

/** Short forms people type for places whose postings spell them out. */
const CITY_ALIASES: Record<string, { name: string; terms: string[] }> = {
  nyc: { name: "New York", terms: ["new york"] },
  sf: { name: "San Francisco", terms: ["san francisco"] },
  la: { name: "Los Angeles", terms: ["los angeles"] },
  dc: { name: "Washington, DC", terms: ["washington, dc", "washington, d.c.", "washington dc"] },
};

/** City names shared by more than one well-known place, which read back with a nudge to add the state. */
const SHARED_CITY_NAMES = new Set([
  "portland", "vancouver", "cambridge", "springfield", "columbus", "columbia", "richmond", "arlington",
  "kansas city", "birmingham", "athens", "jackson", "aurora", "salem", "dover", "concord", "burlington",
]);

/** The setup API stores at most this many rules, with labels up to MAX_LABEL characters. */
export const MAX_LOCATIONS = 20;
const MAX_LABEL = 60;

const letters = (s: string) => s.replace(/[^a-z]/gi, "").length;
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function remoteEntry(text: string, rest: string): LocationEntry {
  const place = rest.replace(/^[\s,(-]+|[\s,)]+$/g, "");
  if (!place) return { text, rule: { label: text, allOf: ["remote"] }, means: "remote, anywhere" };
  const country = COUNTRY_ALIASES[place];
  if (country) {
    const c = COUNTRIES[country];
    return { text, rule: { label: text, allOf: ["remote"], anyOf: c.terms }, means: `remote postings in ${c.name}` };
  }
  if (letters(place) <= 3) return { text, problem: tooShort(text) };
  return { text, rule: { label: text, allOf: ["remote", place] }, means: `remote postings that mention ${titleCase(place)}` };
}

function tooShort(text: string): string {
  return `“${text}” is too short to match reliably. Write the place out, or join a state to its city without a comma, like Seattle WA.`;
}

/** One comma-separated entry. */
export function parseLocation(raw: string): LocationEntry {
  const text = raw.trim().replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  if (text.length > MAX_LABEL) return { text, problem: `Shorten this one to ${MAX_LABEL} characters or fewer.` };

  const remote = /^remote\b(.*)$/.exec(lower) ?? /^(.*)\bremote$/.exec(lower);
  if (remote) return remoteEntry(text, remote[1]);

  const alias = CITY_ALIASES[lower];
  if (alias) return { text, rule: { label: text, anyOf: alias.terms }, means: alias.name };

  // "Portland OR", "Austin Texas": a city with its state or province after it.
  // Only a shared name needs the region to match; any other city matches by
  // name alone, so "Austin TX" still ranks "Austin/Denver".
  const words = lower.split(" ");
  for (const n of [2, 1]) {
    if (words.length <= n) continue;
    const tail = words.slice(-n).join(" ");
    const abbr = REGIONS[tail] ? tail : REGION_BY_NAME[tail];
    if (!abbr) continue;
    const city = words.slice(0, -n).join(" ");
    if (letters(city) <= 3) break;
    const means = `${titleCase(city)}, ${titleCase(REGIONS[abbr])}`;
    if (!SHARED_CITY_NAMES.has(city)) return { text, rule: { label: text, anyOf: [city] }, means };
    return {
      text,
      rule: { label: text, allOf: [city], anyOf: [`${city}, ${abbr}`, `${city} ${abbr}`, REGIONS[abbr]] },
      means,
    };
  }

  const country = COUNTRY_ALIASES[lower];
  if (country && letters(lower) > 3) {
    const c = COUNTRIES[country];
    return { text, rule: { label: text, anyOf: c.terms }, means: `anywhere in ${c.name}` };
  }
  if (letters(lower) <= 3) return { text, problem: tooShort(text) };

  if (SHARED_CITY_NAMES.has(lower)) {
    return { text, problem: `Several places are called ${titleCase(lower)}. Add the state after the name, like Portland OR.` };
  }
  return { text, rule: { label: text, anyOf: [lower] }, means: "" };
}

/** The whole answer, in order. Empty entries (a trailing comma) are dropped. */
export function parseLocations(answer: string): LocationEntry[] {
  return answer.split(",").map((s) => s.trim()).filter(Boolean).map(parseLocation);
}

/** The message beside the field when there are more entries than the setup API stores, or "". */
export function tooManyLocations(entries: readonly LocationEntry[]): string {
  return entries.length > MAX_LOCATIONS ? `List up to ${MAX_LOCATIONS} places — the first ones matter most.` : "";
}

/** The rules to store, in rank order. Flagged entries are left out; the form won't send while there are any. */
export function locationRules(entries: readonly LocationEntry[]): PriorityLocation[] {
  return entries.flatMap((e) => ("rule" in e ? [e.rule] : []));
}
