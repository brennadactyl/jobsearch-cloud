/**
 * **Nothing about a track is hardcoded:** every label comes from `/api/data`'s
 * `tracks[]` and `settings`. The same deployed client serves every account, so
 * a track key written here would be one person's search on everyone's page.
 */
import type { Application, Lead, Settings, Track } from "../api/schema";
import { ALL_FILTER, type DrillTarget } from "./drills";
import { ALL_LEADS } from "./constants";
import { fillState } from "./rows";
import { isoDay } from "./format";
import { SCREENED } from "./screened";
import { trackWarn, type TabWarning } from "./runs";

export type TabKind = "overview" | "applications" | "allleads" | "screened" | "track";

export interface Tab {
  id: string;
  kind: TabKind;
  label: string;
  /** Badge count, or null for no badge. */
  n: number | null;
  warn: TabWarning | null;
  /**
   * When this search was paused, "" while it runs. Its own state, not a
   * warning: a pause is a choice someone made, and the tab says so rather than
   * looking like a search that simply went quiet.
   */
  paused: string;
  /**
   * How many postings this search found today, 0 for none and for every tab
   * that isn't a search. Today only: a search whose last run was days ago has
   * nothing new this morning, however recently those finds were its latest.
   *
   * Searches only. The pooled tab would carry a dot on any morning any search
   * ran, which is most of them, and a light that is always on says nothing.
   */
  fresh: number;
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
  if (id === "dashboard") {
    return "/";
  }
  if (id === "applications") {
    return "/applications";
  }
  if (id === ALL_LEADS) {
    return "/all-leads";
  }
  if (id === SCREENED) {
    return "/screened";
  }
  return `/t/${encodeURIComponent(id)}`;
}

/** The tab's current URL with its drill removed and every other parameter kept, for a drill chip's clear link. */
export function pathWithoutDrill(id: string, params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.delete("drill");
  const query = next.toString();
  return pathForTab(id) + (query ? `?${query}` : "");
}

/**
 * `day` is today as a calendar date, taken apart so a test can say which day it
 * is. Local, not `toISOString()`: a run stamps its own local Pacific date, and
 * a UTC day rolls over at 5pm PT. A UTC today would match that stamp all
 * morning and stop matching mid-afternoon, so every dot would go dark for the
 * rest of the day - and a dark dot reads as "this search found nothing", not
 * as a clock bug.
 */
export function buildTabs(
  leads: readonly Lead[],
  applications: readonly Application[],
  tracks: Record<string, Track>,
  settings: Settings,
  day: string = isoDay(new Date()),
): Tab[] {
  const tabs: Tab[] = [
    {
      id: "dashboard",
      kind: "overview",
      label: settings.overview_label || "Overview",
      n: null,
      warn: null,
      paused: "",
      fresh: 0,
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
      paused: "",
      fresh: 0,
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
      paused: "",
      fresh: 0,
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
      warn: trackWarn(tracks[key], settings),
      paused: tracks[key].paused,
      // Dated today, not "dated on this search's last run day": a run that
      // failed or never started leaves older finds as the newest there are,
      // and those are not news this morning.
      fresh: leads.filter((l) => l.search === key && l.found === day).length,
      path: pathForTab(key),
    });
  }

  // Last, after the searches themselves: what they set aside is a place to go
  // looking, not one of the tabs a morning starts in. No badge either - a count
  // of postings nobody has to act on would read as work waiting.
  tabs.push({
    id: SCREENED,
    kind: "screened",
    label: "Screened",
    n: null,
    warn: null,
    paused: "",
    fresh: 0,
    path: pathForTab(SCREENED),
  });

  return tabs;
}

/** What the pooled leads tab says where a track tab shows its run stamp. */
export function trackCountLine(tracks: Record<string, Track>): string {
  const n = Object.keys(tracks).length;
  if (!n) {
    return "No tracked searches configured";
  }
  return `${n} tracked search${n === 1 ? "" : "es"} feed this list`;
}

/** The narrowing rides in query params, so a drilled view is linkable and Back undoes it. */
export function pathForTarget(t: DrillTarget): string {
  const params = new URLSearchParams();
  // An applications target counts every application, closed ones included,
  // while the tab opens on Live - so its link has to say All or the figure and
  // the list it opens are different sets. Here rather than at each target,
  // because the Overview builds a dozen of them for its tiles and chart marks
  // and one that forgot would differ silently.
  const filter = t.tab === "applications" ? (t.filter ?? ALL_FILTER) : t.filter;
  if (filter) {
    params.set("filter", filter);
  }
  if (t.drill) {
    params.set("drill", t.drill);
  }
  const q = params.toString();
  return pathForTab(t.tab) + (q ? `?${q}` : "");
}
