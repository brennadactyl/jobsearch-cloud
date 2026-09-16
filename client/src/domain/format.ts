/**
 * Dates, durations and URLs. No date library: each helper encodes what the page
 * should say, not just how to format a number.
 */

/**
 * Whole days since a YYYY-MM-DD or ISO date, or null if there isn't one. Never
 * negative.
 *
 * A bare date is a calendar day, so it counts calendar days to today: it goes
 * up at local midnight. Read as a UTC instant it would go up at 5pm in Pacific
 * time instead, a day early for the rest of the evening.
 */
export function daysSince(d: string | null | undefined): number | null {
  if (!d) return null;
  const day = localDay(d);
  if (day) return Math.max(0, daysBetween(day, localToday()));
  const t = Date.parse(d);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/** Fractional hours since an instant, for staleness maths. */
export function hoursSince(d: string | null | undefined): number | null {
  if (!d) return null;
  const t = Date.parse(d);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 3_600_000);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A YYYY-MM-DD field as that calendar day, at local midnight, or null. Not
 * `Date.parse`, which reads a bare date as UTC midnight - the previous evening
 * in Pacific time, which files a Monday under the week before.
 */
export function localDay(d: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d ?? "").trim());
  if (!m) return null;
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Rejects 2026-02-31, which Date would roll over into March.
  return day.getMonth() === Number(m[2]) - 1 ? day : null;
}

/** A local date back as YYYY-MM-DD. */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Today at local midnight. */
export function localToday(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/**
 * Whole calendar days from `a` to `b`. Rounded, not floored: across a DST
 * change two local midnights are 23 or 25 hours apart.
 */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** The Monday starting the week `d` falls in, as YYYY-MM-DD. */
export function mondayOf(d: Date): string {
  // Day arithmetic through the constructor, so a DST week still lands on midnight.
  return isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)));
}

/** The Monday of a YYYY-MM-DD field's week, or "" for no date. */
export function weekOf(d: string | null | undefined): string {
  const day = localDay(d);
  return day ? mondayOf(day) : "";
}

/** The Mondays of the last `n` weeks, oldest first, ending with this week. */
export function lastWeeks(n: number, now: Date = localToday()): string[] {
  const monday = localDay(mondayOf(now))!;
  return Array.from({ length: n }, (_, i) =>
    isoDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7 * (n - 1 - i))),
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 8" for 2026-09-08; the input as given when it isn't a date. */
export function shortDate(d: string): string {
  const day = localDay(d);
  return day ? `${MONTHS[day.getMonth()]} ${day.getDate()}` : d;
}

/**
 * Coarse on purpose - the useful distinctions are "today", "yesterday" and
 * "long enough ago that something is wrong", not exact minutes.
 */
export function relWhen(iso: string | null | undefined): string {
  const h = hoursSince(iso);
  if (h === null) return "";
  if (h < 1) return "just now";
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

/**
 * The half of the XSS boundary React does not cover: it escapes text, but will
 * render a `javascript:` href. Lead data comes from postings read off the
 * internet, so only http(s) becomes a link, plus a bare "acme.com/jobs/1"
 * (https assumed). Anything else returns "".
 */
export function safeUrl(v: string | null | undefined): string {
  const t = String(v ?? "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w.-]+\.[a-z]{2,}([/?#]|$)/i.test(t)) return `https://${t}`;
  return "";
}

/**
 * Stands in for the company on a row that is still only a URL, so a list of
 * such rows isn't all "Untitled". Displayed, never stored: a host is not a
 * company name.
 */
export function hostOf(v: string | null | undefined): string {
  const u = safeUrl(v);
  if (!u) return "";
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
