import { useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { useChat } from "../chat/store";
import { DESK_DM } from "../chat/types";
import { uploadAll } from "../attachments/upload";
import { saveBlobAs } from "../attachments/save";
import type { Ticket, TicketFile } from "../hub/types";
import { localKey, openLocalDm } from "../overview/people";
import { useOverview } from "../overview/store";
import { CloseButton, useModal } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { fetchFile, useFileUrl } from "./TicketFiles";
import { fileKind, RASTER, sizeText } from "./ticketView";

/** What Desk's agent is asked with a picture from a ticket. */
export const askAboutText = (f: TicketFile, key: string | null): string =>
  `Here's ${f.name}${key ? ` from ${key}` : ""}. What do you make of it?`;

/** Sends `file` of ticket `t` to Desk's agent, in its chat, as an
 *  attachment with a question: false when there's no Desk agent on this
 *  computer to ask. */
export const askDeskAbout = async (t: Ticket, f: TicketFile): Promise<boolean> => {
  const agent = useOverview.getState().manager?.agentId;
  const hub = useChat.getState().hubs.find((h) => h.local);
  const key = agent ? localKey(agent) : null;
  if (!agent || !hub || !key) return false;
  const { blob } = await fetchFile(t.id, f);
  const [attachment] = await uploadAll(hub, agent, DESK_DM, [new File([blob], f.name, { type: blob.type || f.mediaType })]);
  openLocalDm(agent);
  const text = askAboutText(f, t.key);
  // The conversation opens asynchronously; send once it is up.
  await new Promise<void>((resolve, reject) => {
    const attempt = (n: number) => {
      if (useChat.getState().send(key, text, { attachments: [attachment!] })) resolve();
      else if (n < 40) setTimeout(() => attempt(n + 1), 150);
      else reject(new Error("Desk's chat didn't open. Try again in a moment."));
    };
    attempt(0);
  });
  return true;
};

/** A ticket's files over everything, one at a time: back and on (← →), a
 *  strip of them all, Save, and Ask Desk about a picture. It is drawn on the
 *  page itself, not inside the ticket's panel: that panel is a container
 *  (and its view clips), which would hold a fixed layer inside it. */
/** A drag over the viewer: nothing behind it in React's tree takes the
 *  drop (the browser preview's; the app's own drops find their zone in the
 *  page, which the viewer, drawn on the page itself, is outside). */
const noDrop = (e: DragEvent) => {
  e.stopPropagation();
  e.preventDefault();
};

export function FileViewer({ ticket: t, files, at, onAt, onClose }: { ticket: Ticket; files: TicketFile[]; at: number; onAt: (i: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const modal = useModal(ref, onClose);
  const f = files[at]!;
  const kind = fileKind(f);
  const shown = useFileUrl(t.id, f);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const canAsk = useOverview((s) => !!s.manager?.agentId);
  useEffect(() => setProblem(null), [at]);
  const go = (step: number) => files.length > 1 && onAt((at + step + files.length) % files.length);
  const size = sizeText(f.size ?? shown.blob?.size);
  return createPortal(
    <div
      ref={ref}
      className="file-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={f.name}
      tabIndex={-1}
      // React passes its events up to what opened it: a press in it never
      // drags a grid's pane, a right click never opens the menu behind it.
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      // Nor is a file dropped on it added to the ticket behind it.
      onDragEnter={noDrop}
      onDragOver={noDrop}
      onDragLeave={(e) => e.stopPropagation()}
      onDrop={noDrop}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          go(e.key === "ArrowLeft" ? -1 : 1);
        } else modal(e);
      }}
    >
      <header className="file-viewer-head">
        <b className="file-viewer-name">{f.name}</b>
        <span className="file-viewer-where">
          {at + 1} of {files.length}
          {t.key ? ` · ${t.key}` : ""}
          {size ? ` · ${size}` : ""}
        </span>
        <span className="file-viewer-gap" />
        {problem && (
          <span className="small state-blocked" role="alert">
            {problem}
          </span>
        )}
        {kind === "image" && canAsk && (
          <button
            type="button"
            className="chip-btn"
            disabled={asking || !shown.blob}
            title="Send this picture to Desk's agent, in its chat"
            onClick={() => {
              setAsking(true);
              setProblem(null);
              askDeskAbout(t, f)
                .then((asked) => (asked ? onClose() : setProblem("Desk's agent isn't on this computer to ask.")))
                .catch((e) => setProblem(plainError(e)))
                .finally(() => setAsking(false));
            }}
          >
            {asking ? "Sending…" : "Ask Desk about it"}
          </button>
        )}
        <button
          type="button"
          className="chip-btn"
          disabled={!shown.blob}
          onClick={() => shown.blob && void saveBlobAs(shown.blob, f.name).catch((e) => setProblem(plainError(e)))}
        >
          Save
        </button>
        <CloseButton onClose={onClose} autoFocus />
      </header>
      <div className="file-viewer-stage">
        <button type="button" className="file-viewer-step" aria-label="Previous" disabled={files.length < 2} onClick={() => go(-1)}>
          ‹
        </button>
        <div className="file-viewer-frame">
          {shown.problem ? (
            <p className="muted">{shown.problem}</p>
          ) : !shown.url ? (
            <p className="faint">Opening…</p>
          ) : RASTER.has(shown.blob?.type ?? "") ? (
            <img className="file-viewer-image" src={shown.url} alt={f.name} />
          ) : shown.blob?.type === "application/pdf" ? (
            // Never drawn in place: a PDF viewer won't draw in a sandboxed
            // frame, and an unsandboxed one would run as Desk's own page.
            <p className="muted">Desk opens PDFs outside itself: Save it to open it.</p>
          ) : (
            <p className="muted">Desk doesn't show this kind of file. Save it to open it.</p>
          )}
        </div>
        <button type="button" className="file-viewer-step" aria-label="Next" disabled={files.length < 2} onClick={() => go(1)}>
          ›
        </button>
      </div>
      {files.length > 1 && (
        <div className="file-viewer-strip" role="group" aria-label="Files">
          {files.map((o, i) => (
            <StripItem key={o.id} ticket={t.id} file={o} current={i === at} onPick={() => onAt(i)} />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

function StripItem({ ticket, file: f, current, onPick }: { ticket: string; file: TicketFile; current: boolean; onPick: () => void }) {
  const kind = fileKind(f);
  const small = useFileUrl(ticket, kind === "image" ? f : null, true);
  return (
    <button type="button" aria-current={current || undefined} aria-label={f.name} title={f.name} className={`file-viewer-thumb file-viewer-thumb-${kind}`} onClick={onPick}>
      {kind === "image" && small.url ? <img src={small.url} alt="" draggable={false} /> : <span aria-hidden="true">{kind === "pdf" ? "PDF" : "FILE"}</span>}
    </button>
  );
}
