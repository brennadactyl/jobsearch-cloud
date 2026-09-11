/**
 * The only path to the server. `request` attaches the bearer token and turns a
 * 401 into a session reset, so a token revoked in another browser shows the
 * gate rather than an empty page. `logout` is the one other caller of `fetch`,
 * because the token it carries is the one being discarded.
 */
import { z } from "zod";
import {
  applicationSchema,
  dataSchema,
  leadSchema,
  loginSchema,
  type Application,
  type Lead,
  type TrackerData,
} from "./schema";

export const API_BASE: string = import.meta.env.VITE_API_BASE;

const TOKEN_KEY = "tracker_token";
const NAME_KEY = "tracker_name";

/**
 * localStorage *throws* where site data is blocked, which uncaught would take
 * the app down before it rendered. Signing in still works; it isn't remembered.
 */
function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered; not fatal */
  }
}
function clearStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

const endListeners = new Set<(reason: string) => void>();

export const session = {
  token: () => readStored(TOKEN_KEY),
  /** Display only. The server decides whose data this is, from the token alone. */
  name: () => readStored(NAME_KEY),
  start(token: string, name: string) {
    writeStored(TOKEN_KEY, token);
    writeStored(NAME_KEY, name);
  },
  /**
   * Forgets the token but keeps the name for the gate to prefill, and notifies
   * the `onEnd` listeners, which take the page to the gate. `reason` is what the
   * gate says; "" for a plain sign-out.
   *
   * Notifies even with no token to forget: another tab signing out clears the
   * same storage, and this tab's next 401 still has to reach the gate.
   */
  end(reason = "") {
    clearStored(TOKEN_KEY);
    for (const fn of endListeners) fn(reason);
  },
  onEnd(fn: (reason: string) => void): () => void {
    endListeners.add(fn);
    return () => {
      endListeners.delete(fn);
    };
  },
};

/** Thrown when the server rejected the token. Callers show the gate rather than an error. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Your session has expired - sign in again.");
    this.name = "UnauthorizedError";
  }
}

/** Thrown when the payload did not match schema.ts. Distinct from a transport failure. */
export class SchemaError extends Error {
  // Not a constructor parameter property: `erasableSyntaxOnly` (tsconfig.app.json)
  // rules that shorthand out because it emits code.
  readonly detail: string;
  constructor(detail: string) {
    super("The server sent something this page did not understand.");
    this.name = "SchemaError";
    this.detail = detail;
  }
}

type RequestOptions = { method?: string; body?: unknown; token?: string };

/**
 * One request, parsed through `schema`. Every response this client reads goes
 * through a schema - an unparsed `await res.json()` is how a field rename
 * becomes `undefined` three components deep instead of one error here.
 */
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  { method = "GET", body, token }: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const bearer = token ?? session.token();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    // Revoked elsewhere, or never valid. Same handling either way.
    const err = new UnauthorizedError();
    session.end(err.message);
    throw err;
  }

  const payload: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(message);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new SchemaError(z.prettifyError(parsed.error));
  return parsed.data;
}

export function getData(): Promise<TrackerData> {
  return request("/api/data", dataSchema);
}

/**
 * Exchanges a name and password for a session token. The password is never
 * stored and never sent again - the token is what every later request carries.
 */
export async function login(name: string, password: string) {
  const res = await request("/api/login", loginSchema, {
    method: "POST",
    // `label` is what the server records the session as, so a browser sign-in
    // is distinguishable from the long-lived one a scheduled search holds.
    body: { name, password, label: "browser" },
    token: "",
  });
  session.start(res.token, res.user?.name || name);
  return res;
}

/**
 * Revokes the token server-side as well as locally. The local session is
 * cleared first regardless, so an unreachable server can't strand someone
 * signed in on a shared browser. Resolves false when the revoke did not land:
 * the token is still live on the server.
 */
export async function logout(): Promise<boolean> {
  const token = session.token();
  session.end();
  if (!token) return true;
  try {
    const res = await fetch(`${API_BASE}/api/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Writes. Each returns the server's row, which mutations.ts puts in place of
// its optimistic guess.
//
// Status has its own routes on both kinds of row: the server validates it and
// owns its side effects (creating a lead's application, stamping a stage
// date). A new field that needs a side effect needs a route, not a special
// case here.

const updateLeadSchema = z.object({ ok: z.boolean().optional(), lead: leadSchema });
const updateAppSchema = z.object({ ok: z.boolean().optional(), application: applicationSchema });
/** Setting a lead to "Applied" creates its application in the same transaction. */
const leadStatusSchema = z.object({ lead: leadSchema, application: applicationSchema.nullish() });

/** One whitelisted field on a lead. Not status - see setLeadStatus. */
export function updateLeadField(id: number, field: string, value: string): Promise<Lead> {
  return request("/api/update", updateLeadSchema, {
    method: "POST",
    body: { type: "lead", id, [field]: value },
  }).then((r) => r.lead);
}

export function updateApplicationField(id: number, field: string, value: string): Promise<Application> {
  return request("/api/update", updateAppSchema, {
    method: "POST",
    body: { type: "application", id, [field]: value },
  }).then((r) => r.application);
}

export function setLeadStatus(id: number, status: string) {
  return request(`/api/leads/${id}/status`, leadStatusSchema, { method: "POST", body: { status } });
}

/**
 * Refused, with a message worth showing, for an unknown track key or a
 * destination that already holds this posting (409 from the UNIQUE constraint).
 */
export function moveLead(id: number, search: string): Promise<Lead> {
  return request("/api/update", updateLeadSchema, {
    method: "POST",
    body: { type: "lead", id, search },
  }).then((r) => r.lead);
}

/** `date` stamps the stage column the status moves into; omitted means today. */
export function setApplicationStatus(id: number, status: string, date?: string): Promise<Application> {
  return request(`/api/applications/${id}/status`, updateAppSchema, {
    method: "POST",
    body: date ? { status, date } : { status },
  }).then((r) => r.application);
}

/**
 * Nothing here marks the row for the overnight fill: a link with blank
 * company/role/location is what queues it (see domain/rows.ts fillState).
 */
export function addApplication(link: string): Promise<Application> {
  return request("/api/update", updateAppSchema, {
    method: "POST",
    // Field for field the body client/public/index.html sends, so a row from
    // either client means the same thing. The UTC date is inlined, as
    // domain/format's today() computes it, so this layer imports no domain code.
    body: {
      type: "application",
      company: "",
      title: "",
      location: "",
      dateApplied: new Date().toISOString().slice(0, 10),
      status: "Applied",
      notes: "",
      team: "",
      setup: "",
      source: "",
      link,
      resume: "",
      referral: "",
      comp: "",
    },
  }).then((r) => r.application);
}

/**
 * `reason` is stored on the screened row the removal leaves behind, which is
 * what stops tomorrow's run rediscovering the URL. `kept` comes back non-empty
 * when an application still points at the lead, and then nothing was deleted.
 */
export function deleteLead(id: number, reason: string) {
  return request("/api/delete-leads", z.object({ kept: z.array(z.unknown()).default([]) }), {
    method: "POST",
    body: { ids: [id], reason },
  });
}

export function deleteApplication(id: number) {
  return request("/api/delete-application", z.object({ ok: z.boolean().optional() }), {
    method: "POST",
    body: { id },
  });
}

/**
 * Needs the current password as well as the token, so a borrowed browser can't
 * lock its owner out. `signOutOthers` never revokes this session or a scheduled
 * search's credential; `signedOut` is how many it revoked.
 */
export function changePassword(currentPassword: string, newPassword: string, signOutOthers: boolean) {
  return request("/api/password", z.object({ ok: z.boolean().optional(), signedOut: z.number().default(0) }), {
    method: "POST",
    body: { currentPassword, newPassword, signOutOthers },
  });
}
