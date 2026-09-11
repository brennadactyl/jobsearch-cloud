/**
 * Every write, as an optimistic mutation over the single `["data"]` cache.
 *
 * The shape is the same throughout and is worth stating once:
 *
 *   onMutate   cancel any in-flight read (so it cannot land on top of us),
 *              snapshot the cache, apply the change locally
 *   onError    put the snapshot back, and say so
 *   onSuccess  replace the optimistic row with the server's authoritative one
 *
 * The last step is the one that matters and the reason every write endpoint
 * returns its row: an optimistic edit is a *guess* at what the server will do,
 * and several of these guesses are knowingly incomplete. Setting a lead to
 * "Applied" creates an application; moving a lead can be refused; a stage change
 * stamps a date column this client did not compute. Replacing rather than
 * confirming means the guess never has to be right, only close enough to look
 * settled for one round trip.
 *
 * The page this is ported from had no optimistic layer: it mutated `state` then
 * called render(), or refetched everything. This is faster and strictly more
 * honest about failure, because a rollback is visible.
 */
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { saved } from "../ui/saved";
import * as api from "./client";
import type { Application, Lead, TrackerData } from "./schema";

export const DATA_KEY = ["data"] as const;

/** Replaces a row by id, in place, preserving its position in the list. */
function replaceById<T extends { id: number }>(list: T[], item: T): T[] {
  return list.map((r) => (r.id === item.id ? item : r));
}

function patch(qc: QueryClient, fn: (d: TrackerData) => TrackerData) {
  qc.setQueryData<TrackerData>(DATA_KEY, (d) => (d ? fn(d) : d));
}

/**
 * A write refused for a revoked token is not a failed save to retry: nothing
 * will save until someone signs in again. Ends the session, which takes the page
 * to the gate, rather than leaving a page that looks signed in and rolls back
 * every edit. The request that got the 401 has usually ended it already; ending
 * it twice lands on the same gate.
 */
function signedOut(err: Error): boolean {
  if (!(err instanceof api.UnauthorizedError)) return false;
  api.session.end(err.message);
  return true;
}

/** A refusal the server put into words, as opposed to no answer at all or one this page could not read. */
function serverSaid(err: Error): boolean {
  return err.constructor === Error && !/^Request failed [(]/.test(err.message);
}

/**
 * Shared wiring. `optimistic` may be omitted where there is nothing sensible to
 * guess - adding a row has no id until the server assigns one.
 */
function useWrite<TVars, TResult>(opts: {
  mutationFn: (v: TVars) => Promise<TResult>;
  optimistic?: (d: TrackerData, v: TVars) => TrackerData;
  onResult?: (d: TrackerData, result: TResult, v: TVars) => TrackerData;
  /** A failure worth reading rather than the generic one. */
  message?: (err: Error) => string | undefined;
  /** What the indicator says while this is in flight, when "Saving…" is not the verb. */
  pending?: string;
  /** A success worth saying more precisely than "Saved", read once the result is in the cache. */
  done?: (result: TResult, d: TrackerData | undefined) => string;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    async onMutate(vars: TVars) {
      saved.saving(opts.pending);
      // An in-flight read would otherwise land after the optimistic patch and
      // silently undo it.
      await qc.cancelQueries({ queryKey: DATA_KEY });
      const snapshot = qc.getQueryData<TrackerData>(DATA_KEY);
      if (opts.optimistic) patch(qc, (d) => opts.optimistic!(d, vars));
      return { snapshot };
    },
    onError(err: Error, _vars, ctx) {
      // Put it back. With an optimistic update the row has already changed on
      // screen, so leaving it there would show a save that did not happen.
      if (ctx?.snapshot) qc.setQueryData(DATA_KEY, ctx.snapshot);
      if (signedOut(err)) return;
      const specific = opts.message?.(err);
      if (specific) saved.message(specific);
      else saved.failed();
    },
    onSuccess(result: TResult, vars) {
      if (opts.onResult) patch(qc, (d) => opts.onResult!(d, result, vars));
      const text = opts.done?.(result, qc.getQueryData<TrackerData>(DATA_KEY));
      if (text) saved.note(text);
      else saved.ok();
    },
  });
}

/**
 * One whitelisted field on a lead or an application.
 *
 * Status is deliberately not routed through here - see the dedicated hooks
 * below and the note in client.ts.
 */
export function useUpdateField() {
  return useWrite<{ kind: "lead" | "application"; id: number; field: string; value: string }, Lead | Application>({
    mutationFn: ({ kind, id, field, value }) =>
      kind === "lead" ? api.updateLeadField(id, field, value) : api.updateApplicationField(id, field, value),
    optimistic: (d, { kind, id, field, value }) =>
      kind === "lead"
        ? { ...d, leads: d.leads.map((l) => (l.id === id ? { ...l, [field]: value } : l)) }
        : { ...d, applications: d.applications.map((a) => (a.id === id ? { ...a, [field]: value } : a)) },
    onResult: (d, row, { kind }) =>
      kind === "lead"
        ? { ...d, leads: replaceById(d.leads, row as Lead) }
        : { ...d, applications: replaceById(d.applications, row as Application) },
  });
}

/**
 * A lead's status, which the server owns: moving one to "Applied" creates its
 * application atomically and takes it out of the leads tab entirely.
 */
export function useSetLeadStatus() {
  return useWrite<{ id: number; status: string }, Awaited<ReturnType<typeof api.setLeadStatus>>>({
    mutationFn: ({ id, status }) => api.setLeadStatus(id, status),
    // The application the server may create is not guessed - it has no id yet,
    // and inventing one would put a row on screen that the next read deletes.
    // Only the status is optimistic.
    optimistic: (d, { id, status }) => ({
      ...d,
      leads: d.leads.map((l) => (l.id === id ? { ...l, status } : l)),
    }),
    onResult: (d, res) => ({
      ...d,
      leads: replaceById(d.leads, res.lead),
      applications:
        res.application && !d.applications.some((a) => a.id === res.application!.id)
          ? [res.application, ...d.applications]
          : d.applications,
    }),
  });
}

/**
 * Files a lead under a different tab.
 *
 * The visible tab deliberately does not change: moving a stray row is something
 * you do in the middle of triaging a tab, and jumping to wherever it went would
 * cost you your place.
 */
export function useMoveLead() {
  return useWrite<{ id: number; search: string }, Lead>({
    mutationFn: ({ id, search }) => api.moveLead(id, search),
    optimistic: (d, { id, search }) => ({
      ...d,
      leads: d.leads.map((l) => (l.id === id ? { ...l, search } : l)),
    }),
    onResult: (d, lead) => ({ ...d, leads: replaceById(d.leads, lead) }),
    // Named for what it does and where the row went: it has just left the list
    // you are looking at, and this line is the only thing on screen saying which
    // tab it is under now.
    pending: "Moving…",
    done: (lead, d) => `Moved to ${d?.tracks.find((t) => t.key === lead.search)?.label || lead.search}`,
    // Both of this call's refusals are worth reading: an unknown track key, and
    // a destination that already holds this posting. No answer at all is not.
    message: (err) => (serverSaid(err) ? err.message : "Couldn't move it — try again"),
  });
}

/** An application's status, which stamps the stage-date column it moves into. */
export function useSetApplicationStatus() {
  return useWrite<{ id: number; status: string; date?: string }, Application>({
    mutationFn: ({ id, status, date }) => api.setApplicationStatus(id, status, date),
    // The date column the server stamps is not guessed - which column, and
    // whether it was already set, is the server's decision.
    optimistic: (d, { id, status }) => ({
      ...d,
      applications: d.applications.map((a) => (a.id === id ? { ...a, status } : a)),
    }),
    onResult: (d, app) => ({ ...d, applications: replaceById(d.applications, app) }),
  });
}

/** Adds a row that is nothing but a link, for the overnight fill to read. */
export function useAddApplication() {
  return useWrite<{ link: string }, Application>({
    // No optimistic row: it would need an id the server has not assigned yet.
    mutationFn: ({ link }) => api.addApplication(link),
    onResult: (d, app) => ({ ...d, applications: [app, ...d.applications] }),
  });
}

/**
 * Removes a posting, with the reason that stops tomorrow's run rediscovering it.
 *
 * `kept` coming back non-empty means an application still points at the lead and
 * nothing was deleted - which is why the optimistic removal has to be undone on
 * a *successful* response, not only on an error.
 */
export function useDeleteLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => api.deleteLead(id, reason),
    async onMutate({ id }) {
      saved.saving();
      await qc.cancelQueries({ queryKey: DATA_KEY });
      const snapshot = qc.getQueryData<TrackerData>(DATA_KEY);
      patch(qc, (d) => ({ ...d, leads: d.leads.filter((l) => l.id !== id) }));
      return { snapshot };
    },
    onError(err, _vars, ctx) {
      if (ctx?.snapshot) qc.setQueryData(DATA_KEY, ctx.snapshot);
      if (signedOut(err)) return;
      saved.failed();
    },
    onSuccess(res, _vars, ctx) {
      if (res.kept.length) {
        if (ctx?.snapshot) qc.setQueryData(DATA_KEY, ctx.snapshot);
        saved.message("Kept — an application points at it");
        return;
      }
      saved.ok();
    },
  });
}

export function useDeleteApplication() {
  return useWrite<{ id: number }, unknown>({
    mutationFn: ({ id }) => api.deleteApplication(id),
    optimistic: (d, { id }) => ({ ...d, applications: d.applications.filter((a) => a.id !== id) }),
  });
}
