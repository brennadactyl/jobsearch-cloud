/**
 * **Nothing about a track is hardcoded:** every label comes from `/api/data`'s
 * `tracks[]` and `settings`. The same deployed client serves every account, so
 * a track key written here would be one person's search on everyone's page.
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
  path: string;
}

export function buildTracks(list: readonly Track[]): Record<string, Track> {
  const out: Record<string, Track> = {};
  [...list]
    .sort((a, b) => a.sort_order - b.sort_order || String(a.key).localeCompare(String(b.key)))
    .forEach((t) => {
      out[t.key] = t;
    });
  return out;
}

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
      // An unreadable posting is the one thing here waiting on you: no later
      // run will try it again.
      warn: applications.some((a) => fillState(a) === "stuck")
        ? { cls: "fill", title: "A posting couldn’t be read — a row here needs filling in by hand" }
        : null,
      path: pathForTab("applications"),
    },
    {
      // The Overview's tiles count across tracks, and each number has to open
      // somewhere.
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
      // Untriaged only: Reviewing and "Not a fit" have been looked at, and
      // Applied leads live in the Applications tab.
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

/** The narrowing rides in query params, so a drilled view is linkable and Back undoes it. */
export function pathForTarget(t: DrillTarget): string {
  const params = new URLSearchParams();
  if (t.filter) params.set("filter", t.filter);
  if (t.drill) params.set("drill", t.drill);
  const q = params.toString();
  return pathForTab(t.tab) + (q ? `?${q}` : "");
}
