/**
 * View preferences: what you are looking at rather than what the data says.
 *
 * The split is the one the old page draws between `state` (from /api/data) and
 * `ui` (per browser, in localStorage), and it is worth keeping: these are
 * per-device choices, they must survive a reload, and none of them belong to the
 * account. A second browser is allowed to disagree about sort order.
 *
 * What is NOT here: the current tab, the active drill and the status filter.
 * Those became the URL (see tabs.ts's pathForTab and the `drill`/`filter` query
 * params), which is the one behavioural upgrade this rebuild makes over the page
 * it replaces - a filtered view is now something you can link to, and the back
 * button undoes a drill.
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

/** The keys the old page used, so a browser that has used both keeps its choices. */
const KEYS: Partial<Record<keyof Prefs, string>> = {
  view: "bjs.view",
  leadSort: "bjs.leadSort",
  appSort: "bjs.appSort",
};

/**
 * Reading localStorage *throws* where site data is blocked rather than
 * returning null, so every access is guarded. Preferences are a convenience:
 * losing them is a worse experience, not a broken one.
 */
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

/**
 * A module-level store rather than a context, because these are genuinely
 * global and every panel reads them. useSyncExternalStore keeps the subscription
 * correct under concurrent rendering without a provider in the tree.
 */
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

/** `const [view, setView] = usePref("view")` for the single-value cases. */
export function usePref<K extends keyof Prefs>(key: K): [Prefs[K], (v: Prefs[K]) => void] {
  const prefs = usePrefs();
  const set = useCallback((v: Prefs[K]) => setPrefs({ [key]: v } as Partial<Prefs>), [key]);
  return [prefs[key], set];
}

/**
 * Selects a row in one scope without disturbing the others' selections. Reads
 * the store rather than a render's copy of it, because it is also called from a
 * mutation's onSuccess - by which point that copy can be a render or two old.
 */
export function selectRow(scope: string, id: string): void {
  setPrefs({ selected: { ...current.selected, [scope]: id } });
}

/**
 * The row a master/detail tab shows: the selected one while it is in the list,
 * otherwise the first. Grid highlights by the same rule, so switching views lands
 * on the same row either way.
 *
 * Worked out on every render and never stored. Storing the fallback raced adding
 * an application: a render could see the new row's selection before it saw the
 * new row, fall back to the first, and write that over the selection.
 */
export function shownRow<T extends { id: number }>(rows: readonly T[], selected: string | undefined): T {
  return rows.find((r) => String(r.id) === String(selected)) ?? rows[0];
}
