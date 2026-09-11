/**
 * Dates, durations and URLs. No date library: each helper encodes what the page
 * should say, not just how to format a number.
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
