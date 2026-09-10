/**
 * Vocabulary shared with the server, duplicated here on purpose.
 *
 * These mirror LEAD_STATUS / APP_STATUS in server/src/routes/, the same way
 * client/public/index.html does. Nothing ties the two together yet - a shared
 * types package is the natural follow-on if this client ever replaces that one,
 * and is deliberately out of scope until then (see docs/react-adoption-plan.md).
 */

/** server/src/routes/leads.js */
export const LEAD_STATUS = ["New", "Reviewing", "Applied", "Not a fit"] as const;

/**
 * server/src/routes/applications.js. "To Apply" is a posting parked here before
 * applying to it - tracked, but not sent, so it has no applied date until it
 * moves on.
 */
export const APP_STATUS = [
  "To Apply", "Applied", "Recruiter Screen", "Tech Screen",
  "Onsite / Loop", "Offer", "Rejected", "Withdrawn",
] as const;

/** The stages that mean a conversation is live rather than finished. */
export const ACTIVE: readonly string[] = ["Recruiter Screen", "Tech Screen", "Onsite / Loop"];

/**
 * One date column per pipeline stage an application has reached. "Applied" is
 * not here - it has `dateApplied`. Stamped once when the status first reaches
 * the stage and never cleared, so an application rejected after a tech screen
 * still records that it reached one.
 */
export const STAGE_DATE_FIELDS: readonly (readonly [label: string, field: string])[] = [
  ["Recruiter Screen", "dateRecruiterScreen"],
  ["Tech Screen", "dateTechScreen"],
  ["Onsite / Loop", "dateOnsite"],
  ["Offer", "dateOffer"],
  ["Rejected", "dateRejected"],
  ["Withdrawn", "dateWithdrawn"],
];

/** "Applied" first - the order Stage history renders in. */
export const STAGE_HISTORY_FIELDS: readonly (readonly [field: string, label: string])[] = [
  ["dateApplied", "Applied"],
  ...STAGE_DATE_FIELDS.map(([label, field]) => [field, label] as const),
];

/** Facts about the opportunity itself, stable once entered. */
export const ROLE_FIELDS: readonly (readonly [field: string, label: string])[] = [
  ["referral", "Referral"],
  ["comp", "Comp range"],
  ["team", "Team / product"],
  ["setup", "Work setup"],
];

/**
 * Applications add "link": a hand-added one has no posting URL to fall back on,
 * whereas a lead already carries its own `url`.
 */
export const APP_ROLE_FIELDS: readonly (readonly [field: string, label: string])[] = [
  ...ROLE_FIELDS,
  ["link", "Link"],
];

export const LEAD_SORTS: readonly (readonly [key: string, label: string])[] = [
  ["priority", "Priority"],
  ["found-desc", "Newest found"],
  ["found-asc", "Oldest found"],
  ["location-asc", "Location A-Z"],
  ["company-asc", "Company A-Z"],
];

export const APP_SORTS: readonly (readonly [key: string, label: string])[] = [
  ["applied-desc", "Newest applied"],
  ["applied-asc", "Oldest applied"],
  ["location-asc", "Location A-Z"],
  ["company-asc", "Company A-Z"],
];

/**
 * The cross-track leads tab. A tab id, not a track key - the same shape as
 * "dashboard" and "applications", which are also ids no track can usefully have.
 */
export const ALL_LEADS = "allleads";

/** Status -> the CSS pill class that colours it. */
export function pillFor(status: string): string {
  const map: Record<string, string> = {
    "New": "new", "Reviewing": "hot", "Applied": "go", "Not a fit": "no",
    "To Apply": "new",
    "Recruiter Screen": "hot", "Tech Screen": "hot", "Onsite / Loop": "hot",
    "Offer": "go", "Rejected": "bad", "Withdrawn": "no",
  };
  return map[status] || "live";
}

/**
 * status -> the history column it stamps. Mirrors STAGE_DATE_MAP in
 * server/src/routes/applications.js - the same intentional duplication as
 * APP_STATUS itself. Used to decide whether picking a status needs to ask for a
 * date first.
 */
export const APP_STAGE_DATE_MAP: Record<string, string> = {
  Applied: "dateApplied",
  ...Object.fromEntries(STAGE_DATE_FIELDS.map(([label, field]) => [label, field])),
};
