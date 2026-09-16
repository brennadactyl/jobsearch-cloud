/**
 * View preferences: per-browser choices that survive a reload and don't belong
 * to the account. The tab, drill and status filter live in the URL instead, so a
 * filtered view can be linked to.
 */
import { useSyncExternalStore } from "react";
import { OVERVIEW_FOLD_IDS } from "../domain/overview";

export interface Prefs {
  view: "detail" | "grid";
  leadSort: string;
  appSort: string;
  /** Which applications fill-state groups are folded away, by group key. */
  collapsed: Record<string, boolean>;
  /** Selected row per scope, for the master/detail list. */
  selected: Record<string, string>;
  /** Expanded rows in Grid view. */
  expanded: Record<string, boolean>;
  /** Overview sections and charts folded away, by OVERVIEW_FOLD_IDS id. Only true entries. */
  overviewCollapsed: Record<string, boolean>;
}

const DEFAULTS: Prefs = {
  view: "detail",
  leadSort: "priority",
  appSort: "applied-desc",
  collapsed: {},
  selected: {},
  expanded: {},
  overviewCollapsed: {},
};

/** The keys browsers already hold; renaming one resets everyone's saved view. */
const KEYS: Partial<Record<keyof Prefs, string>> = {
  view: "bjs.view",
  leadSort: "bjs.leadSort",
  appSort: "bjs.appSort",
  overviewCollapsed: "bjs.overviewCollapsed",
};

/** Guarded like client.ts's readStored: losing preferences is a worse experience, not a broken one. */
function read<K extends keyof Prefs>(key: K): Prefs[K] | undefined {
  const storageKey = KEYS[key];
  if (!storageKey) return undefined;
  try {
    const raw = localStorage.getItem(storageKey);
    return raw === null ? undefined : (raw as Prefs[K]);
  } catch {
    return undefined;
  }
}

/**
 * The stored Overview folds, which are JSON. Anything unreadable - bad JSON, a
 * non-object, an id no section has - is dropped, so the page falls back to
 * expanded rather than failing before its first render.
 */
export function readOverviewCollapsed(): Record<string, boolean> {
  const raw = read("overviewCollapsed") as unknown;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const known: readonly string[] = OVERVIEW_FOLD_IDS;
    return Object.fromEntries(Object.entries(parsed).filter(([id, v]) => v === true && known.includes(id)));
  } catch {
    return {};
  }
}

let current: Prefs = {
  ...DEFAULTS,
  view: (read("view") as Prefs["view"]) ?? DEFAULTS.view,
  leadSort: read("leadSort") ?? DEFAULTS.leadSort,
  appSort: read("appSort") ?? DEFAULTS.appSort,
  overviewCollapsed: readOverviewCollapsed(),
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** A module-level store rather than a context: these are global and every panel reads them. */
export function setPrefs(patch: Partial<Prefs>): void {
  current = { ...current, ...patch };
  for (const [k, v] of Object.entries(patch)) {
    const storageKey = KEYS[k as keyof Prefs];
    if (!storageKey) continue;
    // A string as it is; a record as JSON of its true entries.
    let stored: string;
    if (typeof v === "string") stored = v;
    else if (v && typeof v === "object") {
      stored = JSON.stringify(Object.fromEntries(Object.entries(v).filter(([, on]) => on === true)));
    } else continue;
    try {
      localStorage.setItem(storageKey, stored);
    } catch {
      /* not remembered; not fatal */
    }
  }
  emit();
}

/** Clears the per-browser view state, so the next person to sign in here does not land on someone else's tab. */
export function clearPrefs(): void {
  current = { ...DEFAULTS };
  for (const storageKey of Object.values(KEYS)) {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* nothing to do */
    }
  }
  emit();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

/** Folds or unfolds one Overview section or chart. Reads the store, so clicks landing before a re-render all count. */
export function toggleOverviewFold(id: string): void {
  const next = { ...current.overviewCollapsed };
  if (next[id]) delete next[id];
  else next[id] = true;
  setPrefs({ overviewCollapsed: next });
}

/** Reads the store, not a render's copy: it is also called from onSuccess, when that copy can be stale. */
export function selectRow(scope: string, id: string): void {
  setPrefs({ selected: { ...current.selected, [scope]: id } });
}

/**
 * Opens or closes a Grid row's details. Either also selects the row, since it is
 * the row Detail view should land on when you switch there.
 */
export function toggleGridRow(scope: string, id: number): void {
  setPrefs({
    expanded: { ...current.expanded, [id]: !current.expanded[id] },
    selected: { ...current.selected, [scope]: String(id) },
  });
}

/**
 * The selected row while it is in the list, otherwise the first; Detail shows it
 * and Grid highlights it. Never stored: a render can see a new row's selection
 * before the row, and storing the fallback would overwrite that selection.
 */
export function shownRow<T extends { id: number }>(rows: readonly T[], selected: string | undefined): T {
  return rows.find((r) => String(r.id) === String(selected)) ?? rows[0];
}
