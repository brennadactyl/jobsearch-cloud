/**
 * What the searches looked at and didn't keep, with the sentence each run wrote.
 * The page shows those sentences and counts rows; it never reads the words, so
 * nothing here groups or judges a reason (docs/backlog.md).
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Screened, TrackerData } from "../api/schema";
import { safeUrl } from "../domain/format";
import {
  countsByKind,
  countsBySearch,
  groupLabel,
  groupOf,
  keptWithin,
  SCREENED_KINDS,
  SCREENED_SORTS,
  screenedWithin,
  SCREENED_WINDOWS,
  sortScreened,
} from "../domain/screened";
import { buildTracks } from "../domain/tabs";

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
  const narrow = (next: Partial<Record<"search" | "kind" | "sort" | "dir", string | null>>) => {
    const set = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) set.set(key, value);
      else set.delete(key);
    }
    setParams(set, { replace: true });
  };
  const setSearch = (next: string) => narrow({ search: next, kind: null });

  const tracks = buildTracks(data.tracks);
  // Everything a search passed over, ever: the emptiest state below is about
  // having no rejections at all, and a delisted lead isn't one.
  const everRejected = screenedWithin(data.screened, 0, now);
  const inWindow = screenedWithin(data.screened, days, now);
  const counts = countsBySearch(inWindow);
  const ofSearch = search === ALL ? inWindow : inWindow.filter((r) => r.search === search);
  const kinds = countsByKind(ofSearch);
  const chosen = kind === null ? ofSearch : ofSearch.filter((r) => groupOf(r) === kind);
  const kept = keptWithin(data.leads, days, now, search);
  // Which column orders the list, in the URL with the rest of the view. A
  // column's first click sorts it the way someone means it: newest first of a
  // date, A first of a name.
  const column = SCREENED_SORTS.find((s) => s.key === params.get("sort")) ?? SCREENED_SORTS[0];
  const sortKey = column.key;
  const descending = params.get("dir") ? params.get("dir") === "desc" : column.newestFirst === true;
  const sortBy = (key: string) => {
    const next = SCREENED_SORTS.find((s) => s.key === key)!;
    const flip = key === sortKey ? !descending : next.newestFirst === true;
    narrow({ sort: key, dir: flip ? "desc" : "asc" });
  };
  const rows = sortScreened(chosen, sortKey, descending);
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
        {/* No export here, unlike leads and applications: those are someone's
            record of their own search, and what a run passed over isn't
            (docs/backlog.md). */}
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

      {/* What this person's settings cost, which is the server's count and never
          the length of what the page happens to hold: the list also carries
          postings they removed themselves, and a number derived from it would
          answer a different question than the Overview's. Only per search,
          since that is the only count on the wire. */}
      {search !== ALL && data.screened_counts[search] !== undefined && (
        <p className="screened-claim">
          {nameOf(search)}&rsquo;s settings have turned away{" "}
          <strong className="mono">{data.screened_counts[search]}</strong>{" "}
          {data.screened_counts[search] === 1 ? "posting" : "postings"} in all.
        </p>
      )}

      {everRejected.length > 0 && (
        <p className="screened-sum">
          Showing <strong className="mono">{rows.length}</strong> from{" "}
          {SCREENED_WINDOWS.find((w) => w.days === days)?.label}, against <strong className="mono">{kept}</strong> kept
          {search && ` by ${nameOf(search)}`}.
          {/* A page showing part of the record has to say so, or a window reads
              as a purge. Nothing is deleted, and the rows outside it are still
              working: they are what stops a run finding those postings again. */}
          {data.screened_window.older > 0 && (
            <span className="screened-older">
              {" "}
              {data.screened_window.older} older {data.screened_window.older === 1 ? "posting isn't" : "postings aren't"}{" "}
              shown here. {data.screened_window.older === 1 ? "It's" : "They're"} kept, and still stop a search finding{" "}
              {data.screened_window.older === 1 ? "it" : "them"} again.
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

      {/* What the rules cost, by the kind a run filed each rejection under.
          Never by reading the sentences,
          which are one per posting and no two alike. Counted by posting: a job
          re-listed under a new url is two. */}
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
          Showing: {SCREENED_KINDS.find((k) => k.kind === kind)?.label ?? kind}.{" "}
          <button type="button" className="linkish" onClick={() => narrow({ kind: null })}>
            Show every reason
          </button>
        </p>
      )}

      {rows.length === 0 ? (
        <p className="empty">{emptyLine(data, search, everRejected.length)}</p>
      ) : (
        <div className="card grid-wrap screened-grid">
          <table>
            <thead>
              <tr>
                {SCREENED_SORTS.map((col) => {
                  const on = col.key === sortKey;
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      // What the column is sorted by, said to a screen reader as
                      // well as drawn, since the arrow alone says it to nobody else.
                      aria-sort={on ? (descending ? "descending" : "ascending") : "none"}
                    >
                      <button type="button" className="screened-sort" onClick={() => sortBy(col.key)}>
                        {col.header}
                        <span aria-hidden="true" className="screened-caret">
                          {on ? (descending ? "▾" : "▴") : ""}
                        </span>
                      </button>
                    </th>
                  );
                })}
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

/**
 * What an empty list means, which is three different things. A search with no
 * count at all has a record that predates a run saying which kind each rejection
 * was: its rows exist and can't be attributed, so saying it turned nothing away
 * would be a claim about months nobody can speak for.
 */
function emptyLine(data: TrackerData, search: string, everRejected: number): string {
  if (search && data.screened_counts[search] === undefined) {
    return "No record of what this search turned away: its rejections were written before a run said which rule caused each one.";
  }
  if (everRejected === 0) {
    return "Nothing has been set aside yet. A run records each posting your settings turn away, with its reason.";
  }
  return "Nothing was set aside in this window.";
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
      {/* The kind, which is what the groups above count and what this column
          sorts by; the sentence beside it is about this posting alone. A row the
          person removed themselves says so here rather than needing a tag. */}
      <td className="screened-why">{groupLabel(row)}</td>
      <td className="screened-words">{row.reason}</td>
    </tr>
  );
}
