/**
 * The editable controls, and the one dialog that interrupts a write.
 *
 * A field commits on blur, not on every keystroke: the old page does the same,
 * and it is the right granularity for text someone is still typing. Status is
 * the exception on both kinds of row - it goes through its own endpoint,
 * because the server owns side effects a plain field patch cannot do.
 */
import { useEffect, useState } from "react";
import type { Application, Lead } from "../api/schema";
import { useSetApplicationStatus, useSetLeadStatus, useUpdateField } from "../api/mutations";
import { APP_STAGE_DATE_MAP, APP_STATUS, LEAD_STATUS } from "../domain/constants";
import { today } from "../domain/format";

/**
 * These three are booked ahead - a recruiter reaches out to set up a call, a
 * loop gets scheduled for next week - so the date being logged is often still in
 * the future. The rest are only ever logged after the fact, and the dialog's
 * title asks the question that fits either way.
 */
const STAGE_SCHEDULED = new Set(["Recruiter Screen", "Tech Screen", "Onsite / Loop"]);

/**
 * A text/date field that saves when you click away.
 *
 * Controlled from props while idle and from local state while focused, so a
 * refetch landing mid-edit cannot yank the text out from under the cursor -
 * which is a hazard this client has and the old page did not, because there the
 * only repaint was one it triggered itself.
 */
export function EditableField({
  row,
  kind,
  field,
  type = "text",
  placeholder,
  ariaLabel,
  className,
  size,
}: {
  row: Lead | Application;
  kind: "lead" | "application";
  field: string;
  type?: "text" | "date";
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  /** Width in characters - the application header's location input sizes itself to its value. */
  size?: number;
}) {
  const update = useUpdateField();
  const serverValue = ((row as unknown as Record<string, string>)[field] ?? "");
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? serverValue;

  return (
    <input
      type={type}
      className={className}
      size={size}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel ?? field}
      onChange={(e) => setDraft(e.target.value)}
      // Reads the value off the event rather than out of `draft`. The state set
      // by the last keystroke has not necessarily committed by the time blur
      // runs - the two can land in the same task - and a handler closing over a
      // stale `draft` would silently skip the save. The element always knows
      // what it is showing, so ask it.
      onBlur={(e) => {
        const value = e.target.value;
        if (value === serverValue) {
          setDraft(null);
          return;
        }
        // The draft is held until the write settles, not dropped here. The
        // optimistic cache patch lands a tick later (onMutate awaits
        // cancelQueries), so clearing now would render one frame of the *old*
        // value in between - which on an empty field is the placeholder
        // flashing back up behind what was just typed.
        //
        // By the time onSettled runs the field agrees either way: on success
        // the patch has made serverValue this value, and on failure the
        // rollback has restored the old one, which is what should be shown.
        update.mutate(
          { kind, id: row.id, field, value },
          { onSettled: () => setDraft(null) },
        );
      }}
    />
  );
}

/** The notes box. Same commit-on-blur contract as EditableField, and the same reason for reading the event. */
export function EditableNotes({
  row,
  kind,
  placeholder,
}: {
  row: Lead | Application;
  kind: "lead" | "application";
  placeholder?: string;
}) {
  const update = useUpdateField();
  const serverValue = row.notes ?? "";
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <textarea
      rows={3}
      placeholder={placeholder}
      aria-label="Notes"
      value={draft ?? serverValue}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        const value = e.target.value;
        if (value === serverValue) {
          setDraft(null);
          return;
        }
        // Held until settled, same as EditableField - see the note there.
        update.mutate(
          { kind, id: row.id, field: "notes", value },
          { onSettled: () => setDraft(null) },
        );
      }}
    />
  );
}

export function LeadStatusSelect({ lead }: { lead: Lead }) {
  const setStatus = useSetLeadStatus();
  return (
    <select
      value={lead.status}
      aria-label="Status"
      onChange={(e) => setStatus.mutate({ id: lead.id, status: e.target.value })}
    >
      {LEAD_STATUS.map((s) => (
        <option key={s}>{s}</option>
      ))}
    </select>
  );
}

export interface PendingStage {
  app: Application;
  status: string;
  dateField: string;
}

/**
 * An application's status.
 *
 * Moving into a pipeline stage that has not happened yet - its history column is
 * still blank - asks when it actually happened rather than silently stamping
 * today, because the change is often logged a few days after the fact. A stage
 * already reached goes straight through.
 */
export function AppStatusSelect({
  app,
  onNeedsDate,
}: {
  app: Application;
  onNeedsDate: (p: PendingStage) => void;
}) {
  const setStatus = useSetApplicationStatus();
  return (
    <select
      value={app.status}
      aria-label="Status"
      onChange={(e) => {
        const status = e.target.value;
        const dateField = APP_STAGE_DATE_MAP[status];
        if (status !== app.status && dateField && !(app as unknown as Record<string, string>)[dateField]) {
          onNeedsDate({ app, status, dateField });
          return;
        }
        setStatus.mutate({ id: app.id, status });
      }}
    >
      {APP_STATUS.map((s) => (
        <option key={s}>{s}</option>
      ))}
    </select>
  );
}

/**
 * Asks for the date a status change actually happened, or is scheduled for.
 *
 * Cancelling makes no write at all, which is why the select it was opened from
 * is a controlled component: React re-renders it back to the row's real status
 * with no reverting needed. The old page had to reset the element by hand,
 * because the browser had already repainted it by the time "change" fired.
 */
export function StageDateModal({
  pending,
  onClose,
}: {
  pending: PendingStage | null;
  onClose: () => void;
}) {
  // Split so the dialog below *mounts* per opening rather than being reset by
  // an effect. Today's date is then plain initial state and the input's
  // autoFocus does the focusing - both of which an effect was doing by hand,
  // which is a re-render the mount gets for free.
  if (!pending) return null;
  return <StageDateDialog key={`${pending.app.id}:${pending.status}`} pending={pending} onClose={onClose} />;
}

function StageDateDialog({ pending, onClose }: { pending: PendingStage; onClose: () => void }) {
  const setStatus = useSetApplicationStatus();
  const [date, setDate] = useState(today);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirm = () => {
    // The date is the whole point of this dialog - require one.
    if (!date) return;
    setStatus.mutate({ id: pending.app.id, status: pending.status, date });
    onClose();
  };

  const name = pending.app.company || pending.app.title || "This application";

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stageDateTitle"
      // The overlay itself, not the card on top of it - a click on the dimmed
      // backdrop cancels, same as Cancel.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card modal-card">
        <h3 id="stageDateTitle">
          {STAGE_SCHEDULED.has(pending.status) ? "When is this scheduled?" : "When did this happen?"}
        </h3>
        <p>
          {name} — {pending.status}
        </p>
        <input
          autoFocus
          type="date"
          aria-label="Date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
          }}
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={confirm}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
