import { describe, expect, it } from "vitest";
import { locationRules, parseLocation, parseLocations, tooManyLocations } from "./locations";

describe("parseLocations", () => {
  it("keeps the order typed, and drops empty entries", () => {
    expect(parseLocations("Seattle, Bellevue,, Remote US,").map((e) => e.text)).toEqual(["Seattle", "Bellevue", "Remote US"]);
  });

  it("stores the rules in rank order, leaving flagged entries out", () => {
    expect(locationRules(parseLocations("Seattle, WA, Remote US")).map((r) => r.label)).toEqual(["Seattle", "Remote US"]);
  });
});

describe("Remote with a country", () => {
  it("reads back what it matches", () => {
    expect(parseLocation("Remote US")).toMatchObject({ means: "remote postings in the United States" });
    expect(parseLocation("US Remote")).toMatchObject({ means: "remote postings in the United States" });
  });

  it("reads bare Remote as remote anywhere", () => {
    expect(parseLocation("Remote")).toMatchObject({ rule: { allOf: ["remote"] }, means: "remote, anywhere" });
  });
});

describe("a city with its state", () => {
  it("reads back the city and state in full", () => {
    expect(parseLocation("Portland OR")).toMatchObject({ means: "Portland, Oregon" });
    expect(parseLocation("Austin TX")).toMatchObject({ means: "Austin, Texas" });
  });
});

describe("a plain city", () => {
  it("asks for the state rather than choosing, for a name several places share", () => {
    expect(parseLocation("Portland")).toMatchObject({ problem: expect.stringContaining("Add the state") });
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

describe("an entry too short to read", () => {
  it.each(["WA", "US", "CA", "OR", "UK", "Remote CA"])("flags %j rather than guessing", (entry) => {
    expect(parseLocation(entry)).toHaveProperty("problem");
  });

  it("catches a state split off its city by a comma", () => {
    const [city, state] = parseLocations("Seattle, WA");
    expect(city).toHaveProperty("rule");
    expect(state).toMatchObject({ problem: expect.stringContaining("like Seattle WA") });
  });
});
