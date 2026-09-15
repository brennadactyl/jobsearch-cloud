import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ROLE_FIELDS, LABELS, ROLE_FIELDS, STAGE_HISTORY_FIELDS } from "./constants";
import { applicationColumns, exportFilename, leadColumns, toCsv, type Column } from "./export";
import { isoDay } from "./format";
import { data } from "./fixture";
import { buildTracks } from "./tabs";

const one: Column<{ v: string }>[] = [{ header: "V", value: (r) => r.v }];
const body = (csv: string) => csv.slice("﻿".length).split("\r\n")[1];

describe("toCsv", () => {
  it("starts with a byte-order mark and ends every line with CRLF", () => {
    const csv = toCsv(one, [{ v: "a" }, { v: "b" }]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.slice(1)).toBe('"V"\r\n"a"\r\n"b"\r\n');
  });

  it("quotes every field and doubles quotes inside one", () => {
    expect(body(toCsv(one, [{ v: 'Say "hi"' }]))).toBe('"Say ""hi"""');
  });

  it("keeps commas, line breaks and empty values inside their cell", () => {
    const cols: Column<{ a: string; b: string; c: string }>[] = [
      { header: "A", value: (r) => r.a },
      { header: "B", value: (r) => r.b },
      { header: "C", value: (r) => r.c },
    ];
    const csv = toCsv(cols, [{ a: "Springfield, OR", b: "", c: "line one\nline two" }]);
    expect(csv.slice(1)).toBe('"A","B","C"\r\n"Springfield, OR","","line one\nline two"\r\n');
  });

  it.each(["=SUM(A1)", "+1", "-1", "-", "@cmd", "\tx", "\rx"])(
    "makes %j plain text, since a spreadsheet would run it as a formula",
    (value) => {
      expect(body(toCsv(one, [{ v: value }]))).toBe(`"'${value}"`);
    },
  );

  it("leaves a value that only contains a formula character alone", () => {
    expect(body(toCsv(one, [{ v: "Senior-Staff" }]))).toBe('"Senior-Staff"');
  });
});

describe("exportFilename", () => {
  it("is the tab label and the date", () => {
    expect(exportFilename("Applications", "2026-09-15")).toBe("Applications-2026-09-15.csv");
  });

  it("replaces characters a filesystem refuses", () => {
    expect(exportFilename('Eng / Mgmt: "leads"?', "2026-09-15")).toBe("Eng - Mgmt- -leads---2026-09-15.csv");
  });
});

describe("isoDay, which names the file", () => {
  it("is the local calendar date, not the UTC one", () => {
    // 23:30 local on the 15th, which is already the 16th in UTC for anyone west of it.
    expect(isoDay(new Date(2026, 8, 15, 23, 30))).toBe("2026-09-15");
  });
});

describe("the column lists", () => {
  const known = new Set<string>([
    ...Object.values(LABELS),
    ...[...ROLE_FIELDS, ...APP_ROLE_FIELDS, ...STAGE_HISTORY_FIELDS].map(([, label]) => label),
  ]);
  const leads = leadColumns(buildTracks(data.tracks), data.settings);
  const apps = applicationColumns(data.settings);

  it("take every header from the page's labels", () => {
    for (const c of [...leads, ...apps]) expect(known, c.header).toContain(c.header);
    const source = readFileSync(join(process.cwd(), "src", "domain", "export.ts"), "utf8");
    expect(source).not.toMatch(/header:\s*["'`]/);
  });

  it("write a lead's track label, location tier and posting URL", () => {
    const lead = data.leads.find((l) => l.company === "Acme")!;
    const row = Object.fromEntries(leads.map((c) => [c.header, c.value(lead)]));
    expect(row[LABELS.search]).toBe("Alpha roles");
    expect(row[LABELS.locationTier]).toBe("Metro core");
    expect(row[LABELS.url]).toBe("https://example.com/1");
  });

  it("write an application's stage dates verbatim, and leave an unreached one empty", () => {
    const app = data.applications.find((a) => a.company === "Opt")!;
    const row = Object.fromEntries(apps.map((c) => [c.header, c.value(app)]));
    expect(row[LABELS.applied]).toBe(app.dateApplied);
    expect(row["Tech Screen"]).toBe(app.dateTechScreen);
    expect(row["Offer"]).toBe("");
  });
});
