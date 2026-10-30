import { useCallback, useRef, useState, type DragEvent } from "react";
import { describe, formatSize, kindOf } from "./kinds";
import { MAX_FILE_BYTES, MAX_FILES, tooBig } from "./upload";

/** A file waiting to go with your next message. */
export interface Pending {
  id: string;
  file: File;
}

/** What's going with your next message: `files` added to `have`, up to
 *  what a message carries, and what was wrong with any that couldn't be. */
export const adding = (have: readonly Pending[], files: readonly File[], id: () => string): { pending: Pending[]; problem: string | null } => {
  const refused = files.map(tooBig).filter((why): why is string => why !== null);
  const ok = files.filter((f) => !tooBig(f));
  const room = Math.max(0, MAX_FILES - have.length);
  const over = ok.length > room ? [`A message can carry up to ${MAX_FILES} files.`] : [];
  return {
    pending: [...have, ...ok.slice(0, room).map((file) => ({ id: id(), file }))],
    problem: [...refused, ...over].join(" ") || null,
  };
};

/** The files you've picked or dropped for your next message, and what was
 *  wrong with any that couldn't be. */
export function usePendingFiles() {
  const [state, setState] = useState<{ pending: Pending[]; problem: string | null }>({ pending: [], problem: null });
  const add = useCallback((files: readonly File[]) => setState((s) => adding(s.pending, files, () => crypto.randomUUID())), []);
  const remove = useCallback((id: string) => setState((s) => ({ ...s, pending: s.pending.filter((p) => p.id !== id) })), []);
  const clear = useCallback(() => setState({ pending: [], problem: null }), []);
  const setProblem = useCallback((problem: string | null) => setState((s) => ({ ...s, problem })), []);
  return { ...state, files: state.pending.map((p) => p.file), add, remove, clear, setProblem };
}

/** 📎: picks files for your next message. */
export function AttachButton({ onFiles, disabled = false }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="icon-btn-sm composer-attach"
        aria-label="Attach a file"
        title="Attach a file (or drop one here)"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M11.5 7.5l-4.6 4.6a2.6 2.6 0 01-3.7-3.7l5.3-5.3a1.7 1.7 0 012.4 2.4L5.6 10.8" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** The files going with your next message, each to take off again. */
export function PendingFiles({ pending, problem, onRemove }: { pending: Pending[]; problem: string | null; onRemove: (id: string) => void }) {
  if (!pending.length && !problem) return null;
  return (
    <div className="pending-files">
      {pending.map(({ id, file }) => {
        const kind = kindOf(file.type, file.name);
        return (
          <span key={id} className="pending-file" title={describe(kind, file.size)}>
            <span className={`att-badge att-badge-sm att-badge-${kind.family}`} aria-hidden="true">
              {kind.badge}
            </span>
            <span className="att-name">{file.name}</span>
            <span className="small muted">{formatSize(file.size)}</span>
            <button type="button" className="icon-btn-sm" aria-label={`Remove ${file.name}`} onClick={() => onRemove(id)}>
              <svg width="11" height="11" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </span>
        );
      })}
      {problem && (
        <span className="small state-blocked pending-problem" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

const carriesFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");

/** Dropping files anywhere on an element: whether some are being dragged
 *  over it, and the handlers to spread on it. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
    },
  };
  return { dragging, handlers };
}

/** What dropping files here does, over the conversation while they're
 *  dragged over it. */
export function DropOverlay({ to }: { to: string }) {
  return (
    <div className="drop-overlay" aria-hidden="true">
      <span className="drop-overlay-text">
        <b className="display-md">Drop to send to {to}</b>
        <span className="small muted">Up to {formatSize(MAX_FILE_BYTES)} a file · they’re attached to your next message</span>
      </span>
    </div>
  );
}
