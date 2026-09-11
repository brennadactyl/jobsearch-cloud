/**
 * The write indicator.
 *
 * Every write path sets it: "Saving…", then "Saved" or "Couldn't save — try
 * again". That is a contract rather than a nicety - a write that skips it looks
 * to the person like nothing happened, and with optimistic updates the row has
 * *already* changed on screen, so this is the only thing distinguishing "saved"
 * from "about to be rolled back".
 *
 * A module store rather than context for the same reason as prefs: it is
 * genuinely global, every mutation writes it and one element reads it.
 */
import { useSyncExternalStore } from "react";

/** "off" greys the dot: a write is in flight and has not landed yet. */
export type SaveTone = "off" | "ok" | "bad";
export interface SaveState {
  text: string;
  tone: SaveTone;
}

let current: SaveState = { text: "Saved", tone: "ok" };
const listeners = new Set<() => void>();

function set(next: SaveState) {
  current = next;
  for (const l of listeners) l();
}

export const saved = {
  /** "Saving…", or the verb that fits better - "Moving…". */
  saving: (text = "Saving…") => set({ text, tone: "off" }),
  ok: () => set({ text: "Saved", tone: "ok" }),
  failed: () => set({ text: "Couldn't save — try again", tone: "bad" }),
  /** For a failure worth reading rather than the generic one - an unknown track, a duplicate posting. */
  message: (text: string) => set({ text, tone: "bad" }),
  /** A success worth saying more precisely than "Saved" - "Added — it fills in overnight". */
  note: (text: string) => set({ text, tone: "ok" }),
  loading: () => set({ text: "Loading", tone: "off" }),
};

export function useSaved(): SaveState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => current,
  );
}
