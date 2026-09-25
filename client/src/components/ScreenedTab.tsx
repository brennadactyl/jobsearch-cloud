/**
 * What the searches looked at and didn't keep, with the sentence each run wrote.
 * The page shows those sentences and counts rows; it never reads the words, so
 * nothing here groups or judges a reason (docs/backlog.md).
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getAllScreened } from "../api/client";
import type { Screened, TrackerData } from "../api/schema";
import { screenedColumns } from "../domain/export";
import { safeUrl } from "../domain/format";
import { countsByKind, countsBySearch, keptWithin, SCREENED_KINDS, screenedWithin, SCREENED_WINDOWS } from "../domain/screened";
import { buildTracks } from "../domain/tabs";
import { ExportButton } from "./listControls";

const ALL = "";

export default function ScreenedTab({ data }: { data: TrackerData }) {
  const [days, setDays] = useState(SCREENED_WINDOWS[1].days);
  // Read once per opening: a window that moved under someone mid-read would
  // drop a row between one glance and the next.
  const [now] = useState(() => Date.now());
  // In the URL, so a run stamp can link to one search and Back undoes it.
  const [params, setParams] = useSearchParams();
  const search = params.get("search") ?? ALL;
  const kind = params.get("kind");
  const narrow = (next: { search?: string; kind?: string | null }) => {
    const set = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) set.set(key, value);
      else set.delete(key);
    }
    setParams(set, { replace: true });
  };
  const setSearch = (next: string) => narrow({ search: next, kind: null });

  const tracks = buildTracks(data.tracks);
  const inWindow = screenedWithin(data.screened, days, now);
  const counts = countsBySearch(inWindow);
  const ofSearch = search === ALL ? inWindow : inWindow.filter((r) => r.search === search);
  const kinds = countsByKind(ofSearch);
  const rows = kind === null ? ofSearch : ofSearch.filter((r) => r.kind === kind);
  const kept = keptWithin(data.leads, days, now, search);
  const nameOf = (key: string) => tracks[key]?.label || key;

  return (
    <div className="screened">
      <div className="toolbar">
        <div className="screened-head">
          <h2>What your searches set aside</h2>
          <p className="hint">
            Every posting a run looked at and didn't keep, with the reason it wrote. Nothing here was deleted: each row
            keeps its link.
          </p>
        </div>
        {/* Everything stored, not the window on screen: someone exporting to a
            spreadsheet wants their whole record, so it is fetched rather than
            taken from the page. */}
        <ExportButton
          shown={rows}
          all={data.screened}
          columns={screenedColumns(tracks)}
          label="screened"
          loadAll={getAllScreened}
        />
        <label className="screened-window">
          Showing{" "}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {SCREENED_WINDOWS.map((w) => (
              <option key={w.days} value={w.days}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {data.screened.length > 0 && (
        <p className="screened-sum">
          <strong className="mono">{rows.length}</strong> set aside, against <strong className="mono">{kept}</strong>{" "}
          kept{search && ` by ${nameOf(search)}`}, {SCREENED_WINDOWS.find((w) => w.days === days)?.label}.
          {/* A page showing part of the record has to say so, or a window reads
              as a purge. Nothing is deleted: the older rows still stop a run
              re-finding those postings, and the export writes them out. */}
          {data.screened_window.older > 0 && (
            <span className="screened-older">
              {" "}
              {data.screened_window.older} older {data.screened_window.older === 1 ? "posting isn't" : "postings aren't"}{" "}
              shown here. They're kept, and Export everything includes them.
            </span>
          )}
        </p>
      )}

      {/* Only worth the row when there is more than one search to choose between. */}
      {Object.keys(counts).length > 1 && (
        <div className="chips screened-searches">
          <button type="button" className="chip" aria-pressed={search === ALL} onClick={() => setSearch(ALL)}>
            All searches <span className="mono">{inWindow.length}</span>
          </button>
          {Object.entries(counts)
            .sort(([a], [b]) => nameOf(a).localeCompare(nameOf(b)))
            .map(([key, n]) => (
              <button
                key={key}
                type="button"
                className="chip"
                aria-pressed={search === key}
                onClick={() => setSearch(key)}
              >
                {nameOf(key)} <span className="mono">{n}</span>
              </button>
            ))}
        </div>
      )}

      {/* What the rules cost, by the kind a run filed each rejection under -
          never by reading the sentences, which are one per posting and no two
          alike. Counted by posting: a job re-listed under a new url is two. */}
      {kinds.length > 1 && (
        <div className="screened-kinds">
          {kinds.map((k) => {
            const share = Math.round((k.postings / Math.max(...kinds.map((x) => x.postings))) * 100);
            const chosen = kind === k.kind;
            return (
              <button
                key={k.kind || "unsorted"}
                type="button"
                className={chosen ? "screened-kind chosen" : "screened-kind"}
                aria-pressed={chosen}
                onClick={() => narrow({ kind: chosen ? null : k.kind || "" })}
                disabled={chosen ? false : undefined}
              >
                <span className="mono screened-kind-n">{k.postings}</span>
                <span className="screened-kind-label">{k.label}</span>
                <span className="screened-kind-bar">
                  <span style={{ width: `${share}%` }} />
                </span>
              </button>
            );
          })}
        </div>
      )}
      {kind !== null && (
        <p className="screened-narrowed">
          Showing {SCREENED_KINDS.find((k) => k.kind === kind)?.label ?? kind}.{" "}
          <button type="button" className="linkish" onClick={() => narrow({ kind: null })}>
            Show every reason
          </button>
        </p>
      )}

      {rows.length === 0 ? (
        <p className="empty">
          {data.screened.length === 0
            ? "Nothing has been set aside yet. A run records each posting it looks at and doesn't keep, with its reason."
            : "Nothing was set aside in this window."}
        </p>
      ) : (
        <div className="card grid-wrap screened-grid">
          <table>
            <thead>
              <tr>
                <th scope="col">Set aside</th>
                <th scope="col">Posting</th>
                <th scope="col">Where</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row key={row.id} row={row} search={search === ALL ? nameOf(row.search) : ""} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ row, search }: { row: Screened; search: string }) {
  const url = safeUrl(row.url);
  return (
    <tr>
      <td className="mono screened-date">{row.date}</td>
      <td>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            {row.company || "Untitled posting"}
          </a>
        ) : (
          <span>{row.company || "Untitled posting"}</span>
        )}
        <div className="screened-role">
          {row.title}
          {search && <span className="screened-search"> · {search}</span>}
        </div>
      </td>
      <td className="screened-where">{row.location}</td>
      <td>
        {row.reason}
        {/* A posting the person took off their own board sits in the same table
            as a run's decisions, and shouldn't read as one. */}
        {row.added_by === "hand" && <span className="screened-hand">you removed this</span>}
      </td>
    </tr>
  );
}
