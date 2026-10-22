import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, Navigate, Route, Routes, useLocation, useParams, useSearchParams } from "react-router-dom";
import type { TrackerData } from "../api/schema";
import { ALL_LEADS, APPLICATIONS, DASHBOARD } from "../domain/constants";
import { pausedDay } from "../domain/runs";
import { SCREENED } from "../domain/screened";
import { buildTabs, buildTracks, pathForTab } from "../domain/tabs";
import { usePinnedLayout, useTheme } from "../ui/hooks";
import { useSaved } from "../ui/saved";
import { edgeToShow, hiddenSides, nextEdge } from "../ui/tabScroll";
import { useWheelAnywhere } from "../ui/wheel";
import ApplicationsTab from "./ApplicationsTab";
import AccountPanel from "./AccountPanel";
import LeadsTab from "./LeadsTab";
import Overview from "./Overview";
import ScreenedTab from "./ScreenedTab";

/** The same sentence the run stamp gives, on a tab that has room for one word. */
function pausedTitle(paused: string): string {
  const day = pausedDay(paused);
  return `Paused${day ? ` since ${day}` : ""}: this search doesn't run until it's resumed. Its leads stay here.`;
}

/**
 * The tab strip scrolls when its tabs don't fit, which a portrait monitor or a
 * sixth search makes ordinary rather than rare. Nothing in the bar itself says
 * so - the scrollbar is hidden in both engines - and the tab that falls off the
 * end first is Screened, the one tab with no other route to it.
 *
 * So each end gets an arrow while that end has something hidden. Both ends,
 * because reaching Screened puts Overview off the other side with nothing
 * pointing back; only while hidden, because a dead stub at a width where
 * everything fits is its own small wrongness.
 */
function useTabOverflow(tabCount: number, selectedPath: string) {
  const strip = useRef<HTMLElement>(null);
  const [hidden, setHidden] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = strip.current;
    if (el) {
      setHidden(hiddenSides(el));
    }
  }, []);

  // Resize because the window is what changes whether they fit; the children
  // because a search added or removed changes it without a resize.
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, tabCount]);

  // The tab you are on is the one that has to be readable, and arriving is
  // when it might not be: a reload, a typed address or a figure that opens a
  // tab all land without the strip having moved. Jumping rather than gliding,
  // because this is where the strip should have been on arrival rather than
  // somewhere a press is taking it.
  useEffect(() => {
    const el = strip.current;
    const tab = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && tab) {
      el.scrollLeft = edgeToShow({ start: tab.offsetLeft, end: tab.offsetLeft + tab.offsetWidth }, el);
      measure();
    }
  }, [measure, selectedPath, tabCount]);

  return { strip, hidden, measure };
}

/**
 * One end's arrow. A button rather than a styled div, so it is reachable by
 * keyboard, and named, because an icon alone is the one thing a screen reader
 * can make nothing of.
 */
function TabArrow({
  side,
  strip,
  hidden,
}: {
  side: "left" | "right";
  strip: RefObject<HTMLElement | null>;
  hidden: boolean;
}) {
  if (!hidden) {
    return null;
  }
  const scroll = () => {
    const el = strip.current;
    if (!el) {
      return;
    }
    const spans = [...el.children].map((c) => {
      const tab = c as HTMLElement;
      return { start: tab.offsetLeft, end: tab.offsetLeft + tab.offsetWidth };
    });
    el.scrollTo({ left: nextEdge(side, el, spans), behavior: "smooth" });
  };
  return (
    <button
      className={`tabmore ${side}`}
      type="button"
      onClick={scroll}
      aria-label={side === "right" ? "More tabs" : "Earlier tabs"}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d={side === "right" ? "m6 3 5 5-5 5" : "M10 3 5 8l5 5"} />
      </svg>
    </button>
  );
}

/**
 * What a tab says without being opened: a run that needs attention, or one
 * that found something. Named rather than left as decoration, because a colour
 * is nothing to a screen reader and on a tab the dot is the whole message.
 */
function TabDot({ cls, title }: { cls: string; title: string }) {
  return <i className={`tabdot ${cls}`} role="img" aria-label={title} title={title} />;
}

/** What the found dot says: the count, because a dot alone doesn't say how much is behind it. */
function freshTitle(n: number): string {
  return `${n} found today`;
}

function TrackPanel({ data }: { data: TrackerData }) {
  const { trackKey = "" } = useParams();
  const tracks = buildTracks(data.tracks);
  // A bookmark can name a track config no longer has.
  if (!tracks[trackKey]) {
    return <Navigate to="/" replace />;
  }
  return <LeadsTab data={data} trackKey={trackKey} />;
}

export default function Shell({
  data,
  isOverview,
  notice,
  onSignOut,
}: {
  data: TrackerData;
  isOverview: boolean;
  /** Sits above the tabs on every page: what setup still owes this tracker, or nothing. */
  notice?: ReactNode;
  onSignOut: () => void;
}) {
  const { settings } = data;
  const tracks = buildTracks(data.tracks);
  const tabs = buildTabs(data.leads, data.applications, tracks, settings);
  const location = useLocation();
  const save = useSaved();
  const { strip, hidden, measure } = useTabOverflow(tabs.length, location.pathname);
  const [accountOpen, setAccountOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  // `?account=<section>` opens My account on that section, so a link can lead
  // to the setting it is about. Closing takes it back out of the URL, leaving
  // the tab's own view behind.
  const askedSection = params.get("account");
  const closeAsked = () => {
    const next = new URLSearchParams(params);
    next.delete("account");
    setParams(next, { replace: true });
  };
  const [theme, toggleTheme] = useTheme();
  const pinned = usePinnedLayout(isOverview);
  useWheelAnywhere();

  // Given back on sign-out, so the next person on a shared browser doesn't
  // inherit the account's title.
  useEffect(() => {
    const previous = document.title;
    document.title = settings.display_title;
    return () => {
      document.title = previous;
    };
  }, [settings.display_title]);

  const n = data.tracks.length;
  const sub = n
    ? `Verified openings across ${n} tracked search${n === 1 ? "" : "es"}, refreshed daily. Edit anything — it saves for every device.`
    : "No tracked searches configured yet — run the job-search-setup skill to add one.";

  return (
    <div id="app" className={isOverview ? "pinned" : undefined}>
      <div className="wrap">
        <div className="topbar">
          <div className="hdr">
            <div>
              {/* From config: the same deployed client serves every account. */}
              <h1>{settings.display_title}</h1>
              <div className="sub">{sub}</div>
            </div>
            <div className="hdr-right">
              <div className="stamp">
                <span className={`dot ${save.tone}`} />
                <span role="status" aria-live="polite">
                  {save.text}
                </span>
              </div>
              <button className="who" type="button" title="Your password and resumes" onClick={() => setAccountOpen(true)}>
                My account
              </button>
              <button className="btn ghost" type="button" onClick={onSignOut} title="Sign out of this browser">
                Log out
              </button>
              <button
                id="themeToggle"
                className="btn ghost"
                type="button"
                onClick={toggleTheme}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              >
                {/* The theme this switches to, matching its label. */}
                {theme === "dark" ? "☀️" : "🌙"}
              </button>
            </div>
          </div>

          <div className="tabrow">
          <TabArrow side="left" strip={strip} hidden={hidden.left} />
          <nav className="tabs" role="tablist" ref={strip} onScroll={measure}>
            {tabs.map((t) => (
              // aria-selected set by hand: role="tab" needs it for assistive
              // tech, and the stylesheet draws the selected tab from it.
              <Link
                key={t.id}
                to={t.path}
                // Screened sits back until you want it: it holds nothing to
                // act on, and it shouldn't compete with the searches beside it.
                className={`tab${t.paused ? " paused" : ""}${t.kind === "screened" ? " quiet" : ""}`}
                // The whole tab carries the pause: greyed with no symbol, the
                // hover has to explain it, and it should work anywhere on it.
                title={t.paused ? pausedTitle(t.paused) : undefined}
                // Grey is nothing to a screen reader, so the name says it. The
                // count goes in too: an aria-label replaces the whole name.
                aria-label={t.paused ? `${t.label} (paused)${t.n === null ? "" : `, ${t.n}`}` : undefined}
                role="tab"
                // Exactly its own path. Every tab page sits at one path with no
                // pages under it, and a prefix test would light two track tabs
                // whose keys share a start ("staff", "staff-principal").
                aria-selected={location.pathname === t.path}
              >
                {t.label}
                {/* Said on the tab, not only inside it: a paused search's tab
                    is quiet for a reason, and the reason should be visible
                    without opening it. */}
                {t.warn && <TabDot cls={t.warn.cls} title={t.warn.title} />}
                {t.fresh > 0 && <TabDot cls="found" title={freshTitle(t.fresh)} />}
                {t.n !== null && <span className="n">{t.n}</span>}
              </Link>
            ))}
          </nav>
          <TabArrow side="right" strip={strip} hidden={hidden.right} />
          </div>
        </div>

        {notice}

        <main id="panel">
          <Routes>
            {/* Overview owns its scroll region: the tiles are pinned outside
                it, so the wrapper can't live out here. */}
            {/* Built from pathForTab, which the tabs link to, so the two can't drift. */}
            <Route path={pathForTab(DASHBOARD)} element={<Overview data={data} {...pinned} />} />
            <Route path={pathForTab(APPLICATIONS)} element={<ApplicationsTab data={data} />} />
            <Route path={pathForTab(ALL_LEADS)} element={<LeadsTab data={data} trackKey={ALL_LEADS} />} />
            <Route path={pathForTab(SCREENED)} element={<ScreenedTab data={data} />} />
            {/* pathForTab's /t/<key>, for every track. */}
            <Route path="/t/:trackKey" element={<TrackPanel data={data} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <AccountPanel
        open={accountOpen || askedSection !== null}
        // A page that says a rule cost someone twenty postings should be able
        // to take them to the rule, so the panel opens at a section by URL.
        section={askedSection}
        // The search the view is about, which the Screened tab keeps in the
        // URL: a caption about one search's settings should open on that one.
        search={params.get("search")}
        name={data.user.name}
        tracks={data.tracks}
        settings={data.settings}
        onClose={() => {
          setAccountOpen(false);
          if (askedSection !== null) {
            closeAsked();
          }
        }}
      />
    </div>
  );
}
