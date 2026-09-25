/**
 * A leads or applications list as a CSV file. Pure: the caller passes the rows
 * its list renders, so a file can't hold a row the page hid.
 *
 * The column lists are the one definition of what a file contains. Headers are
 * the page's own labels from ./constants, so a rename reaches the file too.
 */
import type { Application, Lead, Screened, Settings, Track } from "../api/schema";
import { APP_ROLE_FIELDS, LABELS, ROLE_FIELDS, STAGE_HISTORY_FIELDS } from "./constants";
import { tierOf } from "./geo";

export interface Column<T> {
  header: string;
  value: (row: T) => string;
}

function field<T>(name: string, header: string): Column<T> {
  return { header, value: (row) => String((row as unknown as Record<string, unknown>)[name] ?? "") };
}

function tier(row: { area: string }, settings: Settings): string {
  return tierOf(row, settings)?.label ?? "";
}

/**
 * Search is on every leads tab's file, not only the pooled tab's, so files
 * exported from two tabs can be combined.
 */
export function leadColumns(tracks: Record<string, Track>, settings: Settings): Column<Lead>[] {
  return [
    { header: LABELS.search, value: (l) => tracks[l.search]?.label || l.search },
    field("company", LABELS.company),
    field("title", LABELS.role),
    field("location", LABELS.location),
    { header: LABELS.locationTier, value: (l) => tier(l, settings) },
    field("status", LABELS.status),
    field("found", LABELS.found),
    field("verified", LABELS.verified),
    field("fit", LABELS.fit),
    ...ROLE_FIELDS.map(([name, label]) => field<Lead>(name, label)),
    field("url", LABELS.url),
    field("notes", LABELS.notes),
  ];
}

export function applicationColumns(settings: Settings): Column<Application>[] {
  return [
    field("company", LABELS.company),
    field("title", LABELS.role),
    field("location", LABELS.location),
    { header: LABELS.locationTier, value: (a) => tier(a, settings) },
    field("status", LABELS.status),
    ...STAGE_HISTORY_FIELDS.map(([name, label]) => field<Application>(name, label)),
    ...APP_ROLE_FIELDS.map(([name, label]) => field<Application>(name, label)),
    field("notes", LABELS.notes),
  ];
}

/**
 * What a search set aside. The reason is the sentence its run wrote, kept whole
 * and unread, and the file says which of the two kinds of row it is: a run's
 * decision, or a posting the person took off their own board.
 */
export function screenedColumns(tracks: Record<string, Track>): Column<Screened>[] {
  return [
    { header: LABELS.search, value: (r) => tracks[r.search]?.label || r.search },
    field("date", LABELS.setAside),
    field("company", LABELS.company),
    field("title", LABELS.role),
    field("location", LABELS.location),
    field("reason", LABELS.why),
    { header: LABELS.setAsideBy, value: (r) => (r.added_by === "hand" ? "you" : "a run") },
    field("url", LABELS.url),
  ];
}

/**
 * A spreadsheet runs a cell starting with one of these as a formula. Company,
 * role and location text is copied off career pages, so a posting could plant
 * one; a leading apostrophe makes the cell plain text.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string): string {
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * RFC 4180: every field quoted, quotes doubled, CRLF line ends. The byte-order
 * mark makes Excel on Windows read the file as UTF-8 rather than the system
 * codepage, which would garble accented names.
 */
export function toCsv<T>(columns: readonly Column<T>[], rows: readonly T[]): string {
  const lines = [
    columns.map((c) => cell(c.header)).join(","),
    ...rows.map((row) => columns.map((c) => cell(c.value(row))).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** `<tab label>-<YYYY-MM-DD>.csv`, with characters no filesystem allows replaced by `-`. */
export function exportFilename(label: string, date: string): string {
  const name = label.replace(/[\\/:*?"<>|]/g, "-").replace(/\p{Cc}/gu, "-").trim();
  return `${name || "export"}-${date}.csv`;
}
