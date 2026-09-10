/**
 * The signed-in page: header, tab bar, and whichever panel the route names.
 *
 * Tabs are real routes here, which is the one behavioural upgrade over the page
 * this is ported from. There `ui.tab` lived in localStorage, so a filtered view
 * could not be linked to and the back button did nothing. A route that names a
 * track no longer in config falls back to the first tab, the same way the old
 * page's restored-from-localStorage tab did.
 */
import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import type { TrackerData } from "../api/schema";
import { ALL_LEADS } from "../domain/constants";
import { buildTabs, buildTracks } from "../domain/tabs";
import { usePinnedLayout, useTheme } from "../ui/hooks";
import { useSaved } from "../ui/saved";
import ApplicationsTab from "./ApplicationsTab";
import LeadsTab from "./LeadsTab";
import Overview from "./Overview";

function TrackPanel({ data }: { data: TrackerData }) {
  const { trackKey = "" } = useParams();
  const tracks = buildTracks(data.tracks);
  // A URL can name a track that config no longer has - a bookmark, or a track
  // removed since. Fall back rather than render an empty panel for a key that
  // does not exist.
  if (!tracks[trackKey]) return <Navigate to="/" replace />;
  return <LeadsTab data={data} trackKey={trackKey} />;
}

export default function Shell({
  data,
  isOverview,
  onSignOut,
}: {
  data: TrackerData;
  isOverview: boolean;
  onSignOut: () => void;
}) {
  const { settings } = data;
  const tracks = buildTracks(data.tracks);
  const tabs = buildTabs(data.leads, data.applications, tracks, settings);
  const location = useLocation();
  const save = useSaved();
  const [theme, toggleTheme] = useTheme();
  const pinned = usePinnedLayout(isOverview);

  const n = data.tracks.length;
  const sub = n
    ? `Verified openings across ${n} tracked search${n === 1 ? "" : "es"}, refreshed daily.`
    : "No tracked searches configured yet — run the job-search-setup skill to add one.";

  return (
    <div id="app" className={isOverview ? "pinned" : undefined}>
      <div className="wrap">
        {/* Title block and tab bar travel together, so both stay put while a
            tab's rows scroll under them. */}
        <div className="topbar">
          <div className="hdr">
            <div>
              {/* From config. The same deployed client serves every account, so
                  a title written in here would be one person's search on
                  everyone's page. */}
              <h1>{settings.display_title}</h1>
              <div className="sub">{sub}</div>
            </div>
            <div className="hdr-right">
              {/* Every write path sets this. With optimistic updates the row has
                  already changed on screen, so this is the only thing telling
                  "saved" apart from "about to be rolled back". */}
              <div className="stamp">
                <span className={`dot ${save.tone}`} />
                <span role="status" aria-live="polite">
                  {save.text}
                </span>
              </div>
              <span className="who">Signed in as {data.user.name}</span>
              <button className="btn ghost" type="button" onClick={onSignOut} title="Sign out of this browser">
                Log out
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={toggleTheme}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              >
                {theme === "dark" ? "🌙" : "☀️"}
              </button>
            </div>
          </div>

          <nav className="tabs" role="tablist">
            {tabs.map((t) => (
              // A plain Link with aria-selected set by hand rather than NavLink:
              // role="tab" requires that attribute to be correct for assistive
              // tech, and the stylesheet draws the selected tab from it too, so
              // getting it right serves both at once.
              <Link
                key={t.id}
                to={t.path}
                className="tab"
                role="tab"
                aria-selected={
                  t.path === "/" ? location.pathname === "/" : location.pathname.startsWith(t.path)
                }
              >
                {t.label}
                {t.warn && <i className={`tabwarn ${t.warn.cls}`} title={t.warn.title} />}
                {t.n !== null && <span className="n">{t.n}</span>}
              </Link>
            ))}
          </nav>
        </div>

        <main id="panel">
          <Routes>
            {/* Overview owns its own scroll region: the tiles are pinned
                *outside* it while everything below scrolls within, so the
                wrapper cannot live out here. */}
            <Route path="/" element={<Overview data={data} {...pinned} />} />
            <Route path="/applications" element={<ApplicationsTab data={data} />} />
            <Route path="/all-leads" element={<LeadsTab data={data} trackKey={ALL_LEADS} />} />
            <Route path="/t/:trackKey" element={<TrackPanel data={data} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
