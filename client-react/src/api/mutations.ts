/**
 * Every write, as an optimistic mutation over the single `["data"]` cache:
 *
 *   onMutate   cancel any in-flight read, snapshot the cache, apply the change
 *   onError    put the snapshot back, and say so
 *   onSuccess  replace the optimistic row with the server's
 *
 * The local guess may be incomplete; onSuccess corrects it.
 */
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { saved } from "../ui/saved";
import * as api from "./client";
import type { Application, Lead, TrackerData } from "./schema";

export const DATA_KEY = ["data"] as const;

function replaceById<T extends { id: number }>(list: T[], item: T): T[] {
  return list.map((r) => (r.id === item.id ? item : r));
}

function patch(qc: QueryClient, fn: (d: TrackerData) => TrackerData) {
  qc.setQueryData<TrackerData>(DATA_KEY, (d) => (d ? fn(d) : d));
}

/**
 * A write refused for a revoked token is not a save to retry: nothing will save
 * until someone signs in again, so end the session and go to the gate. The
 * request that got the 401 has usually ended it already; twice lands on the
 * same gate.
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

/** `optimistic` is omitted where there is nothing to guess, e.g. a new row has no id yet. */
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

/** Not for status, which has its own hooks below - see the Writes note in client.ts. */
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
 * The visible tab doesn't follow the lead: moving a stray row happens mid-triage,
 * and jumping to its new tab would cost you your place.
 */
export function useMoveLead() {
  return useWrite<{ id: number; search: string }, Lead>({
    mutationFn: ({ id, search }) => api.moveLead(id, search),
    optimistic: (d, { id, search }) => ({
      ...d,
      leads: d.leads.map((l) => (l.id === id ? { ...l, search } : l)),
    }),
    onResult: (d, lead) => ({ ...d, leads: replaceById(d.leads, lead) }),
    // The row has just left the list on screen, so this line is what says
    // which tab it is under now.
    pending: "Moving…",
    done: (lead, d) => `Moved to ${d?.tracks.find((t) => t.key === lead.search)?.label || lead.search}`,
    // The server's refusals are worth showing (see client.ts moveLead); no
    // answer at all is not.
    message: (err) => (serverSaid(err) ? err.message : "Couldn't move it — try again"),
  });
}

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

export function useAddApplication() {
  return useWrite<{ link: string }, Application>({
    mutationFn: ({ link }) => api.addApplication(link),
    onResult: (d, app) => ({ ...d, applications: [app, ...d.applications] }),
  });
}

/**
 * A non-empty `kept` means nothing was deleted, so the optimistic removal is
 * undone on a *successful* response too.
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
