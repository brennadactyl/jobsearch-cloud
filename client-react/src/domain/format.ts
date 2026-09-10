/**
 * Dates, durations and URLs. Pure, and the reason the old page's equivalents
 * are worth porting rather than reaching for a date library: each one encodes a
 * decision about what this page should say, not just how to format a number.
 */

/** Whole days since a YYYY-MM-DD or ISO date, or null if there isn't one. Never negative. */
export function daysSince(d: string | null | undefined): number | null {
  if (!d) return null;
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
 * The half of the XSS boundary React does not cover.
 *
 * React escapes text and attribute values, so a company name carrying markup is
 * already safe. It does *not* stop `javascript:` reaching an href - that is a
 * URL the framework will happily render. Lead data comes from job postings read
 * off the internet, and a hand-typed link field is just text, so only http(s)
 * becomes a real anchor here.
 *
 * A bare "acme.com/jobs/1" is common enough to accept (https:// assumed).
 * Anything else - javascript:, data:, a note to self - gets no link at all
 * rather than an href built from whatever was typed. Returns "" when there is
 * nothing safe to open.
 */
export function safeUrl(v: string | null | undefined): string {
  const t = String(v ?? "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w.-]+\.[a-z]{2,}([/?#]|$)/i.test(t)) return `https://${t}`;
  return "";
}

/**
 * The host a link points at ("boards.greenhouse.io"), or "".
 *
 * Stands in for the company on an application that is still nothing but a URL:
 * between pasting one in and the overnight fill reading the posting, it is the
 * only thing known about the row, and a list of rows all reading "Untitled"
 * cannot be told apart. Displayed, never stored - a host is good enough to find
 * a row by and nowhere near good enough to write into the company field as fact.
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
