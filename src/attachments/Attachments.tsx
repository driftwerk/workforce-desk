import { useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import type { Attachment, HubAccount } from "../chat/types";
import { fileUrl, openFile, saveFileAs } from "../platform";
import { CloseButton } from "../ui/Dialog";
import { describe, kindOf, type Kind } from "./kinds";

/** Where a message's files are, unless a file says otherwise: the hub and
 *  agent of the conversation it is in. */
export interface FileHome {
  hub: string;
  agent: string;
}

/** A file, and the hub account and agent that hold it. */
interface Held {
  file: Attachment;
  kind: Kind;
  hub: HubAccount | undefined;
  agent: string;
}

/** The artifact a `thumbnail_url` (`/api/agents/{agent}/attachments/{id}`)
 *  names, in the same store as its file. */
export const thumbnailOf = (url: string | null | undefined): string | null => {
  const m = url ? /\/api\/agents\/[^/]+\/attachments\/([^/?#]+)/.exec(url) : null;
  return m ? decodeURIComponent(m[1]!) : null;
};

/** The files of a message, as the design shows them: images inline (click
 *  to zoom), PDFs as a card with their first page, audio and video as a
 *  player, anything else as a card to open or save. */
export function Attachments({ files, home }: { files: readonly Attachment[]; home?: FileHome }) {
  const hubs = useChat((s) => s.hubs);
  if (!files.length) return null;
  return (
    <div className="atts">
      {files.map((file) => {
        const hubId = file.hub ?? home?.hub;
        const held: Held = {
          file,
          kind: kindOf(file.media_type, file.filename),
          hub: hubs.find((h) => h.id === hubId),
          agent: file.agent ?? home?.agent ?? "",
        };
        return <AttachmentView key={file.artifact_id} held={held} />;
      })}
    </div>
  );
}

function AttachmentView({ held }: { held: Held }) {
  switch (held.kind.shown) {
    case "image":
      return <ImageFile held={held} />;
    case "pdf":
      return <PdfCard held={held} />;
    case "video":
    case "audio":
      return <MediaFile held={held} />;
    case "file":
      return <FileCard held={held} />;
  }
}

const src = (h: Held, artifact = h.file.artifact_id): string | undefined => h.hub && fileUrl(h.hub, h.agent, artifact);

/** Open and Save as…, saying what went wrong in plain words. */
function FileActions({ held }: { held: Held }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"open" | "save" | null>(null);
  const { hub, agent, file } = held;
  const run = async (what: "open" | "save") => {
    if (!hub) return;
    setBusy(what);
    setProblem(null);
    try {
      if (what === "open") await openFile(hub, agent, file.artifact_id, file.filename);
      else await saveFileAs(hub, agent, file.artifact_id, file.filename);
    } catch (e) {
      setProblem(`Couldn’t ${what === "open" ? "open" : "save"} ${file.filename}: ${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(null);
  };
  if (!hub) return <span className="small faint">Its workspace isn’t connected to Desk any more.</span>;
  return (
    <span className="att-actions">
      <button type="button" className="btn att-btn" disabled={busy !== null} onClick={() => void run("open")}>
        {busy === "open" ? "Opening…" : "Open"}
      </button>
      <button type="button" className="btn att-btn" disabled={busy !== null} onClick={() => void run("save")}>
        {busy === "save" ? "Saving…" : "Save as…"}
      </button>
      {problem && (
        <span className="small state-blocked att-problem" role="alert">
          {problem}
        </span>
      )}
    </span>
  );
}

function Title({ held }: { held: Held }) {
  return (
    <span className="att-title">
      <span className="att-name" title={held.file.filename}>
        {held.file.filename}
      </span>
      <span className="small muted">{describe(held.kind, held.file.size, held.file.duration)}</span>
    </span>
  );
}

function ImageFile({ held }: { held: Held }) {
  const [zoomed, setZoomed] = useState(false);
  const url = src(held);
  const { width, height, filename } = held.file;
  if (!url) return <FileCard held={held} />;
  return (
    <figure className="att-figure">
      <button
        type="button"
        className="att-image"
        aria-label={`Zoom ${filename}`}
        onClick={() => setZoomed(true)}
        onContextMenu={(e) => {
          e.preventDefault();
          void saveFileAs(held.hub!, held.agent, held.file.artifact_id, filename);
        }}
      >
        <img src={url} alt={filename} loading="lazy" style={width && height ? { aspectRatio: `${width} / ${height}` } : undefined} />
      </button>
      <figcaption className="small faint">{filename} · click to zoom · right-click to save</figcaption>
      {zoomed && <Zoom held={held} url={url} onClose={() => setZoomed(false)} />}
    </figure>
  );
}

/** An image at full size over everything, to open or save. */
function Zoom({ held, url, onClose }: { held: Held; url: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>(".att-zoom-close button")?.focus();
    return () => before?.focus();
  }, []);
  return (
    <div
      ref={ref}
      className="att-zoom"
      role="dialog"
      aria-modal="true"
      aria-label={held.file.filename}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="att-zoom-bar">
        <Title held={held} />
        <FileActions held={held} />
        <span className="att-zoom-close">
          <CloseButton onClose={onClose} />
        </span>
      </div>
      <img className="att-zoom-image" src={url} alt={held.file.filename} onMouseDown={(e) => e.stopPropagation()} />
    </div>
  );
}

/** A PDF's first page, or a page of lines while there is none. */
function PdfCard({ held }: { held: Held }) {
  const thumb = thumbnailOf(held.file.thumbnail_url);
  const url = thumb ? src(held, thumb) : undefined;
  return (
    <div className="att att-pdf">
      <div className="att-page" aria-hidden="true">
        {url ? (
          <img src={url} alt="" />
        ) : (
          <>
            <i className="att-line att-line-head" />
            <i className="att-line" />
            <i className="att-line att-line-short" />
            <i className="att-line att-line-figure" />
            <i className="att-line" />
            <i className="att-line att-line-short" />
          </>
        )}
      </div>
      <div className="att-pdf-body">
        <Title held={held} />
        <FileActions held={held} />
      </div>
    </div>
  );
}

function MediaFile({ held }: { held: Held }) {
  const url = src(held);
  const video = held.kind.shown === "video";
  return (
    <div className="att">
      {url &&
        (video ? (
          <video className="att-video" controls preload="metadata" src={url} aria-label={held.file.filename} />
        ) : (
          <audio className="att-audio" controls preload="metadata" src={url} aria-label={held.file.filename} />
        ))}
      <div className="att-head">
        <Title held={held} />
        <FileActions held={held} />
      </div>
    </div>
  );
}

function FileCard({ held }: { held: Held }) {
  return (
    <div className="att">
      <div className="att-head">
        <span className={`att-badge att-badge-${held.kind.family}`} aria-hidden="true">
          {held.kind.badge}
        </span>
        <Title held={held} />
        <FileActions held={held} />
      </div>
    </div>
  );
}
