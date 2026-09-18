/**
 * The Export control against the list it sits over. "Shown" holds exactly the
 * rows the list renders, in order, and its count is the list's length; "all"
 * holds every row the tab has, in the same sort. One button when the two are
 * the same, a button with a menu when they differ.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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

/** The button that exports what the list shows: the single one, or the split button's main half. */
const shownButton = () => screen.getByRole("button", { name: /^Export \d+( shown)?$/ });

/** Runs `click` and returns what would have been downloaded. */
async function download_(click: () => Promise<void>) {
  const save = vi.spyOn(download, "downloadFile").mockImplementation(() => {});
  await click();
  expect(save).toHaveBeenCalledTimes(1);
  const [filename, text, type] = save.mock.calls[0];
  const [header, ...rows] = parseCsv(text);
  const col = (label: string) => rows.map((r) => r[header.indexOf(label)]);
  save.mockRestore();
  return { filename, type, header, rows, col };
}

/** Exports what the list shows. */
const exportRows = () => download_(() => userEvent.click(shownButton()));

/** Opens the menu and exports every row the tab holds. */
const exportAll = () =>
  download_(async () => {
    await userEvent.click(screen.getByRole("button", { name: "More ways to export" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Export all \d+$/ }));
  });

const exportCount = () => Number(/\d+/.exec(shownButton().textContent!)![0]);
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
    expect(file.filename).toMatch(/^All leads-shown-\d{4}-\d{2}-\d{2}\.csv$/);
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
    expect(grid.filename).toBe(detail.filename);
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
    expect(file.filename).toMatch(/^Applications-shown-/);
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

  it("disables what's shown when the list is empty, and still offers all", async () => {
    const save = vi.spyOn(download, "downloadFile");
    await renderAt("/all-leads?q=no-such-company");
    const button = screen.getByRole("button", { name: "Export 0 shown" });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(save).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "More ways to export" }));
    expect(screen.getByRole("menuitem", { name: "Export 0 shown" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /^Export all \d+$/ })).toBeEnabled();
  });

  it("is one disabled button when the tab holds nothing at all", async () => {
    await renderAt("/applications", { ...fixture, applications: [] });
    expect(screen.getByRole("button", { name: "Export 0" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "More ways to export" })).toBeNull();
  });

  it("leaves the save indicator alone", async () => {
    await renderAt("/applications");
    const before = screen.getByRole("status").textContent;
    await exportRows();
    expect(screen.getByRole("status")).toHaveTextContent(before!);
  });
});

describe("exporting everything a tab holds", () => {
  /** The M in a leads tab's "N of M shown". */
  const heldCount = () => Number(/of (\d+) shown/.exec(document.querySelector(".note")!.textContent!)![1]);

  it("writes a leads tab's rows under the All chip with no search or drill, in the current sort, whatever is filtered", async () => {
    setPrefs({ leadSort: "company-asc" });
    await renderAt("/all-leads?filter=All");
    const underAll = listed();
    const m = heldCount();
    cleanup();

    await renderAt("/all-leads?drill=top-geo-open&filter=Reviewing&q=e");
    expect(heldCount()).toBe(m);
    const file = await exportAll();

    expect(file.col(LABELS.company)).toEqual(underAll);
    expect(file.rows).toHaveLength(m);
    expect(file.col(LABELS.status)).toContain("Not a fit");
    expect(file.filename).toMatch(/^All leads-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("writes every application on the Applications tab, drill or not", async () => {
    await renderAt("/applications?drill=applied");
    const file = await exportAll();
    expect(file.rows).toHaveLength(fixture.applications.length);
    expect(file.filename).toMatch(/^Applications-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it.each([
    ["a leads tab under All, unfiltered", "/all-leads?filter=All"],
    ["Applications with no drill", "/applications"],
  ])("is one button, with no menu, on %s", async (_, path) => {
    await renderAt(path);
    expect(shownButton()).toHaveTextContent(/^Export \d+$/);
    expect(screen.queryByRole("button", { name: "More ways to export" })).toBeNull();
    // With nothing filtered, what's shown is everything, so its file is named as all.
    expect((await exportRows()).filename).not.toContain("-shown-");
  });

  it.each([
    ["a leads tab on its default Open chip", "/all-leads"],
    ["a leads tab with a search", "/all-leads?filter=All&q=acme"],
    ["Applications with a drill", "/applications?drill=applied"],
  ])("offers shown or all, shown first, on %s", async (_, path) => {
    await renderAt(path);
    const n = exportCount();
    await userEvent.click(screen.getByRole("button", { name: "More ways to export" }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items[0]).toBe(`Export ${n} shown`);
    expect(items[1]).toMatch(/^Export all \d+$/);
    expect(Number(/\d+/.exec(items[1]!)![0])).toBeGreaterThan(n);
  });

  it("closes the menu on Escape without downloading", async () => {
    const save = vi.spyOn(download, "downloadFile");
    await renderAt("/all-leads");
    await userEvent.click(screen.getByRole("button", { name: "More ways to export" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
