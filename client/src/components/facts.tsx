import type { Application, Lead } from "../api/schema";
import { APP_ROLE_FIELDS, ROLE_FIELDS, STAGE_HISTORY_FIELDS } from "../domain/constants";
import { safeUrl } from "../domain/format";
import { fillState } from "../domain/rows";
import { EditableField, EditableNotes } from "./writes";

type Fields = readonly (readonly [field: string, label: string])[];

/**
 * The Link field stays an editable input - it is how a posting URL gets typed in
 * or corrected - so it opens from an anchor beside its label.
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

/** Every stage, blank ones included, so a missed date can be corrected or a skipped stage backfilled. */
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

/** `compact` drops the top margin, for a grid's expanded row. */
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

export function LeadFactsCard({ lead, compact }: { lead: Lead; compact?: boolean }) {
  return (
    <div className="facts-card" style={compact ? { marginTop: 0 } : undefined}>
      <RoleFields item={lead} kind="lead" fields={ROLE_FIELDS} />
    </div>
  );
}

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
 * Shown only when the run left a note: a posting it couldn't read, or read only
 * part of. Those rows still need something from you; a filled or waiting row
 * doesn't.
 */
export function AutofillNote({ app }: { app: Application }) {
  const note = app.autofill_note || "";
  if (!note) return null;
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
