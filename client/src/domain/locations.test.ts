import { describe, expect, it } from "vitest";
import { matchLocationTier } from "./geo";
import { locationRules, parseLocation, parseLocations, tooManyLocations } from "./locations";

/** Location strings in the shapes postings write them. A rule is right when it ranks these. */
const REMOTE_US = [
  "Remote (U.S.)", "USA - Remote", "Remote-friendly (United States)", "Remote (U.S./Canada)",
  "US - Remote (hybrid)", "Remote (US/Canada)", "Remote, Colorado, USA", "Denver, CO / remote US", "Remote-US eligible",
];
const MULTI_CITY = "Seattle, WA / Denver, CO / Austin, TX";

const tierLabel = (answer: string, location: string) => matchLocationTier(location, locationRules(parseLocations(answer)))?.label ?? null;

describe("parseLocations", () => {
  it("keeps the order typed, and drops empty entries", () => {
    expect(parseLocations("Seattle, Bellevue,, Remote US,").map((e) => e.text)).toEqual(["Seattle", "Bellevue", "Remote US"]);
  });

  it("stores the rules in rank order, leaving flagged entries out", () => {
    expect(locationRules(parseLocations("Seattle, WA, Remote US")).map((r) => r.label)).toEqual(["Seattle", "Remote US"]);
  });
});

describe("Remote with a country", () => {
  it.each(REMOTE_US)("matches %j, as postings write remote in the US", (location) => {
    expect(tierLabel("Remote US", location)).toBe("Remote US");
  });

  it("doesn't match an on-site posting that happens to contain the letters us", () => {
    expect(tierLabel("Remote US", MULTI_CITY)).toBeNull();
    expect(tierLabel("Remote US", "Austin, TX")).toBeNull();
  });

  it("reads back what it matches", () => {
    expect(parseLocation("Remote US")).toMatchObject({ means: "remote postings in the United States" });
    expect(parseLocation("US Remote")).toMatchObject({ means: "remote postings in the United States" });
  });

  it("reads bare Remote as remote anywhere", () => {
    expect(parseLocation("Remote")).toMatchObject({ rule: { allOf: ["remote"] }, means: "remote, anywhere" });
    expect(tierLabel("Remote", "Remote (North America, incl. U.S.)")).toBe("Remote");
  });
});

describe("a city with its state", () => {
  it("matches only that state's city, for a name several places share", () => {
    for (const location of ["Portland, OR", "Portland, OR (Hybrid)", "Tacoma, WA / Portland, OR / multiple locations", "Portland OR"]) {
      expect(tierLabel("Portland OR", location), location).toBe("Portland OR");
    }
    expect(tierLabel("Portland Oregon", "Portland, Oregon")).toBe("Portland Oregon");
    expect(tierLabel("Portland OR", "Portland, ME")).toBeNull();
    // "or" as a word elsewhere in the string doesn't count as Oregon.
    expect(tierLabel("Portland OR", "Portland, ME (or Boston, MA)")).toBeNull();
  });

  it("knows Canadian provinces for the names shared across the border", () => {
    expect(tierLabel("Vancouver BC", "Vancouver, BC, Canada")).toBe("Vancouver BC");
    expect(tierLabel("Vancouver BC", "Vancouver, WA")).toBeNull();
  });

  it("matches any other city by name alone, so a posting that omits the state still ranks", () => {
    expect(tierLabel("Austin TX", "Austin/Denver/Chicago")).toBe("Austin TX");
    expect(parseLocation("Austin TX")).toMatchObject({ means: "Austin, Texas" });
  });

  it("reads back the city and state in full", () => {
    expect(parseLocation("Portland OR")).toMatchObject({ means: "Portland, Oregon" });
  });
});

describe("a plain city", () => {
  it("matches a posting that names it anywhere, including a multi-city posting", () => {
    expect(tierLabel("Seattle", MULTI_CITY)).toBe("Seattle");
    expect(tierLabel("Seattle", "Boulder, CO (also Chicago, Seattle, or remote)")).toBe("Seattle");
  });

  it("asks for the state rather than choosing, for a name several places share", () => {
    expect(parseLocation("Portland")).toMatchObject({ problem: expect.stringContaining("Add the state") });
  });

  it("expands the short forms people type", () => {
    expect(tierLabel("NYC", "New York, NY")).toBe("NYC");
    expect(tierLabel("SF", "San Francisco, CA")).toBe("SF");
  });

  it("ranks a multi-city posting by the best city it mentions anywhere", () => {
    expect(tierLabel("Seattle, Bellevue", "Boulder, CO (also Bellevue, Seattle)")).toBe("Seattle");
  });

  it("ranks the first entry a posting matches", () => {
    expect(tierLabel("Bellevue, Seattle", MULTI_CITY)).toBe("Seattle");
    expect(tierLabel("Seattle, Remote US", "Seattle, WA (Remote - US)")).toBe("Seattle");
  });
});

describe("the setup API's limits", () => {
  it("flags an entry longer than a label can be", () => {
    expect(parseLocation("x".repeat(61))).toHaveProperty("problem");
  });

  it("says so beside the field past twenty places", () => {
    const many = Array.from({ length: 21 }, (_, i) => `City${String.fromCharCode(97 + i)}ville`).join(", ");
    expect(tooManyLocations(parseLocations(many))).toContain("up to 20");
    expect(tooManyLocations(parseLocations("Seattle, Remote US"))).toBe("");
  });

  it("emits only label, allOf and anyOf, each list non-empty and within size", () => {
    const answer = "Seattle, Remote US, Portland OR, Vancouver BC, NYC, Remote UK, Remote, Canada, Austin TX, Remote Germany";
    for (const rule of locationRules(parseLocations(answer))) {
      expect(Object.keys(rule).every((k) => ["label", "allOf", "anyOf"].includes(k)), rule.label).toBe(true);
      expect(rule.label.length).toBeGreaterThan(0);
      expect(rule.label.length).toBeLessThanOrEqual(60);
      expect((rule.allOf?.length ?? 0) + (rule.anyOf?.length ?? 0)).toBeGreaterThan(0);
      for (const list of [rule.allOf, rule.anyOf]) {
        if (!list) continue;
        expect(list.length, rule.label).toBeGreaterThan(0);
        expect(list.length, rule.label).toBeLessThanOrEqual(20);
        for (const term of list) expect(term.length).toBeLessThanOrEqual(80);
      }
    }
  });
});

describe("an entry too short to match", () => {
  it.each(["WA", "US", "CA", "OR", "UK", "Remote CA"])("flags %j rather than guessing", (entry) => {
    expect(parseLocation(entry)).toHaveProperty("problem");
  });

  it("catches a state split off its city by a comma", () => {
    const [city, state] = parseLocations("Seattle, WA");
    expect(city).toHaveProperty("rule");
    expect(state).toMatchObject({ problem: expect.stringContaining("like Seattle WA") });
  });

  it("never writes a term of three letters or fewer without punctuation around it", () => {
    const answers = ["Seattle, Bellevue, Remote US, Portland OR, NYC, SF, Remote UK, Remote, Canada, Denver CO"];
    for (const rule of locationRules(parseLocations(answers.join(", ")))) {
      for (const term of [...(rule.anyOf ?? []), ...(rule.allOf ?? [])]) {
        expect(/^[a-z]{1,3}$/.test(term), `${rule.label}: "${term}"`).toBe(false);
      }
    }
  });
});
