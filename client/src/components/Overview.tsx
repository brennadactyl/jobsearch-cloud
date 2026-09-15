/**
 * Every number here opens the rows behind it. A tile or chart mark declares one
 * `DrillTarget`; `drillCount` turns it into the figure and `pathForTarget` into
 * the link, so what you clicked and what you land in are the same set. The
 * charts' series are built in `domain/overview.ts`.
 */
import { Link } from "react-router-dom";
import type { usePinnedLayout } from "../ui/hooks";
import type { TrackerData } from "../api/schema";
import { ALL_LEADS, LABELS } from "../domain/constants";
import { drillCount, drillRows, type DrillTarget, type RowSource } from "../domain/drills";
import { shortDate } from "../domain/format";
import {
  MIN_FOR_RESPONSE_RATE,
  flow,
  momentum,
  payoff,
  rate,
  responseHistogram,
  tierBars,
  waitingLongest,
  type Count,
  type FoundBreakdown,
  type PayoffRow,
  type FoldId,
  type WeekPoint,
} from "../domain/overview";
import { runState } from "../domain/runs";
import { FORWARD_STAGES } from "../domain/stages";
import { buildTracks, pathForTab, pathForTarget } from "../domain/tabs";
import { selectRow } from "../ui/prefs";
import { RunStamp } from "./bits";
import {
  ChartTable,
  ColumnChart,
  FoldLayer,
  Mark,
  Section,
  StackedBar,
  Subsection,
  TipLayer,
  type BarSegment,
  type ColumnPoint,
} from "./charts";

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
  const src: RowSource = data;
  const tracks = buildTracks(data.tracks);
  const trackKeys = Object.keys(tracks);

  const appliedCount = drillCount({ tab: "applications", drill: "applied" }, src);
  // The complement of the count above, so the two cannot disagree about which
  // rows are which.
  const toApply = data.applications.length - appliedCount;
  const topLabel = settings.priority_locations[0]?.label ?? "Top locations";
  const trackCount = data.tracks.length;

  const tiles: TileSpec[] = [
    { k: "Untriaged", f: "leads marked New", hi: true, tab: ALL_LEADS, filter: "New" },
    { k: topLabel, f: "still open", color: "var(--pri-0)", tab: ALL_LEADS, drill: "top-geo-open" },
    { k: "Open leads", f: `across ${trackCount} tracked search${trackCount === 1 ? "" : "es"}`, tab: ALL_LEADS },
    {
      k: "Applied",
      f: toApply ? `plus ${toApply} still to apply` : "in your Applications tab",
      tab: "applications",
      drill: "applied",
    },
    { k: "In conversation", f: "screen or loop stage", tab: "applications", drill: "in-conversation" },
    { k: "Gone quiet", f: "applied 14+ days ago", tab: "applications", drill: "gone-quiet" },
  ];

  return (
    <TipLayer>
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

      <div className={`panel-scroll${scrolled ? " scrolled" : ""}`} ref={scrollRef} onScroll={onScroll}>
        {/* What a person acts on first; the longer view last. */}
        <FoldLayer>
          <SearchesSection data={data} trackKeys={trackKeys} tracks={tracks} />
          <PipelineSection data={data} appliedCount={appliedCount} toApply={toApply} />
          <MomentumSection data={data} />
        </FoldLayer>
        <div className="note">
          {trackCount
            ? `Scheduled searches across your ${trackCount} tracked search${trackCount === 1 ? "" : "es"} add rows here every day.`
            : "Once a tracked search is set up, its scheduled run adds rows here every day."}{" "}
          Every posting is opened and confirmed live before it lands; nothing arrives from a search snippet alone.
        </div>
      </div>
    </TipLayer>
  );
}

/* ---------------------------------------------------------------- momentum */

function MomentumSection({ data }: { data: TrackerData }) {
  const m = momentum(data);
  const thisWeek = (points: readonly WeekPoint[]) => points[points.length - 1]?.n ?? 0;
  return (
    <Section
      id="momentum"
      title="Momentum"
      sub={`${thisWeek(m.found)} found · ${thisWeek(m.applied)} applied this week`}
    >
      <div className="card ch">
        <WeeksChart
          id="momentum.found"
          title="Positions found"
          noun="found"
          points={m.found}
          detail={(p) =>
            `${p.opens} still on your board${m.removedCounted ? "" : " · postings you removed aren’t counted yet"}`
          }
          opensHeader="Still on your board"
        />
        <WeeksChart id="momentum.applied" title="Applications sent" noun="applied" points={m.applied} />
      </div>
    </Section>
  );
}

function weekName(p: WeekPoint): string {
  return p.current ? "This week so far" : `Week of ${shortDate(p.monday)}`;
}

function WeeksChart({
  id,
  title,
  noun,
  points,
  detail,
  opensHeader,
}: {
  id: FoldId;
  title: string;
  noun: string;
  points: readonly WeekPoint[];
  detail?: (p: WeekPoint) => string;
  opensHeader?: string;
}) {
  const thisWeek = points[points.length - 1]?.n ?? 0;
  const lastWeek = points[points.length - 2]?.n ?? 0;
  const tip = (p: WeekPoint) => `${weekName(p)}: ${p.n} ${noun}${detail ? ` · ${detail(p)}` : ""}`;
  const columns: ColumnPoint[] = points.map((p, i) => ({
    key: p.monday,
    axis: p.current ? "so far" : shortDate(p.monday),
    // Every third label survives a narrow axis, counted back from this week.
    minor: (points.length - 1 - i) % 3 !== 0,
    n: p.n,
    // A week whose postings have all left the board has nothing to open.
    target: p.opens ? p.target : undefined,
    tip: tip(p),
    partial: p.current,
  }));
  return (
    <Subsection
      id={id}
      title={title}
      sub={`${noun[0].toUpperCase()}${noun.slice(1)}: ${thisWeek} this week · ${lastWeek} last week`}
      tableView
    >
      {(asTable) =>
        asTable ? (
          <ChartTable
            label={title}
            rows={points}
            rowKey={(p) => p.monday}
            columns={[
              { header: "Week", cell: weekName },
              {
                header: title,
                num: true,
                cell: (p) => (
                  <Mark n={p.n} target={p.opens ? p.target : undefined} tip={tip(p)}>
                    {p.n}
                  </Mark>
                ),
              },
              ...(opensHeader ? [{ header: opensHeader, num: true, cell: (p: WeekPoint) => p.opens }] : []),
            ]}
          />
        ) : (
          <ColumnChart label={title} points={columns} />
        )
      }
    </Subsection>
  );
}

/* ---------------------------------------------------------------- searches */

function SearchesSection({
  data,
  trackKeys,
  tracks,
}: {
  data: TrackerData;
  trackKeys: string[];
  tracks: ReturnType<typeof buildTracks>;
}) {
  const { settings } = data;
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
    <Section id="searches" title="Daily searches" sub={subline}>
      {!trackKeys.length ? (
        <div className="card empty">
          <strong>No searches set up yet</strong>
          Run the job-search-setup skill to add a tracked search. Once one exists, its daily run reports in here —
          including the days it finds nothing.
        </div>
      ) : (
        <div className="card ch">
          <PayoffTable data={data} tracks={tracks} />
          <TierChart data={data} />
        </div>
      )}
    </Section>
  );
}

function foundTip(n: number, b: FoundBreakdown): string {
  const parts = [
    `${b.open} open`,
    `${b.notAFit} not a fit`,
    `${b.applied} moved to Applications`,
    `${b.removed} removed`,
    ...(b.other ? [`${b.other} in another status`] : []),
  ];
  return `${n} found: ${parts.join(" · ")}`;
}

function CountCell({ c, tip }: { c: Count | null; tip: string }) {
  if (!c) return null;
  return (
    <Mark n={c.n} target={c.target} tip={`${tip}: ${c.n}`} className="cnt">
      {c.n}
    </Mark>
  );
}

function RateCell({ part, whole, min = 1, tip }: { part: number; whole: number; min?: number; tip: string }) {
  const pct = rate(part, whole, min);
  if (pct === null) return null;
  return (
    <Mark n={0} tip={`${tip}: ${part} of ${whole}`} className="rate" focusable>
      <span className="mono">{pct}%</span>
      <span className="rate-meter" aria-hidden="true">
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
    </Mark>
  );
}

function PayoffTable({ data, tracks }: { data: TrackerData; tracks: ReturnType<typeof buildTracks> }) {
  const { rows, total } = payoff(data);
  const line = (r: PayoffRow, isTotal = false) => {
    const name = isTotal ? "All searches" : r.label;
    return (
      <tr key={r.key || "hand"} className={isTotal ? "total" : undefined}>
        <td>
          {r.key && !isTotal ? (
            <>
              <Link className="jumplink" to={pathForTab(r.key)} title="Open this tab">
                {r.label}
              </Link>
              <div className="payoff-run">
                <RunStamp track={tracks[r.key]} settings={data.settings} />
              </div>
            </>
          ) : (
            r.label
          )}
        </td>
        <td className="num">
          {r.found && (
            <Mark n={0} tip={foundTip(r.found.n, r.found.breakdown)} className="cnt plain" focusable>
              {r.found.n}
            </Mark>
          )}
        </td>
        <td className="num">
          <CountCell c={r.open} tip={`${name} · ${LABELS.open}`} />
        </td>
        <td className="num">
          <CountCell c={r.notAFit} tip={`${name} · ${LABELS.notAFit}`} />
        </td>
        <td className="num">
          <CountCell c={r.applied} tip={`${name} · ${LABELS.applied}`} />
        </td>
        <td className="num">
          <CountCell c={r.responded} tip={`${name} · ${LABELS.responded}`} />
        </td>
        <td>{r.found && <RateCell part={r.applied.n} whole={r.found.n} tip={`${name} · ${LABELS.applyRate}`} />}</td>
        <td>
          <RateCell
            part={r.responded.n}
            whole={r.applied.n}
            min={MIN_FOR_RESPONSE_RATE}
            tip={`${name} · ${LABELS.responseRate}`}
          />
        </td>
      </tr>
    );
  };
  return (
    <Subsection id="searches.payoff" title="Which searches pay off" sub="Every posting each search has found, and where it went">
      {() => (
        <div className="ch-table">
          <table className="payoff" aria-label="Which searches pay off">
            <thead>
              <tr>
                <th>{LABELS.search}</th>
                <th className="num">{LABELS.found}</th>
                <th className="num">{LABELS.open}</th>
                {/* Headers wrap in a narrow window; "a fit" stays together so this one breaks once. */}
                <th className="num">{LABELS.notAFit.replace(/ a /i, (m) => `${m.trimEnd()} `)}</th>
                <th className="num">{LABELS.applied}</th>
                <th className="num">{LABELS.responded}</th>
                <th>{LABELS.applyRate}</th>
                <th>{LABELS.responseRate}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => line(r))}
              {line(total, true)}
            </tbody>
          </table>
        </div>
      )}
    </Subsection>
  );
}

const TIER_TONES: Record<string, string> = { applied: "s-accent", open: "s-soft", "not-a-fit": "s-line" };

function TierChart({ data }: { data: TrackerData }) {
  const bars = tierBars(data);
  if (!bars.length) return null;
  const totals = bars.map((b) => b.segments.reduce((s, x) => s + x.n, 0));
  const max = Math.max(1, ...totals);
  const segs = (b: (typeof bars)[number], total: number): BarSegment[] =>
    b.segments.map((s) => ({
      ...s,
      tone: TIER_TONES[s.key],
      tip: `${b.label} · ${s.label}: ${s.n}${total ? ` (${Math.round((s.n / total) * 100)}%)` : ""}`,
    }));
  return (
    <Subsection id="searches.location" title="By location" sub="Applied, open and not a fit, per location tier" tableView>
      {(asTable) =>
        asTable ? (
          <ChartTable
            label="By location"
            rows={bars.map((b, i) => ({ b, segments: segs(b, totals[i]) }))}
            rowKey={(r) => r.b.key}
            columns={[
              { header: LABELS.locationTier, cell: (r) => r.b.label },
              ...bars[0].segments.map((seg, j) => ({
                header: seg.label,
                num: true,
                cell: (r: { segments: BarSegment[] }) => {
                  const s = r.segments[j];
                  return (
                    <Mark n={s.n} target={s.target} tip={s.tip}>
                      {s.n}
                    </Mark>
                  );
                },
              })),
            ]}
          />
        ) : (
          <div className="hbars">
            {bars.map((b, i) => (
              <div key={b.key}>
                <div className="hrow-head">
                  <span>{b.label}</span>
                  <span className="mono">{totals[i]}</span>
                </div>
                <StackedBar label={b.label} segments={segs(b, totals[i])} scale={totals[i] / max} />
              </div>
            ))}
          </div>
        )
      }
    </Subsection>
  );
}

/* ---------------------------------------------------------------- pipeline */

const FLOW_TONES: Record<string, string> = {
  "moved-on": "s-accent",
  waiting: "s-soft",
  rejected: "s-crit",
  withdrew: "s-line",
};

function PipelineSection({ data, appliedCount, toApply }: { data: TrackerData; appliedCount: number; toApply: number }) {
  const active = drillCount({ tab: "applications", drill: "in-conversation" }, data);
  return (
    <Section
      id="pipeline"
      title="Application pipeline"
      sub={appliedCount ? `${appliedCount} applied · ${active} in active conversation` : "Nothing applied yet"}
    >
      {!appliedCount ? (
        <div className="card empty">
          <strong>No applications yet</strong>
          {toApply
            ? `You have ${toApply} queued to apply in the Applications tab — the pipeline fills in once you mark one Applied.`
            : "Move a lead to Applied, or add one directly from the Applications tab, and its progress shows up here."}
        </div>
      ) : (
        <>
          <div className="card ch">
            <FlowChart data={data} appliedCount={appliedCount} />
          </div>
          <div className="card ch ch-split">
            <ResponseChart data={data} />
            <WaitingList data={data} />
          </div>
        </>
      )}
    </Section>
  );
}

function FlowChart({ data, appliedCount }: { data: TrackerData; appliedCount: number }) {
  const { bars, offer } = flow(data);
  const segs = (b: (typeof bars)[number]): BarSegment[] =>
    b.segments.map((s) => ({
      ...s,
      tone: FLOW_TONES[s.key],
      tip: `${b.label} · ${s.label}: ${s.n} of ${b.reached.n}${b.reached.n ? ` (${Math.round((s.n / b.reached.n) * 100)}%)` : ""}`,
    }));
  const name = "Where applications move on or stall";
  return (
    <Subsection id="pipeline.flow" title={name} sub="Each bar is every application that reached the stage" tableView>
      {(asTable) => (
        <>
          {asTable ? (
            <ChartTable
              label={name}
              rows={bars}
              rowKey={(b) => b.slug}
              columns={[
                { header: LABELS.status, cell: (b) => b.label },
                {
                  header: "Reached",
                  num: true,
                  cell: (b) => (
                    <Mark n={b.reached.n} target={b.reached.target} tip={`Reached ${b.label}: ${b.reached.n}`}>
                      {b.reached.n}
                    </Mark>
                  ),
                },
                ...bars[0].segments.map((seg, j) => ({
                  header: seg.label,
                  num: true,
                  cell: (b: (typeof bars)[number]) => {
                    const s = segs(b)[j];
                    return (
                      <Mark n={s.n} target={s.target} tip={s.tip}>
                        {s.n}
                      </Mark>
                    );
                  },
                })),
              ]}
            />
          ) : (
            <div className="hbars">
              {bars.map((b) => (
                <div key={b.slug}>
                  <div className="hrow-head">
                    <Mark
                      n={b.reached.n}
                      target={b.reached.target}
                      tip={`Reached ${b.label}: ${b.reached.n}`}
                      className="jumplink"
                    >
                      {b.label}
                    </Mark>
                    <span className="mono">{b.reached.n}</span>
                  </div>
                  <StackedBar label={b.label} segments={segs(b)} />
                </div>
              ))}
            </div>
          )}
          <FlowFoot data={data} offer={offer} appliedCount={appliedCount} />
        </>
      )}
    </Subsection>
  );
}

/** The Offer row that closes the flow, and the outcome legend under it. */
function FlowFoot({ data, offer, appliedCount }: { data: TrackerData; offer: Count; appliedCount: number }) {
  const sent = drillRows({ tab: "applications", drill: "applied" }, data);
  const countStatus = (s: string) => sent.filter((a) => a.status === s).length;
  const heard = drillCount({ tab: "applications", drill: "responded" }, data);
  const offerLabel = FORWARD_STAGES[FORWARD_STAGES.length - 1].label;
  return (
    <>
      <div className="hrow-head offer-row">
        <Mark n={offer.n} target={offer.target} tip={`Reached ${offerLabel}: ${offer.n}`} className="jumplink">
          {offerLabel}
        </Mark>
        <span className="mono">{offer.n}</span>
      </div>
      {/* "Responded" counts a rejection as a response - it is one, just not a
          forward one. Withdrawn is excluded: it is your action, not the
          company's. */}
      <div className="legend ch-foot">
        <span>
          <b className="s-good" />
          {countStatus("Offer")} offer{countStatus("Offer") === 1 ? "" : "s"}
        </span>
        <span>
          <b className="s-crit" />
          {countStatus("Rejected")} rejected
        </span>
        <span>
          <b className="s-line" />
          {countStatus("Withdrawn")} withdrawn
        </span>
        <span className="legend-run">{Math.round((heard / appliedCount) * 100)}% responded</span>
      </div>
    </>
  );
}

function ResponseChart({ data }: { data: TrackerData }) {
  const h = responseHistogram(data);
  const replies = h.bins.reduce((s, b) => s + b.n, 0);
  const tip = (b: (typeof h.bins)[number]) =>
    `First reply in ${b.label}: ${b.n}${replies ? ` (${Math.round((b.n / replies) * 100)}%)` : ""}`;
  return (
    <Subsection
      id="pipeline.reply"
      title="Time to first reply"
      sub={h.median === null ? "No replies yet" : `Median ${h.median} day${h.median === 1 ? "" : "s"}`}
      tableView
    >
      {(asTable) =>
        asTable ? (
          <ChartTable
            label="Time to first reply"
            rows={h.bins}
            rowKey={(b) => b.key}
            columns={[
              { header: "Days", cell: (b) => b.label },
              {
                header: "Applications",
                num: true,
                cell: (b) => (
                  <Mark n={b.n} target={b.target} tip={tip(b)}>
                    {b.n}
                  </Mark>
                ),
              },
            ]}
          />
        ) : (
          <ColumnChart
            label="Time to first reply"
            points={h.bins.map((b) => ({
              key: b.key,
              axis: b.label.replace(" days", "d"),
              n: b.n,
              target: b.target,
              tip: tip(b),
            }))}
          />
        )
      }
    </Subsection>
  );
}

function WaitingList({ data }: { data: TrackerData }) {
  const rows = waitingLongest(data);
  return (
    <Subsection id="pipeline.waiting" title="Waiting longest" sub="Since each last moved">
      {() => (
        <>
          {!rows.length ? (
            <p className="ch-empty">Nothing is waiting on a reply.</p>
          ) : (
            <ol className="waitlist">
              {rows.map(({ app, days }) => (
                <li key={app.id}>
                  {/* Selecting the row first is what makes the tab open on it. */}
                  <Link
                    className="wait-row"
                    to={pathForTab("applications")}
                    onClick={() => selectRow("applications", String(app.id))}
                  >
                    <span className="wait-co">{app.company || "Untitled"}</span>
                    <span className="wait-role">{app.title}</span>
                    <span className="wait-meta">
                      {app.status} · <span className="mono">{days} day{days === 1 ? "" : "s"}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
          <Link className="jumplink ch-more" to={pathForTarget({ tab: "applications", drill: "waiting" })}>
            See all waiting ›
          </Link>
        </>
      )}
    </Subsection>
  );
}
