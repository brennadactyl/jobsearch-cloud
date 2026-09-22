/**
 * The account panel's Searches section: what each search is called, which is
 * its tab's name. A rename is true the moment the panel's Save lands and
 * changes nothing about what the search looks for.
 */
import type { Track } from "../api/schema";

export default function SearchesSection({
  tracks,
  names,
  changed,
  problem,
  onRename,
}: {
  tracks: readonly Track[];
  /** What each name field shows, by search key. */
  names: Readonly<Record<string, string>>;
  changed: ReadonlySet<string>;
  /** A refused save's message, beside the search it names. */
  problem: { search: string; message: string } | null;
  onRename: (key: string, label: string) => void;
}) {
  return (
    <section className="account-section" aria-labelledby="searchTitle">
      <div>
        <h4 id="searchTitle">Searches</h4>
        <p>What each search is called. The name is its tab's, and nothing about what it looks for.</p>
      </div>

      {tracks.length === 0 && <p className="resume-quiet">No searches yet.</p>}

      {tracks.map((track) => {
        const id = `search-${track.key}`;
        const message = problem?.search === track.key ? problem.message : "";
        return (
          <div className="loc-field" key={track.key}>
            {/* The tag sits outside the label: a label whose text changes as
                you type is a different label to anything reading the page. */}
            <div className="loc-label">
              <label htmlFor={id}>{track.label || track.key}</label>
              {changed.has(track.key) && <span className="resume-changed">Changed</span>}
            </div>
            <input
              id={id}
              type="text"
              value={names[track.key] ?? track.label}
              className={changed.has(track.key) ? "changed" : undefined}
              aria-invalid={message ? true : undefined}
              onChange={(e) => onRename(track.key, e.target.value)}
            />
            {message && (
              <p className="loc-err" role="alert">
                {message}
              </p>
            )}
            {/* A tab filled by another search reads that search's leads, so its name is its own but its results aren't. */}
            {track.fed_by && <p className="loc-hint">Filled by the {labelOf(tracks, track.fed_by)} search.</p>}
          </div>
        );
      })}
    </section>
  );
}

function labelOf(tracks: readonly Track[], key: string): string {
  return tracks.find((t) => t.key === key)?.label || key;
}
