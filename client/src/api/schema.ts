/**
 * The shape of `GET /api/data`. Every type in this client is inferred from here,
 * so the types and the parser can't disagree.
 *
 * Zod strips unknown keys rather than rejecting them: the server gains fields
 * more often than it changes existing ones, and an added column must not stop
 * the page loading.
 *
 * Authority for these shapes: `server/migrations/` for the columns,
 * `server/src/db.js`'s `getTracksAndSettings` for tracks and settings, and
 * `server/src/routes/data.js` for the envelope.
 */
import { z } from "zod";

/** Text columns are `NOT NULL DEFAULT ''` throughout, so "" is the empty case, not null. */
const str = z.string();
/** Tolerates a null the schema says cannot happen, rather than failing the whole payload for one row. */
const text = z.string().nullish().transform((v) => v ?? "");

/** `leads`. Mirrors LEAD_STATUS in server/src/routes/leads.js. */
export const LEAD_STATUS = ["New", "Reviewing", "Applied", "Not a fit"] as const;

export const leadSchema = z.object({
  id: z.number(),
  search: str, // track key, matches tracks.key
  found: text, // YYYY-MM-DD
  company: text,
  title: text,
  location: text,
  url: text,
  verified: text,
  fit: text,
  // Not an enum: the column is free text and a row written by an older client
  // or by hand can hold anything. Narrowing it here would fail the payload
  // rather than the one row, which is the wrong trade at a boundary.
  status: text,
  notes: text,
  delistedOn: text,
  // The freeform block shared with applications (EXTRA_FIELDS in db.js).
  team: text,
  setup: text,
  source: text,
  link: text,
  resume: text,
  referral: text,
  comp: text,
});

/** `applications`. Mirrors APP_STATUS in server/src/routes/applications.js. */
export const APP_STATUS = [
  "To Apply", "Applied", "Recruiter Screen", "Tech Screen",
  "Onsite / Loop", "Offer", "Rejected", "Withdrawn",
] as const;

export const applicationSchema = z.object({
  id: z.number(),
  leadId: text, // the originating leads.id as text; "" if added by hand
  company: text,
  title: text,
  location: text,
  dateApplied: text,
  status: text,
  notes: text,
  team: text,
  setup: text,
  source: text,
  link: text,
  resume: text,
  referral: text,
  comp: text,
  // When this application first reached each stage. Stamped once, never
  // cleared - so a rejected application still records the screens it passed.
  dateRecruiterScreen: text,
  dateTechScreen: text,
  dateOnsite: text,
  dateOffer: text,
  dateRejected: text,
  dateWithdrawn: text,
  // The overnight fill of a row added as nothing but a URL.
  // "" = not yet read, "failed" = read and established nothing.
  autofill: text,
  autofill_note: text,
});

export const screenedSchema = z.object({
  id: z.number(),
  search: str,
  url: text,
  company: text,
  title: text,
  location: text,
  reason: text,
  date: text,
});

/**
 * Always present, never null - `getTracksAndSettings` builds it from a LEFT
 * JOIN and defaults every field. `at === ""` is the "never ran" case, which is
 * why this is not `.nullable()`.
 */
export const lastRunSchema = z.object({
  at: text, // ISO 8601 UTC instant
  on: text, // the caller's LOCAL date, YYYY-MM-DD
  status: text, // "ok" | "error" | ""
  leads_added: z.number().default(0),
  screened_added: z.number().default(0),
  delisted: z.number().default(0),
  note: text,
});

export const trackSchema = z.object({
  key: str,
  label: text,
  full_description: text,
  sort_order: z.number().default(0),
  last_run: lastRunSchema,
  // TRACK_CONFIG_FIELDS are on the payload too, but the page renders none of
  // them; listing them here would be a second copy of the server's config
  // vocabulary.
});

/**
 * One ordered location-matching rule. `geo()` walks these in order and the
 * first match wins, so index is rank: 0 is the top tier.
 */
export const priorityLocationSchema = z.object({
  label: str,
  allOf: z.array(z.string()).optional(),
  anyOf: z.array(z.string()).optional(),
});

/**
 * Mirrors DEFAULT_SETTINGS in server/src/db.js. Every key defaults, because a
 * freshly created database has posted no config and must still render a usable
 * page - the same reason the server defaults them.
 */
export const settingsSchema = z.object({
  display_title: z.string().default("Job Search Tracker"),
  overview_label: z.string().default("Overview"),
  applications_label: z.string().default("Applications"),
  all_leads_label: z.string().default("All leads"),
  stale_run_hours: z.number().default(36),
  priority_locations: z.array(priorityLocationSchema).default([]),
  excluded_companies: z.array(z.string()).default([]),
});

export const userSchema = z.object({
  id: z.string(),
  name: text,
});

export const dataSchema = z.object({
  user: userSchema,
  updated: text,
  leads: z.array(leadSchema).default([]),
  applications: z.array(applicationSchema).default([]),
  screened: z.array(screenedSchema).default([]),
  tracks: z.array(trackSchema).default([]),
  settings: settingsSchema,
});

/** `POST /api/login`. `user` is absent on older servers, so the gate falls back to the typed name. */
export const loginSchema = z.object({
  token: z.string().min(1),
  user: userSchema.partial().optional(),
});

export type Lead = z.infer<typeof leadSchema>;
export type Application = z.infer<typeof applicationSchema>;
export type Screened = z.infer<typeof screenedSchema>;
export type Track = z.infer<typeof trackSchema>;
export type LastRun = z.infer<typeof lastRunSchema>;
export type PriorityLocation = z.infer<typeof priorityLocationSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type User = z.infer<typeof userSchema>;
export type TrackerData = z.infer<typeof dataSchema>;
export type LoginResponse = z.infer<typeof loginSchema>;
