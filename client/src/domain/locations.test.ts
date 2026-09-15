import { describe, expect, it } from "vitest";
import { geo } from "./geo";
import { locationRules, parseLocation, parseLocations } from "./locations";

/** Location strings in the shapes postings write them. A rule is right when it ranks these. */
const REMOTE_US = ["Remote (U.S.)", "USA - Remote", "Remote-Friendly, United States", "Remote (U.S./Canada)"];
const MULTI_CITY = "Seattle, WA / Denver, CO / Austin, TX";

const rank = (answer: string, location: string) => geo(location, locationRules(parseLocations(answer)))?.label ?? null;

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
    expect(rank("Remote US", location)).toBe("Remote US");
  });

  it("doesn't match an on-site posting that happens to contain the letters us", () => {
    expect(rank("Remote US", MULTI_CITY)).toBeNull();
    expect(rank("Remote US", "Austin, TX")).toBeNull();
  });

  it("reads back what it matches", () => {
    expect(parseLocation("Remote US")).toMatchObject({ means: "remote postings in the United States" });
    expect(parseLocation("US Remote")).toMatchObject({ means: "remote postings in the United States" });
  });

  it("reads bare Remote as remote anywhere", () => {
    expect(parseLocation("Remote")).toMatchObject({ rule: { allOf: ["remote"] }, means: "remote, anywhere" });
    expect(rank("Remote", "Remote (North America, incl. U.S.)")).toBe("Remote");
  });
});

describe("a city with its state", () => {
  it("matches only that state's city of the name", () => {
    expect(rank("Portland OR", "Portland, OR")).toBe("Portland OR");
    expect(rank("Portland Oregon", "Portland, Oregon")).toBe("Portland Oregon");
    expect(rank("Portland OR", "Portland, ME")).toBeNull();
  });

  it("reads back the city and state in full", () => {
    expect(parseLocation("Portland OR")).toMatchObject({ means: "Portland, Oregon" });
  });
});

describe("a plain city", () => {
  it("matches a posting that names it anywhere, including a multi-city posting", () => {
    expect(rank("Seattle", MULTI_CITY)).toBe("Seattle");
    expect(rank("Seattle", "Boulder, CO (also Chicago, Seattle, or remote)")).toBe("Seattle");
  });

  it("nudges a name several places share towards adding the state", () => {
    expect(parseLocation("Portland")).toMatchObject({ means: "any place named Portland — add the state to narrow it" });
  });

  it("expands the short forms people type", () => {
    expect(rank("NYC", "New York, NY")).toBe("NYC");
    expect(rank("SF", "San Francisco, CA")).toBe("SF");
  });

  it("ranks the first entry a posting matches", () => {
    expect(rank("Bellevue, Seattle", MULTI_CITY)).toBe("Seattle");
    expect(rank("Seattle, Remote US", "Seattle, WA (Remote - US)")).toBe("Seattle");
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
