/**
 * Editable controls. A field commits on blur, not per keystroke - the right
 * granularity for text someone is still typing.
 */
import { useEffect, useState } from "react";
import type { Application, Lead } from "../api/schema";
import { useSetApplicationStatus, useSetLeadStatus, useUpdateField } from "../api/mutations";
import { APP_STAGE_DATE_MAP, APP_STATUS, LEAD_STATUS } from "../domain/constants";
import { today } from "../domain/format";

/** Stages booked ahead, so the date logged is often in the future; the dialog asks accordingly. */
const STAGE_SCHEDULED = new Set(["Recruiter Screen", "Tech Screen", "Onsite / Loop"]);

/** Shows the local draft while there is one, so a refetch landing mid-edit can't replace the text under the cursor. */
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
      // Read the value from e.target, not `draft`: the last keystroke's state
      // may not have committed when blur runs, and a stale draft skips the save.
      onBlur={(e) => {
        const value = e.target.value;
        if (value === serverValue) {
          setDraft(null);
          return;
        }
        // Hold the draft until onSettled. The optimistic patch lands a tick
        // later (onMutate awaits cancelQueries), so clearing now flashes the old
        // value; by onSettled the cache holds the new value or the rollback.
        update.mutate(
          { kind, id: row.id, field, value },
          { onSettled: () => setDraft(null) },
        );
      }}
    />
  );
}

/** Same commit-on-blur contract as EditableField, and the same reason for reading the event. */
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
 * Moving into a stage whose history column is still blank asks for its date
 * rather than stamping today, because changes are often logged days later. A
 * stage already reached goes straight through.
 */
export function AppStatusSelect({
  app,
  pending,
  onNeedsDate,
}: {
  app: Application;
  /**
   * The change StageDateModal is asking about, if any. The select shows it while
   * the dialog is open, so it reads as the stage being dated rather than the one
   * being left.
   */
  pending?: PendingStage | null;
  onNeedsDate: (p: PendingStage) => void;
}) {
  const setStatus = useSetApplicationStatus();
  return (
    <select
      value={pending?.app.id === app.id ? pending.status : app.status}
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
 * Cancelling writes nothing; the select it was opened from is controlled, so it
 * returns to the row's real status on its own.
 */
export function StageDateModal({
  pending,
  onClose,
}: {
  pending: PendingStage | null;
  onClose: () => void;
}) {
  // Split so the dialog mounts per opening: today's date is plain initial state
  // and autoFocus does the focusing, with no resetting effect.
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
      // Only a click on the backdrop itself cancels, not one on the card.
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
