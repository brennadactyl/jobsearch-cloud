/**
 * The account panel's Searches section: what each search is called and what it
 * looks for (docs/search-fields-plan.md).
 *
 * Every field here is prose a night reads, not a filter the server applies, so
 * an edit is true the moment the panel's Save lands and shows in what that
 * search finds and screens the next morning. Nothing is regenerated. Each
 * field's hint says what it is for; nothing reads what a person wrote to judge
 * it.
 */
import type { Track } from "../api/schema";
import { SEARCH_KEYS, type SearchDraft, type SearchFields, type SearchKey } from "../domain/panel";

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
    hint: "Reasons to screen one out, beside dead-on-arrival and wrong level. A run records what it screened and why; the Overview counts them per search.",
    rows: 2,
  },
};

export default function SearchesSection({
  tracks,
  shown,
  draft,
  changed,
  problem,
  onShow,
  onChange,
}: {
  tracks: readonly Track[];
  /** The search whose questions are on screen; the strip above chooses it. */
  shown: Track | undefined;
  /** The edits in hand, by search key. */
  draft: SearchDraft;
  /** The fields of each search that differ from what's stored. */
  changed: Readonly<Record<string, Partial<SearchFields>>>;
  /** A refused save's message, beside the search and field it names. */
  problem: { search: string; field: string; message: string } | null;
  onShow: (key: string) => void;
  onChange: (key: string, field: SearchKey, value: string) => void;
}) {
  return (
    <section className="account-section" aria-labelledby="searchTitle">
      <div>
        <h4 id="searchTitle">Searches</h4>
        <p>What each search is called and what it looks for. A change is saved at once and read by that search's next run.</p>
      </div>

      {tracks.length === 0 && <p className="resume-quiet">No searches yet.</p>}

      {/* One line however many searches there are: it scrolls sideways rather
          than wrapping, so the questions below never move down the page. */}
      {tracks.length > 1 && (
        <div className="search-strip" role="tablist" aria-label="Your searches">
          {tracks.map((track) => (
            <button
              key={track.key}
              type="button"
              role="tab"
              aria-selected={track.key === shown?.key}
              className={track.key === shown?.key ? "chosen" : undefined}
              onClick={() => onShow(track.key)}
            >
              {draft[track.key]?.label ?? track.label ?? track.key}
              {changed[track.key] && <span className="account-nav-dot" aria-label="Unsaved changes" role="img" />}
            </button>
          ))}
        </div>
      )}

      {(shown ? [shown] : []).map((track) => {
        const values = { ...fieldsOf(track), ...draft[track.key] } as SearchFields;
        const edited = changed[track.key] ?? {};
        return (
          // Named, because every block asks the same questions: without this a
          // field reads as "What this search is called" and nothing more.
          <div className="search-block" role="group" aria-label={track.label || track.key} key={track.key}>
            <Field
              id={`search-${track.key}`}
              label="What this search is called"
              value={values.label}
              changed={"label" in edited}
              problem={problem?.search === track.key && problem.field === "label" ? problem.message : ""}
              hint={
                track.fed_by
                  ? `The tab's name. The ${labelOf(tracks, track.fed_by)} search fills this tab, so what it looks for is set there.`
                  : "The tab's name on your tracker."
              }
              onChange={(value) => onChange(track.key, "label", value)}
            />
            {/* A tab another search fills runs nothing of its own: what it
                looks for is that search's, and asking here would offer edits no
                run reads. Its name is still its own. */}
            {!track.fed_by &&
              SEARCH_KEYS.filter((key) => key !== "label").map((key) => (
                <Field
                  key={key}
                  id={`search-${track.key}-${key}`}
                  label={QUESTIONS[key].label}
                  rows={QUESTIONS[key].rows}
                  value={values[key]}
                  changed={key in edited}
                  problem={problem?.search === track.key && problem.field === key ? problem.message : ""}
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
      <p className="loc-hint">{hint}</p>
    </div>
  );
}
