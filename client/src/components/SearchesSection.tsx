/**
 * The account panel's Searches section: what each search is called and what it
 * looks for (docs/search-fields-plan.md).
 *
 * Every field here is prose a night reads, not a filter the server applies, so
 * an edit is true the moment the panel's Save lands and shows in what that
 * search finds and screens the next morning. Nothing is regenerated, and what a
 * way of writing will cost is said beside the field rather than refused.
 */
import type { Track } from "../api/schema";
import { searchWarnings, SEARCH_KEYS, type SearchDraft, type SearchFields, type SearchKey } from "../domain/panel";

const QUESTIONS: Readonly<Record<Exclude<SearchKey, "label">, { label: string; hint: string; rows: number }>> = {
  role_search_line: {
    label: "What roles should this search look for?",
    hint: "Titles and seniority, as they'd read mid-sentence: “Staff backend or distributed systems roles”. This is what the search looks for all night, so it can't be left empty.",
    rows: 2,
  },
  fit_clause: {
    label: "What makes a posting worth keeping?",
    hint: "A test a posting passes or fails, beside the ones every search applies: genuinely new, still live, and in one of your places.",
    rows: 2,
  },
  fit_disqualifier: {
    label: "What rules a posting out?",
    hint: "Reasons to screen one out, beside dead-on-arrival and wrong level. What this matches is listed on Screened with its reason, so you can see what it caught.",
    rows: 2,
  },
};

export default function SearchesSection({
  tracks,
  draft,
  changed,
  problem,
  places,
  onChange,
}: {
  tracks: readonly Track[];
  /** The edits in hand, by search key. */
  draft: SearchDraft;
  /** The fields of each search that differ from what's stored. */
  changed: Readonly<Record<string, Partial<SearchFields>>>;
  /** A refused save's message, beside the search and field it names. */
  problem: { search: string; field: string; message: string } | null;
  /** The places this account has named, so a rule repeated here can be pointed out. */
  places: readonly string[];
  onChange: (key: string, field: SearchKey, value: string) => void;
}) {
  return (
    <section className="account-section" aria-labelledby="searchTitle">
      <div>
        <h4 id="searchTitle">Searches</h4>
        <p>What each search is called and what it looks for. A change is saved at once and read by that search's next run.</p>
      </div>

      {tracks.length === 0 && <p className="resume-quiet">No searches yet.</p>}

      {tracks.map((track) => {
        const values = { ...fieldsOf(track), ...draft[track.key] } as SearchFields;
        const edited = changed[track.key] ?? {};
        const warnings = searchWarnings(values, places);
        return (
          // Named, because every block asks the same questions: without this a
          // field reads as "What this search is called" and nothing more.
          <div className="search-block" role="group" aria-label={track.label || track.key} key={track.key}>
            <div className="search-block-name">{track.label || track.key}</div>
            <Field
              id={`search-${track.key}`}
              label="What this search is called"
              value={values.label}
              changed={"label" in edited}
              problem={problem?.search === track.key && problem.field === "label" ? problem.message : ""}
              hint={track.fed_by ? `The tab's name. This tab is filled by the ${labelOf(tracks, track.fed_by)} search.` : "The tab's name on your tracker."}
              onChange={(value) => onChange(track.key, "label", value)}
            />
            {SEARCH_KEYS.filter((key) => key !== "label").map((key) => (
              <Field
                key={key}
                id={`search-${track.key}-${key}`}
                label={QUESTIONS[key].label}
                rows={QUESTIONS[key].rows}
                value={values[key]}
                changed={key in edited}
                problem={problem?.search === track.key && problem.field === key ? problem.message : ""}
                warning={warnings[key] ?? ""}
                hint={QUESTIONS[key].hint}
                onChange={(value) => onChange(track.key, key, value)}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}

function fieldsOf(track: Track): SearchFields {
  return {
    label: track.label,
    role_search_line: track.role_search_line,
    fit_clause: track.fit_clause,
    fit_disqualifier: track.fit_disqualifier,
  };
}

function labelOf(tracks: readonly Track[], key: string): string {
  return tracks.find((t) => t.key === key)?.label || key;
}

function Field({
  id,
  label,
  value,
  rows = 0,
  changed,
  problem,
  warning = "",
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  /** A prose answer gets a textarea; the name gets one line. */
  rows?: number;
  changed: boolean;
  problem: string;
  warning?: string;
  hint: string;
  onChange: (value: string) => void;
}) {
  const props = {
    id,
    value,
    className: changed ? "changed" : undefined,
    "aria-invalid": problem ? (true as const) : undefined,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className="loc-field">
      <div className="loc-label">
        <label htmlFor={id}>{label}</label>
        {changed && <span className="resume-changed">Changed</span>}
      </div>
      {rows ? <textarea rows={rows} {...props} /> : <input type="text" {...props} />}
      {problem && (
        <p className="loc-err" role="alert">
          {problem}
        </p>
      )}
      {/* Said, never refused: a person can mean it. */}
      {warning && (
        <p className="loc-warn" role="status">
          {warning}
        </p>
      )}
      <p className="loc-hint">{hint}</p>
    </div>
  );
}
