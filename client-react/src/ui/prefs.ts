/**
 * View preferences: per-browser choices that survive a reload and don't belong
 * to the account. The tab, drill and status filter live in the URL instead, so a
 * filtered view can be linked to.
 */
import { useCallback, useSyncExternalStore } from "react";

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
}

const DEFAULTS: Prefs = {
  view: "detail",
  leadSort: "priority",
  appSort: "applied-desc",
  collapsed: {},
  selected: {},
  expanded: {},
};

/** Shared with client/public/index.html, so a browser using both keeps its choices. */
const KEYS: Partial<Record<keyof Prefs, string>> = {
  view: "bjs.view",
  leadSort: "bjs.leadSort",
  appSort: "bjs.appSort",
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

let current: Prefs = {
  ...DEFAULTS,
  view: (read("view") as Prefs["view"]) ?? DEFAULTS.view,
  leadSort: read("leadSort") ?? DEFAULTS.leadSort,
  appSort: read("appSort") ?? DEFAULTS.appSort,
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
    if (!storageKey || typeof v !== "string") continue;
    try {
      localStorage.setItem(storageKey, v);
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

export function usePref<K extends keyof Prefs>(key: K): [Prefs[K], (v: Prefs[K]) => void] {
  const prefs = usePrefs();
  const set = useCallback((v: Prefs[K]) => setPrefs({ [key]: v } as Partial<Prefs>), [key]);
  return [prefs[key], set];
}

/** Reads the store, not a render's copy: it is also called from onSuccess, when that copy can be stale. */
export function selectRow(scope: string, id: string): void {
  setPrefs({ selected: { ...current.selected, [scope]: id } });
}

/**
 * The selected row while it is in the list, otherwise the first; Detail shows it
 * and Grid highlights it. Never stored: a render can see a new row's selection
 * before the row, and storing the fallback would overwrite that selection.
 */
export function shownRow<T extends { id: number }>(rows: readonly T[], selected: string | undefined): T {
  return rows.find((r) => String(r.id) === String(selected)) ?? rows[0];
}
