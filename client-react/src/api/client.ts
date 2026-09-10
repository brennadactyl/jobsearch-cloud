/**
 * The only path to the server, and the analogue of the old client's `api()`
 * (client/public/index.html). It attaches the bearer token and turns a 401 into
 * a session reset, which is what makes a token revoked in another browser show
 * a sign-in prompt rather than a confusing empty page.
 *
 * Nothing else in this app calls `fetch`, with the two exceptions that
 * genuinely sit outside a session: `login` below (there is no token yet) and
 * `logout` (the token is being discarded). The old client has exactly the same
 * three call sites, deliberately.
 *
 * The API base is baked at build time from VITE_API_BASE - see vite.config.ts,
 * which refuses to build without it. There is no runtime field for it: one
 * deployed client always talks to one server.
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
 * Reading localStorage *throws* where site data is blocked (a private window, a
 * browser set to refuse it) rather than returning null, and an uncaught throw
 * here would take the app down before it rendered anything. Signing in still
 * works in that state; it just is not remembered.
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

export const session = {
  token: () => readStored(TOKEN_KEY),
  /** Display only. The server decides whose data this is, from the token alone. */
  name: () => readStored(NAME_KEY),
  start(token: string, name: string) {
    writeStored(TOKEN_KEY, token);
    writeStored(NAME_KEY, name);
  },
  /** Forgets the token but keeps the name, so the gate can prefill it next time. */
  end() {
    clearStored(TOKEN_KEY);
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
  // Declared and assigned rather than a constructor parameter property:
  // `erasableSyntaxOnly` is on (see tsconfig.app.json), which rules out the
  // shorthand because it emits code rather than erasing to nothing.
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
    session.end();
    throw new UnauthorizedError();
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

/** Everything this person has, in one request. */
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
 * Revokes the token server-side, not just locally, so signing out here does not
 * leave a working token behind. Best-effort: the local session is cleared
 * regardless, because a failure to reach the server must not strand someone
 * signed in on a shared browser.
 */
export async function logout(): Promise<void> {
  const token = session.token();
  session.end();
  if (!token) return;
  try {
    await fetch(`${API_BASE}/api/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* already forgotten locally */
  }
}

// ---------------------------------------------------------------------------
// Writes.
//
// Status is the exception to the generic field write, on both kinds of row: the
// server validates the value and owns side effects a plain field patch cannot
// do - creating a lead's application atomically, stamping a stage date. If a
// new field ever needs a side effect it needs a route, not a special case here.
//
// Every one of these returns the server's authoritative row rather than the
// caller guessing what changed, which is what lets an optimistic update be
// replaced rather than merely confirmed.

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
 * Files a lead under a different tab. The one field with failures worth reading
 * rather than a generic "couldn't save": an unknown track key, and a
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
 * A row created with a link and nothing else is the entire handoff to the
 * overnight fill: it becomes a candidate because of what is in it (a link, and
 * no company/role/location), not because anything here said so. Nothing is
 * flagged or tracked from this side, so there is no state this page can get
 * wrong or leave stale.
 */
export function addApplication(link: string): Promise<Application> {
  return request("/api/update", updateAppSchema, {
    method: "POST",
    body: { type: "application", link, dateApplied: "" },
  }).then((r) => r.application);
}

/**
 * Removing a posting takes a reason, which is stored on the screened row the
 * removal leaves behind. That row is both the only lasting record of why it
 * went and the thing that stops tomorrow's run rediscovering the URL and adding
 * it straight back.
 *
 * `kept` comes back non-empty when an application still points at the lead, in
 * which case nothing was deleted.
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
