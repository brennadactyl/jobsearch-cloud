/**
 * The Export button against the list it sits over: the file holds exactly the
 * rows the list renders, in order, and its count is the list's length.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { TrackerData } from "./api/schema";
import { LABELS } from "./domain/constants";
import { NOW, data as fixture } from "./domain/fixture";
import { clearPrefs, setPrefs } from "./ui/prefs";
import * as download from "./ui/download";

function renderAt(path: string, data: TrackerData = fixture) {
  vi.spyOn(client, "getData").mockResolvedValue(data);
  window.history.pushState({}, "", path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  return screen.findByRole("heading", { name: "Fixture Search" });
}

/** RFC 4180 records, every field quoted, as toCsv writes them. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let i = text.startsWith("﻿") ? 1 : 0;
  while (i < text.length) {
    if (text[i] !== '"') throw new Error(`unquoted field at ${i}`);
    let value = "";
    i++;
    for (;;) {
      if (text[i] === '"' && text[i + 1] === '"') {
        value += '"';
        i += 2;
      } else if (text[i] === '"') {
        i++;
        break;
      } else {
        value += text[i++];
      }
    }
    record.push(value);
    if (text[i] === ",") {
      i++;
    } else {
      records.push(record);
      record = [];
      i += 2; // CRLF
    }
  }
  return records;
}

/** Clicks Export and returns what would have been downloaded. */
async function exportRows() {
  const save = vi.spyOn(download, "downloadFile").mockImplementation(() => {});
  await userEvent.click(screen.getByRole("button", { name: /^Export \d+$/ }));
  expect(save).toHaveBeenCalledTimes(1);
  const [filename, text, type] = save.mock.calls[0];
  const [header, ...rows] = parseCsv(text);
  const col = (label: string) => rows.map((r) => r[header.indexOf(label)]);
  return { filename, type, header, rows, col };
}

const exportCount = () => Number(screen.getByRole("button", { name: /^Export \d+$/ }).textContent!.replace("Export ", ""));
const listed = () => [...document.querySelectorAll(".md-row .co")].map((e) => e.textContent);

beforeEach(() => {
  localStorage.clear();
  clearPrefs();
  localStorage.setItem("tracker_token", "a-token");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("exporting a leads list", () => {
  it("writes the rows the list shows, in its order, with a status filter, a search and a drill applied", async () => {
    await renderAt("/all-leads?drill=top-geo-open&filter=Reviewing&q=e");
    const shown = listed();
    expect(shown.length).toBeGreaterThan(1);

    const file = await exportRows();

    expect(file.col(LABELS.company)).toEqual(shown);
    expect(file.rows).toHaveLength(exportCount());
    expect(file.type).toBe("text/csv;charset=utf-8");
    expect(file.filename).toMatch(/^All leads-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("follows the sort", async () => {
    setPrefs({ leadSort: "company-asc" });
    await renderAt("/t/beta");
    const file = await exportRows();
    expect(file.col(LABELS.company)).toEqual(listed());
    expect(file.col(LABELS.company)).toEqual([...listed()].sort());
  });

  it("names the track on every row, on a single track's tab too", async () => {
    await renderAt("/t/alpha");
    const file = await exportRows();
    expect(new Set(file.col(LABELS.search))).toEqual(new Set(["Alpha roles"]));
    expect(file.filename).toMatch(/^Alpha roles-/);
  });

  it("writes the same file from Grid as from Detail", async () => {
    await renderAt("/all-leads");
    const detail = await exportRows();
    vi.restoreAllMocks();
    vi.spyOn(client, "getData").mockResolvedValue(fixture);
    await userEvent.click(screen.getByRole("button", { name: "Grid" }));
    const grid = await exportRows();
    expect(grid.rows).toEqual(detail.rows);
  });
});

describe("exporting applications", () => {
  it("writes the rows the list shows, in its order, with a drill applied", async () => {
    await renderAt("/applications?drill=applied");
    const shown = [...document.querySelectorAll(".md-row")].map((r) => r.querySelector(".co")!.textContent);
    expect(shown.length).toBeGreaterThan(1);

    const file = await exportRows();

    // A row that is still only a link shows its host where the company goes,
    // and exports its real, empty company.
    const companies = file.col(LABELS.company);
    expect(companies).toHaveLength(shown.length);
    companies.forEach((c, i) => c && expect(c).toBe(shown[i]));
    expect(file.filename).toMatch(/^Applications-/);
    expect(file.header).toContain("Recruiter Screen");
  });
});

describe("the Export button", () => {
  it.each([
    ["a track", "/t/alpha", "detail"],
    ["All leads", "/all-leads", "detail"],
    ["Applications", "/applications", "detail"],
    ["a track", "/t/alpha", "grid"],
    ["All leads", "/all-leads", "grid"],
    ["Applications", "/applications", "grid"],
  ] as const)("counts the rows %s renders in %s view", async (_, path, view) => {
    setPrefs({ view });
    await renderAt(path);
    const rendered = document.querySelectorAll(view === "grid" ? "tr[data-expand]" : ".md-row").length;
    expect(rendered).toBeGreaterThan(0);
    expect(exportCount()).toBe(rendered);
  });

  it("is the N in a leads tab's 'N of M shown'", async () => {
    await renderAt("/all-leads?filter=New");
    expect(document.querySelector(".note")!.textContent).toContain(`${exportCount()} of `);
  });

  it("is disabled when the list is empty, and downloads nothing", async () => {
    const save = vi.spyOn(download, "downloadFile");
    await renderAt("/all-leads?q=no-such-company");
    const button = screen.getByRole("button", { name: "Export 0" });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves the save indicator alone", async () => {
    await renderAt("/applications");
    const before = screen.getByRole("status").textContent;
    await exportRows();
    expect(screen.getByRole("status")).toHaveTextContent(before!);
  });
});
