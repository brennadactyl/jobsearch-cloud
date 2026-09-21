/**
 * The account panel's resume section: the resumes this account has, and which
 * one each search reads.
 *
 * Adding a resume and choosing it are two steps. A file uploads (or pasted text
 * is stored) the moment it's added, and joins the list read by no search. The
 * pickers only change what a search reads on the panel's Save, which writes
 * every changed search at once; each takes its new resume on its next run.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { deleteDocument, failureOf, listDocuments, putDocument, UnauthorizedError } from "../api/client";
import { DOCUMENTS_KEY } from "../api/mutations";
import type { StoredResume, Track } from "../api/schema";
import { safeDocumentName } from "../domain/onboarding";
import {
  attachRefusal,
  currentResume,
  fileNameOf,
  joinNames,
  removeRefusal,
  resumeDetail,
  resumeRows,
  rootSearches,
  waitingChange,
} from "../domain/resumes";

type Msg = { text: string; tone: "good" | "bad" } | null;

export default function ResumeSection({
  tracks,
  picks,
  setPicks,
  onUnsaved,
}: {
  tracks: readonly Track[];
  /** Only the searches whose picker differs from what they read; the panel saves them. */
  picks: Record<string, string>;
  setPicks: Dispatch<SetStateAction<Record<string, string>>>;
  /** Called with what leaving now would lose, in the leave prompt's words; "" when nothing. */
  onUnsaved: (sentence: string) => void;
}) {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: DOCUMENTS_KEY, queryFn: listDocuments });
  const stored = docs.data ?? [];
  const rows = resumeRows(stored);
  const readable = rows.filter((r) => r.readable);
  const searches = rootSearches(tracks);
  const labelOf = (key: string) => tracks.find((t) => t.key === key)?.label || key;

  // Files added in this visit, which show "just now" and stand out in the list.
  const [added, setAdded] = useState<Record<string, "uploaded" | "pasted">>({});
  const [uploading, setUploading] = useState("");
  const [attachMsg, setAttachMsg] = useState<Msg>(null);
  const [pasting, setPasting] = useState(false);
  // A refusal is "readers" when the page worked it out from who reads the
  // file, and "server" when the delete itself was refused.
  const [removing, setRemoving] = useState<{ path: string; refusal: string; why: "readers" | "server" } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const unsavedSentence = unsavedSummary(picks, rows, labelOf, Object.keys(added).length);
  useEffect(() => onUnsaved(unsavedSentence), [unsavedSentence, onUnsaved]);

  const refresh = () => qc.invalidateQueries({ queryKey: DOCUMENTS_KEY });

  /** A refusal worth showing as the server wrote it, or null for a 401 that has already shown the gate. */
  function reasonOf(err: unknown): string | null {
    if (err instanceof UnauthorizedError) return null;
    return failureOf(err)?.message ?? (err instanceof Error ? err.message : String(err));
  }

  async function store(name: string, path: string, body: Blob, how: "uploaded" | "pasted"): Promise<boolean> {
    setRemoving(null);
    const refusal = attachRefusal(name, body.size, path, stored, labelOf);
    if (refusal) {
      setAttachMsg({ text: refusal, tone: "bad" });
      return false;
    }
    setAttachMsg(null);
    setUploading(fileNameOf(path));
    try {
      const res = await putDocument(path, body);
      await refresh();
      setAdded((a) => ({ ...a, [res.path]: how }));
      const words = typeof res.words === "number" ? res.words : qc.getQueryData<StoredResume[]>(DOCUMENTS_KEY)?.find((d) => d.path === res.path)?.words;
      const read = typeof words === "number" ? ` · ${words} words read` : "";
      setAttachMsg({
        text: `${how === "pasted" ? "Added" : "Attached"} ${fileNameOf(res.path)}${read}. Choose it for a search below, then save.`,
        tone: "good",
      });
      return true;
    } catch (err) {
      const reason = reasonOf(err);
      if (reason) setAttachMsg({ text: reason, tone: "bad" });
      return false;
    } finally {
      setUploading("");
    }
  }

  function choose(search: string, path: string) {
    setRemoving(null);
    setPicks((p) => {
      const next = { ...p };
      if (path === currentResume(rows, search)) delete next[search];
      else next[search] = path;
      return next;
    });
  }

  function askToRemove(row: StoredResume) {
    setAttachMsg(null);
    setRemoving({ path: row.path, refusal: removeRefusal(row, labelOf), why: "readers" });
  }

  /**
   * What a row shows about removing it. A refusal over the searches that read
   * the file is checked against the list as it is now, so it lapses once a
   * save points those searches elsewhere.
   */
  function removingFor(row: StoredResume): { refusal: string } | null {
    if (removing?.path !== row.path) return null;
    if (removing.why === "server" || !removing.refusal) return removing;
    const refusal = removeRefusal(row, labelOf);
    return refusal ? { refusal } : null;
  }

  async function remove(path: string) {
    try {
      await deleteDocument(path);
      setRemoving(null);
      setPicks((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== path)));
      await refresh();
    } catch (err) {
      const reason = reasonOf(err);
      if (reason) setRemoving({ path, refusal: reason, why: "server" });
    }
  }

  return (
    <section className="account-section" aria-labelledby="resumeTitle">
      <div>
        <h4 id="resumeTitle">Resume</h4>
        <p>The resumes your searches read. A change takes effect on that search's next run.</p>
      </div>

      <div className="resume-group">
        <div className="account-sub">Your resumes</div>
        {docs.isPending && <p className="resume-quiet">Loading your resumes…</p>}
        {docs.isError && <p className="resume-bad">{reasonOf(docs.error) ?? ""}</p>}
        {docs.isSuccess && rows.length === 0 && !uploading && <p className="resume-quiet">No resumes yet.</p>}
        {rows.map((row) => (
          <ResumeRow
            key={row.path}
            row={row}
            added={added[row.path] ?? null}
            labelOf={labelOf}
            removing={removingFor(row)}
            onRemove={() => askToRemove(row)}
            onConfirm={() => void remove(row.path)}
            onCancel={() => setRemoving(null)}
          />
        ))}
        {uploading && (
          <div className="resume-row uploading">
            <div className="resume-row-top">
              <FileIcon />
              <span className="resume-name">{uploading}</span>
            </div>
            <div className="resume-progress" role="progressbar" aria-label={`Uploading ${uploading}`} />
          </div>
        )}
      </div>

      <div className="resume-attach">
        <div className="resume-attach-row">
          <button className="btn" type="button" disabled={!!uploading} onClick={() => fileInput.current?.click()}>
            {uploading ? "Uploading…" : "Attach a resume"}
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".pdf,.docx,.txt,.md"
            aria-label="Attach a resume"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void store(file.name, `resumes/${safeDocumentName(file.name)}`, file, "uploaded");
            }}
          />
          <button
            className={`btn${pasting ? " pressed" : ""}`}
            type="button"
            aria-pressed={pasting}
            onClick={() => setPasting((p) => !p)}
          >
            Paste text
          </button>
          <span className="resume-quiet">PDF, Word (.docx), .txt or .md, up to 8 MB</span>
        </div>
        {attachMsg && (
          <div className={attachMsg.tone === "bad" ? "resume-bad" : "resume-good"} role="alert">
            {attachMsg.text}
          </div>
        )}
        {pasting && (
          <PasteBox
            busy={!!uploading}
            onCancel={() => setPasting(false)}
            onAdd={async (name, text) => {
              const fileName = `${name}.txt`;
              const ok = await store(fileName, `resumes/${safeDocumentName(fileName)}`, new Blob([text], { type: "text/plain" }), "pasted");
              if (ok) setPasting(false);
            }}
          />
        )}
      </div>

      {searches.length > 0 && (
        <div className="resume-group">
          <div className="account-sub">Which resume each search reads</div>
          {searches.map((t) => {
            const current = currentResume(rows, t.key);
            const value = picks[t.key] ?? current;
            const isChanged = t.key in picks;
            const waiting = waitingChange(rows, t.key);
            const label = labelOf(t.key);
            return (
              <div className="resume-pick" key={t.key}>
                <div className="resume-pick-row">
                  <label htmlFor={`resume-${t.key}`}>
                    {label}
                    {isChanged && <span className="resume-changed"> Changed</span>}
                  </label>
                  <select
                    id={`resume-${t.key}`}
                    aria-label={`Resume for ${label}`}
                    className={isChanged ? "changed" : undefined}
                    value={value}
                    onChange={(e) => choose(t.key, e.target.value)}
                  >
                    {!readable.some((r) => r.path === value) && (
                      <option value={value} disabled>
                        {value ? fileNameOf(value) : "Choose a resume"}
                      </option>
                    )}
                    {readable.map((r) => (
                      <option key={r.path} value={r.path}>
                        {fileNameOf(r.path)}
                      </option>
                    ))}
                  </select>
                </div>
                {isChanged ? (
                  <div className="resume-note">
                    Not saved yet. Once you save, {label} reads it from its next run.
                  </div>
                ) : (
                  waiting && (
                    <div className="resume-note wait">
                      Saved. Waiting for tonight's run: until then {label} still searches with{" "}
                      {fileNameOf(waiting.until)}. Tonight it reads {fileNameOf(waiting.from)} and rewrites its profile
                      from it before searching.
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ResumeRow({
  row,
  added,
  labelOf,
  removing,
  onRemove,
  onConfirm,
  onCancel,
}: {
  row: StoredResume;
  added: "uploaded" | "pasted" | null;
  labelOf: (key: string) => string;
  removing: { refusal: string } | null;
  onRemove: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const name = fileNameOf(row.path);
  const tabs = [...new Set(row.used_by.flatMap((u) => u.tabs))];
  const until = row.used_by.filter((u) => u.state === "until_next_run").map((u) => labelOf(u.search));
  const from = row.used_by.some((u) => u.state === "from_next_run");
  const tone = removing ? " alert" : added ? " new" : "";
  return (
    <div className={`resume-row${tone}`}>
      <div className="resume-row-top">
        <FileIcon />
        <div className="resume-row-main">
          <div className="resume-row-title">
            <span className="resume-name">{name}</span>
            <span className="resume-quiet">{resumeDetail(row, added)}</span>
          </div>
          {!row.readable && (
            <div className="resume-bad">No text could be read from it, so no search can use it.</div>
          )}
          {tabs.length ? (
            <div className="resume-used">
              <span className="resume-quiet">Used by</span>
              {tabs.map((k) => (
                <span className="resume-chip" key={k}>
                  {labelOf(k)}
                </span>
              ))}
              {until.length > 0 && <span className="resume-quiet">({joinNames(until)} until tonight)</span>}
              {from && <span className="resume-quiet">(from tonight)</span>}
            </div>
          ) : (
            <div className="resume-unused">Not used by any search</div>
          )}
        </div>
        {!removing && (
          <button className="btn ghost" type="button" aria-label={`Remove ${name}`} onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {removing?.refusal && (
        <div className="resume-below resume-bad" role="alert">
          {removing.refusal}
        </div>
      )}
      {removing && !removing.refusal && (
        <div className="resume-below resume-confirm">
          <span>Remove {name}? It's deleted for good. No search reads it.</span>
          <div className="modal-actions">
            <button className="btn" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button className="btn danger" type="button" onClick={onConfirm}>
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PasteBox({
  busy,
  onCancel,
  onAdd,
}: {
  busy: boolean;
  onCancel: () => void;
  onAdd: (name: string, text: string) => void;
}) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [problem, setProblem] = useState("");
  return (
    <div className="resume-paste">
      <div className="pw-field">
        <label htmlFor="pasteName">Name</label>
        <div className="resume-paste-name">
          <input id="pasteName" type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          <span className="resume-quiet">.txt</span>
        </div>
      </div>
      <div className="pw-field">
        <label htmlFor="pasteText">Resume text</label>
        <textarea id="pasteText" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {problem && (
        <div className="resume-bad" role="alert">
          {problem}
        </div>
      )}
      <div className="resume-paste-foot">
        <span className="resume-quiet">Stored as a resume, like an attached file</span>
        <div className="modal-actions">
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy}
            onClick={() => {
              if (!name.trim()) return setProblem("Give it a name.");
              if (!text.trim()) return setProblem("Paste the resume's text.");
              setProblem("");
              onAdd(name.trim(), text);
            }}
          >
            Add resume
          </button>
        </div>
      </div>
    </div>
  );
}

function FileIcon() {
  return (
    <svg
      className="resume-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

/** What leaving now would lose, in the words the leave prompt uses. */
function unsavedSummary(
  picks: Record<string, string>,
  rows: readonly StoredResume[],
  labelOf: (key: string) => string,
  addedCount: number,
): string {
  const keys = Object.keys(picks);
  if (!keys.length) return "";
  let sentence: string;
  if (keys.length === 1) {
    const label = labelOf(keys[0]);
    const current = currentResume(rows, keys[0]);
    sentence = current
      ? `You chose ${fileNameOf(picks[keys[0]])} for ${label} but didn't save, so ${label} keeps ${fileNameOf(current)}.`
      : `You chose ${fileNameOf(picks[keys[0]])} for ${label} but didn't save, so ${label} keeps what it reads now.`;
  } else {
    sentence = `You chose new resumes for ${joinNames(keys.map(labelOf))} but didn't save, so they keep the ones they read now.`;
  }
  if (addedCount === 1) sentence += " The file you attached stays in your resumes either way.";
  if (addedCount > 1) sentence += " The files you attached stay in your resumes either way.";
  return sentence;
}
