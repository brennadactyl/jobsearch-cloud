import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import type { TrackerData } from "../api/schema";
import { ALL_LEADS } from "../domain/constants";
import { buildTabs, buildTracks, pathForTab } from "../domain/tabs";
import { usePinnedLayout, useTheme } from "../ui/hooks";
import { useSaved } from "../ui/saved";
import ApplicationsTab from "./ApplicationsTab";
import AccountPanel from "./AccountPanel";
import LeadsTab from "./LeadsTab";
import Overview from "./Overview";

function TrackPanel({ data }: { data: TrackerData }) {
  const { trackKey = "" } = useParams();
  const tracks = buildTracks(data.tracks);
  // A bookmark can name a track config no longer has.
  if (!tracks[trackKey]) return <Navigate to="/" replace />;
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
  const [accountOpen, setAccountOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const pinned = usePinnedLayout(isOverview);

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

          <nav className="tabs" role="tablist">
            {tabs.map((t) => (
              // aria-selected set by hand: role="tab" needs it for assistive
              // tech, and the stylesheet draws the selected tab from it.
              <Link
                key={t.id}
                to={t.path}
                className="tab"
                role="tab"
                // Exactly its own path. Every tab page sits at one path with no
                // pages under it, and a prefix test would light two track tabs
                // whose keys share a start ("staff", "staff-principal").
                aria-selected={location.pathname === t.path}
              >
                {t.label}
                {t.warn && <i className={`tabwarn ${t.warn.cls}`} title={t.warn.title} />}
                {t.n !== null && <span className="n">{t.n}</span>}
              </Link>
            ))}
          </nav>
        </div>

        {notice}

        <main id="panel">
          <Routes>
            {/* Overview owns its scroll region: the tiles are pinned outside
                it, so the wrapper can't live out here. */}
            {/* Built from pathForTab, which the tabs link to, so the two can't drift. */}
            <Route path={pathForTab("dashboard")} element={<Overview data={data} {...pinned} />} />
            <Route path={pathForTab("applications")} element={<ApplicationsTab data={data} />} />
            <Route path={pathForTab(ALL_LEADS)} element={<LeadsTab data={data} trackKey={ALL_LEADS} />} />
            {/* pathForTab's /t/<key>, for every track. */}
            <Route path="/t/:trackKey" element={<TrackPanel data={data} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <AccountPanel open={accountOpen} name={data.user.name} tracks={data.tracks} onClose={() => setAccountOpen(false)} />
    </div>
  );
}
