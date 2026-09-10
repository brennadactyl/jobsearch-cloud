/**
 * The tab bar, as data.
 *
 * **Nothing about a track is hardcoded.** `/api/data`'s `tracks[]` and
 * `settings` become the tab bar: `kind` says which panel to draw, `label` comes
 * from config either way. Adding a track in D1 adds a tab; renaming one renames
 * it. The same deployed client serves every account, so a track key or tab label
 * written into this file would be one person's job search baked into everyone's
 * page.
 */
import type { Application, Lead, Settings, Track } from "../api/schema";
import type { DrillTarget } from "./drills";
import { ALL_LEADS } from "./constants";
import { fillState } from "./rows";
import { trackWarn, type TabWarning } from "./runs";

export type TabKind = "overview" | "applications" | "allleads" | "track";

export interface Tab {
  id: string;
  kind: TabKind;
  label: string;
  /** Badge count, or null for no badge. */
  n: number | null;
  warn: TabWarning | null;
  /** Where this tab lives. Tabs are real URLs here, unlike the page this is ported from. */
  path: string;
}

/** Tracks in display order, keyed by track key. */
export function buildTracks(list: readonly Track[]): Record<string, Track> {
  const out: Record<string, Track> = {};
  [...list]
    .sort((a, b) => a.sort_order - b.sort_order || String(a.key).localeCompare(String(b.key)))
    .forEach((t) => {
      out[t.key] = t;
    });
  return out;
}

/** The route a tab id lives at. */
export function pathForTab(id: string): string {
  if (id === "dashboard") return "/";
  if (id === "applications") return "/applications";
  if (id === ALL_LEADS) return "/all-leads";
  return `/t/${encodeURIComponent(id)}`;
}

export function buildTabs(
  leads: readonly Lead[],
  applications: readonly Application[],
  tracks: Record<string, Track>,
  settings: Settings,
): Tab[] {
  const tabs: Tab[] = [
    {
      id: "dashboard",
      kind: "overview",
      label: settings.overview_label || "Overview",
      n: null,
      warn: null,
      path: pathForTab("dashboard"),
    },
    {
      id: "applications",
      kind: "applications",
      label: settings.applications_label || "Applications",
      n: applications.length,
      // A posting the nightly fill couldn't read is the one thing on this tab
      // that waits on you rather than on a company: nothing will fill that row
      // in but you, and no later run will try again.
      //
      // Asks fillState() rather than re-testing `autofill === "failed"`. The
      // page this is ported from spells that rule out in four places, in two
      // spellings - they agree today and none of them agree by construction.
      warn: applications.some((a) => fillState(a) === "stuck")
        ? { cls: "fill", title: "A posting couldn’t be read — a row here needs filling in by hand" }
        : null,
      path: pathForTab("applications"),
    },
    {
      // Every track's leads in one list. It exists because the Overview's tiles
      // count across tracks, and a number you can't open is a number you stop
      // trusting.
      id: ALL_LEADS,
      kind: "allleads",
      label: settings.all_leads_label || "All leads",
      n: leads.filter((l) => l.status === "New").length,
      warn: null,
      path: pathForTab(ALL_LEADS),
    },
  ];

  for (const key of Object.keys(tracks)) {
    tabs.push({
      id: key,
      kind: "track",
      label: tracks[key].label,
      // A "what hasn't been triaged yet" count, so New only - Reviewing and
      // "Not a fit" are things you have already looked at, and Applied leads
      // have moved to the Applications tab entirely.
      n: leads.filter((l) => l.search === key && l.status === "New").length,
      warn: trackWarn(tracks[key].last_run, settings),
      path: pathForTab(key),
    });
  }

  return tabs;
}

/** What the pooled leads tab says where a track tab shows its run stamp. */
export function trackCountLine(tracks: Record<string, Track>): string {
  const n = Object.keys(tracks).length;
  if (!n) return "No tracked searches configured";
  return `${n} tracked search${n === 1 ? "" : "es"} feed this list`;
}

/**
 * A drill target as a URL. The narrowing rides in query params, which is what
 * makes a drilled view linkable and the back button undo it - neither of which
 * the page this is ported from could do, because its equivalent lived in
 * localStorage.
 */
export function pathForTarget(t: DrillTarget): string {
  const params = new URLSearchParams();
  if (t.filter) params.set("filter", t.filter);
  if (t.drill) params.set("drill", t.drill);
  const q = params.toString();
  return pathForTab(t.tab) + (q ? `?${q}` : "");
}
