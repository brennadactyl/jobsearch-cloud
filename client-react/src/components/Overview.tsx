/**
 * Every number here opens the rows behind it. A tile or funnel row declares one
 * `DrillTarget`; `drillCount` turns it into the figure and `pathForTarget` into
 * the link, so what you clicked and what you land in are the same set.
 */
import { Link } from "react-router-dom";
import type { usePinnedLayout } from "../ui/hooks";
import type { TrackerData } from "../api/schema";
import { ALL_LEADS, LEAD_STATUS, STAGE_DATE_FIELDS } from "../domain/constants";
import { drillCount, drillRows, type DrillTarget, type RowSource } from "../domain/drills";
import { runState } from "../domain/runs";
import { buildTracks, pathForTab, pathForTarget } from "../domain/tabs";
import { RunStamp } from "./bits";

interface TileSpec extends DrillTarget {
  k: string;
  f: string;
  hi?: boolean;
  color?: string;
}

export default function Overview({
  data,
  scrollRef,
  scrolled,
  onScroll,
}: {
  data: TrackerData;
} & Pick<ReturnType<typeof usePinnedLayout>, "scrollRef" | "scrolled" | "onScroll">) {
  const { settings } = data;
  const src: RowSource = { leads: data.leads, applications: data.applications, settings };
  const tracks = buildTracks(data.tracks);
  const trackKeys = Object.keys(tracks);

  const appliedRows = drillRows({ tab: "applications", drill: "applied" }, src);
  const appliedCount = appliedRows.length;
  const active = drillCount({ tab: "applications", drill: "in-conversation" }, src);
  // The complement of the count above, so the two cannot disagree about which
  // rows are which.
  const toApply = data.applications.length - appliedCount;
  const topLabel = settings.priority_locations[0]?.label ?? "Top locations";
  const trackCount = data.tracks.length;

  const tiles: TileSpec[] = [
    { k: "Untriaged", f: "leads marked New", hi: true, tab: ALL_LEADS, filter: "New" },
    { k: topLabel, f: "still open", color: "var(--pri-0)", tab: ALL_LEADS, drill: "top-geo-open" },
    { k: "Tracked leads", f: `across ${trackCount} tracked search${trackCount === 1 ? "" : "es"}`, tab: ALL_LEADS },
    {
      k: "Applied",
      f: toApply ? `plus ${toApply} still to apply` : "in your Applications tab",
      tab: "applications",
      drill: "applied",
    },
    { k: "In conversation", f: "screen or loop stage", tab: "applications", drill: "in-conversation" },
    { k: "Gone quiet", f: "applied 14+ days ago", tab: "applications", drill: "gone-quiet" },
  ];

  // Whether every scheduled search is still firing is the one thing the lead
  // counts genuinely cannot show - a search that stopped running and a search
  // that found nothing produce the same unchanged numbers.
  const bad = trackKeys.filter((k) => ["stale", "error"].includes(runState(tracks[k].last_run, settings)));
  const never = trackKeys.filter((k) => runState(tracks[k].last_run, settings) === "never");
  let subline: string;
  if (!trackKeys.length) subline = "No tracks configured yet";
  else if (bad.length) subline = `${bad.length} of ${trackKeys.length} haven’t reported a clean run recently`;
  else if (never.length === trackKeys.length) subline = "Waiting on the first recorded run";
  else subline = `All ${trackKeys.length} reporting on schedule`;

  return (
    <>
      <div className="tiles">
        {tiles.map((t) => {
          const v = drillCount(t, src);
          const inner = (
            <>
              <div className="k">
                {t.k}
                {!!v && (
                  <span className="go" aria-hidden="true">
                    ›
                  </span>
                )}
              </div>
              <div className="v mono" style={t.color ? { color: t.color } : undefined}>
                {v}
              </div>
              <div className="f">{t.f}</div>
            </>
          );
          // A tile counting zero has nothing to open and says so by being
          // disabled - derived from the count, so it comes back on its own.
          return v ? (
            <Link key={t.k} className={`tile${t.hi ? " hi" : ""}`} to={pathForTarget(t)}>
              {inner}
            </Link>
          ) : (
            <button key={t.k} type="button" className={`tile${t.hi ? " hi" : ""}`} disabled title="Nothing to open yet">
              {inner}
            </button>
          );
        })}
      </div>

      <div
        className={`panel-scroll${scrolled ? " scrolled" : ""}`}
        ref={scrollRef}
        onScroll={onScroll}
      >
      <PanelBody
        data={data}
        src={src}
        subline={subline}
        trackKeys={trackKeys}
        tracks={tracks}
        appliedCount={appliedCount}
        appliedRows={appliedRows}
        active={active}
        toApply={toApply}
        trackCount={trackCount}
      />
      </div>
    </>
  );
}

function PanelBody({
  data,
  src,
  subline,
  trackKeys,
  tracks,
  appliedCount,
  appliedRows,
  active,
  toApply,
  trackCount,
}: {
  data: TrackerData;
  src: RowSource;
  subline: string;
  trackKeys: string[];
  tracks: ReturnType<typeof buildTracks>;
  appliedCount: number;
  appliedRows: ReturnType<typeof drillRows>;
  active: number;
  toApply: number;
  trackCount: number;
}) {
  const { settings } = data;
  const cols: Record<string, string> = {
    New: "var(--accent)",
    Reviewing: "var(--warn)",
    Applied: "var(--good)",
    "Not a fit": "var(--line)",
  };

  const funnel: { label: string; drill: string; n: number }[] = [
    { label: "Applied", drill: "applied", n: appliedCount },
    ...STAGE_DATE_FIELDS.slice(0, 4).map(([label, field]) => ({
      label,
      drill: `reached-${field}`,
      n: drillCount({ tab: "applications", drill: `reached-${field}` }, src),
    })),
  ];

  const RESPONSE_FIELDS = ["dateRecruiterScreen", "dateTechScreen", "dateOnsite", "dateOffer", "dateRejected"];
  const rows = appliedRows as unknown as Record<string, string>[];
  const responded = rows.filter((a) => RESPONSE_FIELDS.some((f) => a[f])).length;
  const respTimes = rows
    .map((a) => {
      if (!a.dateApplied) return null;
      const d0 = Date.parse(a.dateApplied);
      if (Number.isNaN(d0)) return null;
      let earliest: number | null = null;
      for (const f of RESPONSE_FIELDS) {
        if (!a[f]) continue;
        const d = Date.parse(a[f]);
        if (Number.isNaN(d)) continue;
        if (earliest === null || d < earliest) earliest = d;
      }
      if (earliest === null) return null;
      const days = Math.round((earliest - d0) / 86_400_000);
      return days >= 0 ? days : null;
    })
    .filter((n): n is number => n !== null);
  const avgResp = respTimes.length ? Math.round(respTimes.reduce((a, b) => a + b, 0) / respTimes.length) : null;
  const countStatus = (s: string) => appliedRows.filter((a) => a.status === s).length;

  return (
    <>
      <div className="sec">
        <h2>Daily searches</h2>
        <p>{subline}</p>
      </div>

      {!trackKeys.length ? (
        <div className="card empty">
          <strong>No searches set up yet</strong>
          Run the job-search-setup skill to add a tracked search. Once one exists, its daily run reports in here —
          including the days it finds nothing.
        </div>
      ) : (
        <div className="card" style={{ padding: 19 }}>
          <div className="bars">
            {trackKeys.map((k) => {
              const trackLeads = data.leads.filter((l) => l.search === k);
              const byStatus = LEAD_STATUS.map((s) => ({ s, n: trackLeads.filter((r) => r.status === s).length }));
              const tot = trackLeads.length || 1;
              return (
                <div className="bar" key={k}>
                  <h3>
                    {/* The name opens that track's tab. Only the name: the row
                        also carries the description and the run stamp, and a
                        click target that wide would swallow selecting either. */}
                    <Link className="jumplink" to={pathForTab(k)} title="Open this tab">
                      {tracks[k].label}
                    </Link>{" "}
                    <span>
                      {tracks[k].full_description} &middot; {trackLeads.length}
                    </span>
                  </h3>
                  <div className="meter">
                    {byStatus.map((b) =>
                      b.n ? <i key={b.s} style={{ width: `${(b.n / tot) * 100}%`, background: cols[b.s] }} /> : null,
                    )}
                  </div>
                  <div className="legend">
                    {byStatus
                      .filter((b) => b.n)
                      .map((b) => (
                        <span key={b.s}>
                          <b style={{ background: cols[b.s] }} />
                          {b.s} {b.n}
                        </span>
                      ))}
                    {!trackLeads.length && <span style={{ color: "var(--ink3)" }}>No postings found yet</span>}
                    <span className="legend-run">
                      <RunStamp track={tracks[k]} settings={settings} />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="sec">
        <h2>Application pipeline</h2>
        <p>{appliedCount ? `${appliedCount} applied · ${active} in active conversation` : "Nothing applied yet"}</p>
      </div>

      {!appliedCount ? (
        <div className="card empty">
          <strong>No applications yet</strong>
          {toApply
            ? `You have ${toApply} queued to apply in the Applications tab — the funnel fills in once you mark one Applied.`
            : "Move a lead to Applied, or add one directly from the Applications tab, and its progress shows up here."}
        </div>
      ) : (
        <div className="card" style={{ padding: 19 }}>
          <div className="bars">
            {funnel.map((r, i) => {
              const pct = Math.round((r.n / appliedCount) * 100);
              const color = i === 0 ? "var(--ink3)" : i === funnel.length - 1 ? "var(--good)" : "var(--accent)";
              return (
                <div className="bar" key={r.drill}>
                  <h3>
                    {/* A stage nothing has reached has no rows to open, so it
                        stays plain text rather than a link to an empty list. */}
                    {r.n ? (
                      <Link
                        className="jumplink"
                        to={pathForTarget({ tab: "applications", drill: r.drill })}
                        title="Open these in Applications"
                      >
                        {r.label}
                      </Link>
                    ) : (
                      <span className="jumpdead" title="Nothing has reached this stage yet">
                        {r.label}
                      </span>
                    )}{" "}
                    <span>
                      {r.n} &middot; {pct}%
                    </span>
                  </h3>
                  <div className="meter">
                    <i style={{ width: `${pct}%`, background: color }} />
                  </div>
                </div>
              );
            })}
          </div>
          {/* "Responded" counts a rejection as a response - it is one, just not
              a forward one - so it is deliberately a larger number than the
              funnel's forward-progress stages. Withdrawn is excluded from both
              halves: it is your action, not the company's. */}
          <div className="legend" style={{ marginTop: 15, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <span>
              <b style={{ background: "var(--good)" }} />
              {countStatus("Offer")} offer{countStatus("Offer") === 1 ? "" : "s"}
            </span>
            <span>
              <b style={{ background: "var(--crit)" }} />
              {countStatus("Rejected")} rejected
            </span>
            <span>
              <b style={{ background: "var(--ink3)" }} />
              {countStatus("Withdrawn")} withdrawn
            </span>
            <span className="legend-run">
              {Math.round((responded / appliedCount) * 100)}% responded
              {avgResp !== null && ` · avg ${avgResp}d to first response`}
            </span>
          </div>
        </div>
      )}

      <div className="note">
        {trackCount
          ? `Scheduled searches across your ${trackCount} tracked search${trackCount === 1 ? "" : "es"} add rows here every day.`
          : "Once a tracked search is set up, its scheduled run adds rows here every day."}{" "}
        Every posting is opened and confirmed live before it lands; nothing arrives from a search snippet alone.
      </div>
    </>
  );
}
