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
  added_by: text, // "run" | "hand" | "" for rows older than the column
  // The removed lead's found date, "" if it never was a lead. Absent (not "")
  // from a server without the column, which is how the Overview knows its
  // weekly found counts can't include removed postings yet.
  found: z.string().nullish(),
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
  /** The search that fills this tab, "" when it runs its own. The account panel gives only running searches a resume. */
  fed_by: text,
  // TRACK_CONFIG_FIELDS are on the payload too, but the page renders none of
  // them; listing them here would be a second copy of the server's config
  // vocabulary.
});

/**
 * One ordered location-matching rule. `matchLocationTier()` walks these in order and the
 * first match wins, so index is rank: 0 is the top tier.
 */
export const priorityLocationSchema = z.object({
  label: str,
  allOf: z.array(z.string()).optional(),
  anyOf: z.array(z.string()).optional(),
});

/** The server's default too (DEFAULT_SETTINGS in server/src/db.js); used wherever a stored value is missing or zero. */
export const DEFAULT_STALE_RUN_HOURS = 36;

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
  stale_run_hours: z.number().default(DEFAULT_STALE_RUN_HOURS),
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

/** GET /api/invite/<code>: whether an invite link can still make an account. */
export const INVITE_REASONS = ["invalid", "used", "expired", "revoked"] as const;
export const inviteCheckSchema = z.discriminatedUnion("valid", [
  z.object({ valid: z.literal(true), expires_at: text }),
  z.object({ valid: z.literal(false), reason: z.enum(INVITE_REASONS) }),
]);

/** The three the nightly prompt knows (PRONOUNS in server/src/prompt.js); "" is unset, which it reads as they/them. */
export const PRONOUNS = ["she/her", "he/him", "they/them"] as const;

/**
 * The setup form's answers, stored by POST /api/intake exactly as sent and read
 * by the onboarding run. Every key defaults, so a partly filled or older stored
 * answer still parses.
 */
export const roleAnswerSchema = z.object({
  name: str.default(""),
  titles: str.default(""),
  company_kinds: str.default(""),
  rule_outs: str.default(""),
  min_pay: str.default(""),
});
export const intakeAnswersSchema = z.object({
  page_title: str.default(""),
  pronouns: z.enum(["", ...PRONOUNS]).default(""),
  resume_text: str.default(""),
  resume_files: z.array(str).default([]),
  work_scope: str.default(""),
  location_limits: str.default(""),
  locations_first: str.default(""),
  priority_locations: z.array(priorityLocationSchema).default([]),
  roles: z.array(roleAnswerSchema).default([]),
  never_work_for: str.default(""),
  preferences: str.default(""),
});
export const intakeSchema = z.object({
  answers: intakeAnswersSchema,
  status: z.enum(["pending", "done", "failed"]),
  status_note: text,
  sent_at: text,
  updated_at: text,
  /** When the run stops retrying a failed setup; "" when there's no send to count from. */
  retries_end_at: str.default(""),
});
export const intakeResponseSchema = z.object({ intake: intakeSchema.nullable() });
/** A send builds the tracks itself and names them; the tracker data is read back separately. */
export const intakeSentSchema = z.object({ ok: z.literal(true), tracks: z.array(str) });

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
export type InviteCheck = z.infer<typeof inviteCheckSchema>;
export type InviteReason = (typeof INVITE_REASONS)[number];
export type RoleAnswer = z.infer<typeof roleAnswerSchema>;
export type IntakeAnswers = z.infer<typeof intakeAnswersSchema>;
export type Intake = z.infer<typeof intakeSchema>;

/**
 * One stored document, from `GET /api/documents`. The fields past `uploaded`
 * are on resumes only: what the server could read of it, and which searches read
 * it. A .docx carries the words and searches of the text read from it, and that
 * text is listed too, with `paired_with` naming the .docx.
 */
export const storedResumeSchema = z.object({
  path: str,
  bytes: z.number().default(0),
  uploaded: text,
  readable: z.boolean().nullish().transform((v) => v ?? false),
  words: z.number().nullish(),
  /** null on a Word file whose text was never read, e.g. one stored before Word files were read on upload. */
  text_path: z.string().nullish(),
  paired_with: z.string().nullish(),
  used_by: z
    .array(
      z.object({
        /** A running search's key. */
        search: str,
        /** That search's tab first, then the tabs it fills. */
        tabs: z.array(str),
        /** "from_next_run" and "until_next_run" hold while a saved change waits for the search's next run. */
        state: z.enum(["reads", "from_next_run", "until_next_run"]),
      }),
    )
    .nullish()
    .transform((v) => v ?? []),
});
export type StoredResume = z.infer<typeof storedResumeSchema>;
