import { useCallback, useEffect, useId, useRef, useState, type DragEvent } from "react";
import { droppedFiles, readDropped, type DroppedFile } from "../drop/native";
import { nativeDrops, registerZone, useDropOver, ZONE_ATTR } from "../drop/route";
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
 *  wrong with any that couldn't be; `sent` lets go of those a message took,
 *  keeping any picked while it went. */
export function usePendingFiles() {
  const [state, setState] = useState<{ pending: Pending[]; problem: string | null }>({ pending: [], problem: null });
  const add = useCallback((files: readonly File[]) => setState((s) => adding(s.pending, files, () => crypto.randomUUID())), []);
  const remove = useCallback((id: string) => setState((s) => ({ ...s, pending: s.pending.filter((p) => p.id !== id) })), []);
  const sent = useCallback(
    (files: readonly File[]) => setState((s) => ({ pending: s.pending.filter((p) => !files.includes(p.file)), problem: null })),
    [],
  );
  const setProblem = useCallback((problem: string | null) => setState((s) => ({ ...s, problem })), []);
  return { ...state, files: state.pending.map((p) => p.file), add, remove, sent, setProblem };
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

/** Files dropped from the system, as a message attaches them: each read
 *  whole, those it can't carry (a folder, one too big) said instead. */
export const filesOfDrop = async (paths: string[]): Promise<{ files: File[]; problem: string | null }> => {
  const found = await droppedFiles(paths);
  const problems: string[] = [];
  const files: File[] = [];
  const take: DroppedFile[] = [];
  for (const f of found) {
    const why = f.folder ? `${f.name} is a folder: drop the files in it.` : tooBig(f);
    if (why) problems.push(why);
    else take.push(f);
  }
  // No more are read than a message carries.
  if (take.length > MAX_FILES) problems.push(`A message can carry up to ${MAX_FILES} files.`);
  for (const f of take.slice(0, MAX_FILES)) files.push(await readDropped(f));
  return { files, problem: problems.join(" ") || null };
};

/** Dropping files anywhere on an element: whether some are being dragged
 *  over it, and what to spread on it. In the app the system's own drag and
 *  drop brings them (see drop/route.ts); in the browser preview, the
 *  page's. `onProblem` hears of a drop it couldn't take. */
export function useFileDrop(onFiles: (files: File[]) => void, onProblem?: (problem: string | null) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const id = useId();
  const over = useDropOver((s) => s.over === id);
  const latest = useRef({ onFiles, onProblem });
  latest.current = { onFiles, onProblem };
  const native = nativeDrops();
  useEffect(
    () =>
      native
        ? registerZone(id, {
            label: "conversation",
            drop: (paths) =>
              void filesOfDrop(paths).then(
                ({ files, problem }) => {
                  if (files.length) latest.current.onFiles(files);
                  if (problem) latest.current.onProblem?.(problem);
                },
                (e: unknown) => latest.current.onProblem?.(e instanceof Error ? e.message : String(e)),
              ),
          })
        : undefined,
    [id, native],
  );
  if (native) return { dragging: over, handlers: { [ZONE_ATTR]: id } };
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
