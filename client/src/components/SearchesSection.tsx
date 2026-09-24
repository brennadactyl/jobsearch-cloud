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
import { useState } from "react";
import type { Track } from "../api/schema";
import { isoDay } from "../domain/format";
import {
  DEFAULT_PAY_UNIT,
  PAY_UNITS,
  PROSE_KEYS,
  SEARCH_QUESTIONS,
  type SearchDraft,
  type SearchEdit,
  type SearchFields,
  type SearchKey,
} from "../domain/panel";

const QUESTIONS: Readonly<Record<(typeof PROSE_KEYS)[number], { hint: string; rows: number }>> = {
  role_search_line: {
    hint: "Titles and seniority, as they'd read mid-sentence: “Staff backend or distributed systems roles”. This is what the search looks for all night, so it can't be left empty.",
    rows: 2,
  },
  fit_clause: {
    hint: "A test a posting passes or fails, beside the ones every search applies: genuinely new, still live, and in one of your places.",
    rows: 2,
  },
  fit_disqualifier: {
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
  onPause,
}: {
  tracks: readonly Track[];
  /** The search whose questions are on screen; the strip above chooses it. */
  shown: Track | undefined;
  /** The edits in hand, by search key. */
  draft: SearchDraft;
  /** What differs from what's stored, per search. */
  changed: Readonly<Record<string, SearchEdit>>;
  /** A refused save's message, beside the search and field it names. */
  problem: { search: string; field: string; message: string } | null;
  onShow: (key: string) => void;
  onChange: (key: string, field: SearchKey, value: string) => void;
  /** Whether the search should run. Like every field here, it waits for the panel's Save. */
  onPause: (key: string, paused: boolean) => void;
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
        const edits = draft[track.key] ?? {};
        const values = { ...fieldsOf(track), ...stringEdits(edits) };
        const edited = changed[track.key] ?? {};
        return (
          // Named, because every block asks the same questions: without this a
          // field reads as "What this search is called" and nothing more.
          <div className="search-block" role="group" aria-label={track.label || track.key} key={track.key}>
            <Field
              id={`search-${track.key}`}
              label={SEARCH_QUESTIONS.label}
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
            {/* Above the questions about what it looks for: whether it runs at
                all is the answer someone comes here for, and below four prose
                fields it would be off the screen. */}
            <PauseField
              track={track}
              tracks={tracks}
              paused={edits.paused ?? Boolean(track.paused)}
              changed={edited.paused !== undefined}
              problem={problem?.search === track.key && problem.field === "paused" ? problem.message : ""}
              onPause={(next) => onPause(track.key, next)}
            />
            {/* A tab another search fills runs nothing of its own: what it
                looks for is that search's, and asking here would offer edits no
                run reads. Its name is still its own. */}
            {!track.fed_by &&
              PROSE_KEYS.map((key) => (
                <Field
                  key={key}
                  id={`search-${track.key}-${key}`}
                  label={SEARCH_QUESTIONS[key]}
                  rows={QUESTIONS[key].rows}
                  value={values[key]}
                  changed={key in edited}
                  problem={problem?.search === track.key && problem.field === key ? problem.message : ""}
                  hint={QUESTIONS[key].hint}
                  onChange={(value) => onChange(track.key, key, value)}
                />
              ))}
            {!track.fed_by && (
              <PayFloorField
                id={`search-${track.key}-pay`}
                amount={values.pay_floor}
                unit={values.pay_floor_unit}
                changed={"pay_floor" in edited || "pay_floor_unit" in edited}
                problem={
                  problem?.search === track.key && (problem.field === "pay_floor" || problem.field === "pay_floor_unit")
                    ? problem.message
                    : ""
                }
                onChange={(key, value) => onChange(track.key, key, value)}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * Whether the search runs. Paused it keeps its tab, its leads and its place in
 * the company rotation and simply isn't run, so this is a switch rather than
 * anything that removes a search - retiring one is still a separate act.
 *
 * A tab another search fills has no switch of its own: the server refuses one,
 * because the pause belongs to the search that runs.
 */
function PauseField({
  track,
  tracks,
  paused,
  changed,
  problem,
  onPause,
}: {
  track: Track;
  tracks: readonly Track[];
  paused: boolean;
  changed: boolean;
  problem: string;
  onPause: (paused: boolean) => void;
}) {
  const [asking, setAsking] = useState(false);
  const name = track.label || track.key;
  const feeder = track.fed_by ? labelOf(tracks, track.fed_by) : "";
  // The stored instant, so a pause chosen but not yet saved shows no date: the
  // server stamps it, and naming a day it hasn't stamped would be a guess.
  const since = paused && track.paused && !changed ? isoDay(new Date(track.paused)) : "";
  const hint = feeder
    ? `The ${feeder} search fills this tab, so it runs and pauses with that search.`
    : paused
      ? "It runs nothing until you let it run again. Its tab and everything it found stay as they are."
      : "Paused, it stops running but keeps its tab and everything it found. It picks up where it stopped.";
  return (
    <div className="loc-field search-pause">
      <div className="loc-label">
        <span>Is this search running?</span>
        {changed && <span className="resume-changed">Changed</span>}
      </div>
      <div className="search-pause-row">
        <strong className={paused ? "paused" : undefined}>
          {paused ? "Paused" : "Running"}
          {since && (
            <>
              {" since "}
              <span className="mono">{since}</span>
            </>
          )}
        </strong>
        {!track.fed_by && (
          <button className="btn" type="button" onClick={() => (paused ? onPause(false) : setAsking(true))}>
            {paused ? "Let it run again" : "Pause this search"}
          </button>
        )}
      </div>
      {problem && (
        <p className="loc-err" role="alert">
          {problem}
        </p>
      )}
      <p className="loc-hint">{hint}</p>
      {/* Asked of a pause and not of a resume: stopping a search is the choice
          with a consequence overnight, and the fear it answers - that the leads
          go with it - is worth answering before the switch moves. */}
      {asking && (
        <div className="modal-overlay">
          <div className="card modal-card wide" role="alertdialog" aria-modal="true" aria-labelledby={`pause-${track.key}`}>
            <h3 id={`pause-${track.key}`}>Pause {name}?</h3>
            <p>
              Once you save, it stops being run: nothing new found or screened for it. Everything it has already found
              stays in its tab, and you can still change what it looks for. Let it run again whenever you like.
            </p>
            <div className="modal-actions">
              <button className="btn" type="button" onClick={() => setAsking(false)}>
                Keep it running
              </button>
              <button
                className="btn primary"
                type="button"
                autoFocus
                onClick={() => {
                  setAsking(false);
                  onPause(true);
                }}
              >
                Pause it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The lowest pay a search takes: the amount in the person's own words, and the
 * unit as a choice, because "a year" and "an hour" are the two the run knows
 * and typing them is a spelling test. The amount is stored as typed and read
 * back as typed - nothing here reads a number out of it - and the sentence the
 * run says is composed where the prompt is, not here, so there is one wording.
 */
function PayFloorField({
  id,
  amount,
  unit,
  changed,
  problem,
  onChange,
}: {
  id: string;
  amount: string;
  unit: string;
  changed: boolean;
  problem: string;
  onChange: (key: "pay_floor" | "pay_floor_unit", value: string) => void;
}) {
  return (
    <div className="loc-field">
      <div className="loc-label">
        <label htmlFor={id}>{SEARCH_QUESTIONS.pay_floor}</label>
        <span className="loc-optional">optional</span>
        {changed && <span className="resume-changed">Changed</span>}
      </div>
      <div className="pay-floor">
        <input
          id={id}
          type="text"
          placeholder="$180k base"
          value={amount}
          className={changed ? "changed" : undefined}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => onChange("pay_floor", e.target.value)}
        />
        <select
          aria-label={SEARCH_QUESTIONS.pay_floor_unit}
          value={unit || DEFAULT_PAY_UNIT}
          className={changed ? "changed" : undefined}
          onChange={(e) => onChange("pay_floor_unit", e.target.value)}
        >
          {PAY_UNITS.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </select>
      </div>
      {problem && (
        <p className="loc-err" role="alert">
          {problem}
        </p>
      )}
      <p className="loc-hint">
        Kept exactly as you write it. A posting stays when its range reaches this, or when it names no pay at all; it is
        screened only when its whole range sits below it. Empty it and the search has no pay rule.
      </p>
    </div>
  );
}

/** A draft's text edits alone: `paused` is a choice, not one of the written fields. */
function stringEdits(edits: SearchEdit): Partial<SearchFields> {
  const { paused: _paused, ...rest } = edits;
  return rest;
}

function fieldsOf(track: Track): SearchFields {
  return {
    label: track.label,
    role_search_line: track.role_search_line,
    fit_clause: track.fit_clause,
    fit_disqualifier: track.fit_disqualifier,
    pay_floor: track.pay_floor,
    pay_floor_unit: track.pay_floor_unit,
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
