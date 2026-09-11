/**
 * What sits under a row's header: role details, stage history, notes, and the
 * one thing the overnight fill says.
 *
 * The markup is the old client's, class for class - `facts-card` > `mf-label`
 * > `more-grid` > `mf`, and `stage-hist` - because tracker.css is a copy of its
 * stylesheet and those are the selectors it targets. The first version of this
 * invented its own names (`facts`, `fcard`, `fgrid`), matched none of them, and
 * rendered all three cards unstyled. Keep the names; change the stylesheet if
 * the look has to change.
 */
import type { Application, Lead } from "../api/schema";
import { APP_ROLE_FIELDS, ROLE_FIELDS, STAGE_HISTORY_FIELDS } from "../domain/constants";
import { safeUrl } from "../domain/format";
import { fillState } from "../domain/rows";
import { EditableField, EditableNotes } from "./writes";

type Fields = readonly (readonly [field: string, label: string])[];

/**
 * The field grid. The Link field stays an editable input - it is how a posting
 * URL gets typed in or corrected - so the way to open it is an anchor beside its
 * label rather than turning the field itself into a link.
 */
export function RoleFields({
  item,
  kind,
  fields,
}: {
  item: Lead | Application;
  kind: "lead" | "application";
  fields: Fields;
}) {
  const row = item as unknown as Record<string, string>;
  return (
    <div className="more-grid">
      {fields.map(([field, label]) => {
        const safe = field === "link" ? safeUrl(row[field]) : "";
        return (
          <div className="mf" key={field}>
            {safe ? (
              <div className="mf-labelrow">
                <label>{label}</label>
                <a className="mf-open" href={safe} target="_blank" rel="noopener noreferrer">
                  Open ↗
                </a>
              </div>
            ) : (
              <label>{label}</label>
            )}
            <EditableField row={item} kind={kind} field={field} placeholder={label} ariaLabel={label} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Every stage, not only the ones reached. Each date is stamped once when the
 * status first gets there, and stays editable so a missed day can be corrected
 * or a skipped stage backfilled - which is the reason for showing the blank rows.
 */
export function StageHistory({ app }: { app: Application }) {
  return (
    <div className="stage-hist">
      <table>
        <tbody>
          {STAGE_HISTORY_FIELDS.map(([field, label]) => (
            <tr key={field}>
              <th>{label}</th>
              <td>
                <EditableField row={app} kind="application" field={field} type="date" ariaLabel={label} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * An application's cards: role details, then stage history. `compact` drops the
 * first card's top margin, for use inside a grid's expanded row.
 */
export function AppFactsCards({ app, compact }: { app: Application; compact?: boolean }) {
  return (
    <>
      <div className="facts-card" style={compact ? { marginTop: 0 } : undefined}>
        <div className="mf-label">Role details</div>
        <RoleFields item={app} kind="application" fields={APP_ROLE_FIELDS} />
      </div>
      <div className="facts-card">
        <div className="mf-label">Stage history</div>
        <StageHistory app={app} />
      </div>
    </>
  );
}

/** A lead's role details: the grid alone with no heading, which is how the old client draws a lead - unlike an application. */
export function LeadFactsCard({ lead, compact }: { lead: Lead; compact?: boolean }) {
  return (
    <div className="facts-card" style={compact ? { marginTop: 0 } : undefined}>
      <RoleFields item={lead} kind="lead" fields={ROLE_FIELDS} />
    </div>
  );
}

/** Notes, as their own block below the facts rather than a card among them. */
export function NotesBlock({
  row,
  kind,
  placeholder,
}: {
  row: Lead | Application;
  kind: "lead" | "application";
  placeholder?: string;
}) {
  return (
    <div className="dh-notes">
      <div className="mf-label">Notes</div>
      <EditableNotes row={row} kind={kind} placeholder={placeholder} />
    </div>
  );
}

/**
 * The only thing the overnight fill says on this page, and only when the run
 * left a note: a posting it could not read at all, or one it read part of. A
 * plainly filled row says nothing, and neither does a row still waiting - there
 * is nothing to do about that but wait.
 */
export function AutofillNote({ app }: { app: Application }) {
  const note = app.autofill_note || "";
  if (!note) return null;
  // Asks fillState() rather than re-testing `autofill === "failed"`. The old
  // client writes that rule out in four places; this is where a fifth would go.
  const failed = fillState(app) === "stuck";
  return (
    <div className={`af${failed ? " bad" : ""}`}>
      {failed
        ? "The nightly fill could not read this posting — fill it in by hand."
        : "The nightly fill read part of this posting — check what’s missing."}{" "}
      <span className="af-why">{note}</span>
    </div>
  );
}
