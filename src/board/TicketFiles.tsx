import { useEffect, useRef, useState } from "react";
import type { Ticket, TicketFile } from "../hub/types";
import { openUrl } from "../platform";
import { plainError } from "../ui/plainError";
import { FileViewer } from "./FileViewer";
import { fileKind, fileLine, localTicketView, UPLOAD_MAX } from "./ticketView";

/** The most files' bytes kept fetched (as `blob:` URLs) at once. */
const KEPT = 48;

type Fetched = { blob: Blob; url: string };

/** Fetches in flight and settled, by ticket, file and size, least recently
 *  used first: a card re-rendered, or a file opened after its card drew it,
 *  isn't fetched again. A failure isn't kept, so it can be tried again. */
const kept = new Map<string, Promise<Fetched>>();

const keep = (key: string, p: Promise<Fetched>): void => {
  kept.set(key, p);
  while (kept.size > KEPT) {
    const [oldest, gone] = kept.entries().next().value!;
    kept.delete(oldest);
    void gone.then((f) => URL.revokeObjectURL(f.url)).catch(() => {});
  }
};

/** `file`'s bytes on ticket `ticket` (its small picture, with `thumb`). */
export const fetchFile = (ticket: string, file: TicketFile, thumb = false): Promise<Fetched> => {
  const key = `${ticket}/${file.id}/${thumb && file.thumb ? "thumb" : "whole"}`;
  const was = kept.get(key);
  if (was) {
    kept.delete(key);
    kept.set(key, was);
    return was;
  }
  const api = localTicketView();
  if (!api) return Promise.reject(new Error("This computer's hub isn't there yet."));
  const p = api.fileBlob(ticket, file.id, thumb && file.thumb).then((blob) => ({ blob, url: URL.createObjectURL(blob) }));
  keep(key, p);
  p.catch(() => kept.get(key) === p && kept.delete(key));
  return p;
};

/** `file`'s bytes as a URL to draw, once fetched; why not, if they weren't. */
export const useFileUrl = (ticket: string, file: TicketFile | null, thumb = false): { url: string | null; blob: Blob | null; problem: string | null } => {
  const [got, setGot] = useState<{ url: string | null; blob: Blob | null; problem: string | null }>({ url: null, blob: null, problem: null });
  const id = file?.id;
  useEffect(() => {
    if (!file || file.source === "linear_link") return setGot({ url: null, blob: null, problem: null });
    let live = true;
    setGot({ url: null, blob: null, problem: null });
    fetchFile(ticket, file, thumb).then(
      (f) => live && setGot({ url: f.url, blob: f.blob, problem: null }),
      (e) => live && setGot({ url: null, blob: null, problem: plainError(e) }),
    );
    return () => {
      live = false;
    };
    // The file is the same file while its id is.
  }, [ticket, id, thumb]);
  return got;
};

/** Opens a link file where it is, if it's an `https` address. */
const openLink = (f: TicketFile): void => {
  if (f.url && /^https:\/\//i.test(f.url)) void openUrl(f.url);
};

/** Dropping files on a ticket of your own: how many are on their way, and
 *  what went wrong, said through `onProblem`. */
export const useUploads = (t: Ticket, onProblem: (p: string | null) => void) => {
  const [adding, setAdding] = useState(0);
  const add = async (picked: readonly File[]) => {
    const api = localTicketView();
    if (!api || !picked.length) return;
    onProblem(null);
    setAdding((n) => n + picked.length);
    for (const file of picked) {
      try {
        if (file.size > UPLOAD_MAX) throw new Error(`${file.name} is over ${UPLOAD_MAX / (1024 * 1024)} MB.`);
        await api.upload(t.id, file);
      } catch (e) {
        onProblem(plainError(e));
      } finally {
        setAdding((n) => n - 1);
      }
    }
  };
  const remove = (f: TicketFile) => {
    const api = localTicketView();
    if (!api) return;
    onProblem(null);
    api.removeFile(t.id, f.id).catch((e) => onProblem(plainError(e)));
  };
  return { adding, add, remove };
};

export type Uploads = ReturnType<typeof useUploads>;

/** A ticket's files, as cards: a picture's small picture, a PDF's badge,
 *  a link's. A picture or file opens in the viewer; a link where it is. On a
 *  ticket of your own, files are dropped on it or added, and taken off. */
export function TicketFiles({ ticket: t, local, uploads }: { ticket: Ticket; local: boolean; uploads: Uploads }) {
  const files = t.files ?? [];
  const [open, setOpen] = useState<number | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const viewable = files.filter((f) => f.source !== "linear_link");
  const { adding, add, remove } = uploads;
  if (!files.length && !local) return null;
  return (
    <section className="ticket-files" aria-label="Attachments">
      <h2 className="ticket-section-head">
        Attachments · {files.length}
        {adding > 0 && <span className="ticket-section-note"> · adding {adding}…</span>}
      </h2>
      <div className="ticket-file-cards">
        {files.map((f) => (
          <FileCard
            key={f.id}
            ticket={t.id}
            file={f}
            onOpen={() => (f.source === "linear_link" ? openLink(f) : setOpen(viewable.indexOf(f)))}
            onRemove={local && f.source === "upload" ? () => remove(f) : undefined}
          />
        ))}
        {local && <DropCard onPick={() => pick.current?.click()} />}
      </div>
      {local && (
        <input
          ref={pick}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void add([...e.target.files]);
            e.target.value = "";
          }}
        />
      )}
      {open !== null && viewable[open] && <FileViewer ticket={t} files={viewable} at={open} onAt={setOpen} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** One file's card. */
function FileCard({ ticket, file: f, onOpen, onRemove }: { ticket: string; file: TicketFile; onOpen: () => void; onRemove?: () => void }) {
  const kind = fileKind(f);
  const picture = useFileUrl(ticket, kind === "image" ? f : null, true);
  const label = kind === "link" ? `Open link: ${f.name}` : kind === "image" ? `Open picture: ${f.name}` : `Open file: ${f.name}`;
  return (
    <div className={`ticket-file ticket-file-${kind}`}>
      <button type="button" className="ticket-file-open" aria-label={label} title={f.name} onClick={onOpen}>
        {kind === "image" ? (
          <span className="ticket-file-shot">{picture.url ? <img src={picture.url} alt="" draggable={false} /> : <span className="ticket-file-shot-wait" aria-hidden="true" />}</span>
        ) : (
          <span className={`ticket-file-badge ticket-file-badge-${kind}`} aria-hidden="true">
            {kind === "pdf" ? "PDF" : kind === "link" ? "LINK" : (f.name.split(".").pop() ?? "FILE").slice(0, 4).toUpperCase()}
          </span>
        )}
        <span className="ticket-file-name">
          {f.name}
          <span className="ticket-file-line">{fileLine(f)}</span>
        </span>
      </button>
      {onRemove && (
        <button type="button" className="icon-btn-sm ticket-file-remove" aria-label={`Take ${f.name} off`} title="Take it off" onClick={onRemove}>
          <svg width="11" height="11" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Where files are added to a ticket of your own: picked here, or dropped
 *  anywhere on its reading column. */
function DropCard({ onPick }: { onPick: () => void }) {
  return (
    <button type="button" className="ticket-file ticket-file-drop" onClick={onPick}>
      <span className="ticket-file-drop-plus" aria-hidden="true">
        +
      </span>
      <span className="ticket-file-name">
        Add a file
        <span className="ticket-file-line">or drop one here</span>
      </span>
    </button>
  );
}
