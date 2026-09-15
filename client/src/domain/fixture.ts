/**
 * A tracker's worth of invented data, shared by the domain and component tests.
 *
 * Shaped after scripts/demo-user.json: leads across every status and both sides
 * of the top location tier, applications across every pipeline stage and both
 * sides of the 14-day line, and one row in each of the overnight fill's states.
 * Every row is invented and every URL is under example.com.
 *
 * Dates are relative to a fixed `NOW`, which the tests freeze - a fixture with
 * literal dates in it silently changes meaning as it ages, and "applied 14+ days
 * ago" is exactly the sort of rule that would start passing or failing on its
 * own.
 */
import type { Application, Lead, Settings, Track, TrackerData } from "../api/schema";

/** 2026-09-10T12:00:00Z. Tests freeze Date.now() here. */
export const NOW = Date.parse("2026-09-10T12:00:00Z");

/** A YYYY-MM-DD date `days` before NOW. */
export function daysAgo(days: number): string {
  return new Date(NOW - days * 86_400_000).toISOString().slice(0, 10);
}

function lead(over: Partial<Lead> & Pick<Lead, "id">): Lead {
  return {
    search: "alpha", found: daysAgo(1), company: "", title: "", location: "",
    url: "", verified: "", fit: "", status: "New", notes: "", delistedOn: "",
    team: "", setup: "", source: "", link: "", resume: "", referral: "", comp: "",
    ...over,
  };
}

function app(over: Partial<Application> & Pick<Application, "id">): Application {
  return {
    leadId: "", company: "", title: "", location: "", dateApplied: "",
    status: "Applied", notes: "", team: "", setup: "", source: "", link: "",
    resume: "", referral: "", comp: "",
    dateRecruiterScreen: "", dateTechScreen: "", dateOnsite: "",
    dateOffer: "", dateRejected: "", dateWithdrawn: "",
    autofill: "", autofill_note: "",
    ...over,
  };
}

export const settings: Settings = {
  display_title: "Fixture Search",
  overview_label: "Overview",
  applications_label: "Applications",
  all_leads_label: "All leads",
  stale_run_hours: 36,
  priority_locations: [
    { label: "Metro core", anyOf: ["springfield", "remote"] },
    { label: "Wider region", anyOf: ["shelbyville"] },
  ],
  excluded_companies: [],
};

export const tracks: Track[] = [
  {
    key: "alpha", label: "Alpha roles", full_description: "Alpha search", sort_order: 1,
    last_run: {
      at: new Date(NOW - 8 * 3_600_000).toISOString(), on: daysAgo(0),
      status: "ok", leads_added: 3, screened_added: 5, delisted: 0, note: "",
    },
  },
  {
    key: "beta", label: "Beta roles", full_description: "Beta search", sort_order: 2,
    last_run: {
      at: new Date(NOW - 8 * 86_400_000).toISOString(), on: daysAgo(8),
      status: "error", leads_added: 0, screened_added: 0, delisted: 0,
      note: "the run reported an error",
    },
  },
];

export const leads: Lead[] = [
  lead({ id: 1, company: "Acme", title: "Eng", location: "Springfield", status: "New", url: "https://example.com/1" }),
  lead({ id: 2, company: "Bolt", title: "Eng", location: "Springfield", status: "Reviewing", url: "https://example.com/2" }),
  lead({ id: 3, company: "Cog", title: "Eng", location: "Springfield", status: "Applied", url: "https://example.com/3" }),
  lead({ id: 4, company: "Dyn", title: "Eng", location: "Springfield", status: "Not a fit", url: "https://example.com/4" }),
  lead({ id: 5, search: "beta", company: "Echo", title: "PM", location: "Shelbyville", status: "New", url: "https://example.com/5" }),
  lead({ id: 6, search: "beta", company: "Fox", title: "PM", location: "Ogdenville", status: "New", url: "https://example.com/6" }),
  lead({ id: 7, search: "beta", company: "Gil", title: "PM", location: "Remote", status: "Reviewing", url: "https://example.com/7" }),
  lead({ id: 8, search: "beta", company: "Hal", title: "PM", location: "Ogdenville", status: "Applied", url: "https://example.com/8" }),
];

export const applications: Application[] = [
  app({ id: 11, company: "Ida", title: "Eng", location: "Springfield", status: "To Apply", link: "https://example.com/11" }),
  app({ id: 12, company: "Jet", title: "Eng", location: "Springfield", status: "To Apply" }),
  app({ id: 13, company: "Kit", title: "Eng", location: "Springfield", dateApplied: daysAgo(2) }),
  app({ id: 14, company: "Lux", title: "Eng", location: "Springfield", dateApplied: daysAgo(40) }),
  app({ id: 15, company: "Mox", title: "Eng", location: "Springfield", dateApplied: daysAgo(52) }),
  // 18 days: inside a 14-day "gone quiet" rule and outside a 21-day one, which
  // is what makes a change to that rule visible at all.
  app({ id: 22, company: "Tau", title: "Eng", location: "Springfield", dateApplied: daysAgo(18) }),
  app({ id: 16, company: "Nix", title: "Eng", location: "Springfield", status: "Recruiter Screen", dateApplied: daysAgo(21), dateRecruiterScreen: daysAgo(13) }),
  app({ id: 17, company: "Opt", title: "Eng", location: "Springfield", status: "Tech Screen", dateApplied: daysAgo(31), dateRecruiterScreen: daysAgo(23), dateTechScreen: daysAgo(16) }),
  app({ id: 18, company: "Pyx", title: "Eng", location: "Springfield", status: "Onsite / Loop", dateApplied: daysAgo(42), dateRecruiterScreen: daysAgo(36), dateTechScreen: daysAgo(29), dateOnsite: daysAgo(19) }),
  app({ id: 19, company: "Qed", title: "Eng", location: "Springfield", status: "Offer", dateApplied: daysAgo(62), dateRecruiterScreen: daysAgo(54), dateTechScreen: daysAgo(47), dateOnsite: daysAgo(40), dateOffer: daysAgo(26) }),
  app({ id: 20, company: "Rho", title: "Eng", location: "Springfield", status: "Rejected", dateApplied: daysAgo(67), dateRecruiterScreen: daysAgo(60), dateRejected: daysAgo(52) }),
  app({ id: 21, company: "Sig", title: "Eng", location: "Springfield", status: "Withdrawn", dateApplied: daysAgo(74), dateWithdrawn: daysAgo(64) }),
  // The two overnight-fill states. Without one of each there is a single group
  // in the applications grid and its whole grouping path goes unexercised.
  app({ id: 23, status: "To Apply", link: "https://example.com/23", autofill: "" }),
  app({ id: 24, status: "To Apply", link: "https://example.com/24", autofill: "failed", autofill_note: "The posting page returned 404" }),
];

export const data: TrackerData = {
  user: { id: "u1", name: "Fixture" },
  updated: daysAgo(0),
  leads,
  applications,
  screened: [],
  tracks,
  settings,
};
