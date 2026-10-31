import { RichBlock, RichHostProvider, type RichHost } from "@workforce/rich";
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat/store";
import type { Attachment, HubAccount } from "../chat/types";
import { fileUrl, openFile, openUrl, saveFileAs } from "../platform";
import { chartText } from "./chart";
import { saveMadeFile } from "./save";
import { CloseButton, useModal } from "../ui/Dialog";
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
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
};

/** The files of a message, as the design shows them: images inline (click
 *  to zoom), charts drawn from their spec, PDFs as a card with their first page, audio and video as a
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
    case "chart":
      return <ChartFile held={held} />;
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

/** Opening and saving a file, and what went wrong doing it, in plain words. */
function useFileActions({ hub, agent, file }: Held) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"open" | "save" | null>(null);
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
  return { busy, problem, run };
}

const Problem = ({ problem }: { problem: string | null }) =>
  problem && (
    <span className="small state-blocked att-problem" role="alert">
      {problem}
    </span>
  );

/** Open and Save as…, saying what went wrong in plain words. */
function FileActions({ held }: { held: Held }) {
  const { busy, problem, run } = useFileActions(held);
  if (!held.hub) return <span className="small faint">Its workspace isn’t connected to Desk any more.</span>;
  return (
    <span className="att-actions">
      <button type="button" className="btn att-btn" disabled={busy !== null} onClick={() => void run("open")}>
        {busy === "open" ? "Opening…" : "Open"}
      </button>
      <button type="button" className="btn att-btn" disabled={busy !== null} onClick={() => void run("save")}>
        {busy === "save" ? "Saving…" : "Save as…"}
      </button>
      <Problem problem={problem} />
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
  const { problem, run } = useFileActions(held);
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
          void run("save");
        }}
      >
        <img src={url} alt={filename} loading="lazy" style={width && height ? { aspectRatio: `${width} / ${height}` } : undefined} />
      </button>
      <figcaption className="small faint">{filename} · click to zoom · right-click to save</figcaption>
      <Problem problem={problem} />
      {zoomed && <Zoom held={held} url={url} onClose={() => setZoomed(false)} />}
    </figure>
  );
}

/** An image at full size over everything, to open or save. */
function Zoom({ held, url, onClose }: { held: Held; url: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useModal(ref, onClose);
  return (
    <div
      ref={ref}
      className="att-zoom"
      role="dialog"
      aria-modal="true"
      aria-label={held.file.filename}
      tabIndex={-1}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={onKeyDown}
    >
      <div className="att-zoom-bar">
        <Title held={held} />
        <FileActions held={held} />
        <CloseButton onClose={onClose} autoFocus />
      </div>
      <img className="att-zoom-image" src={url} alt={held.file.filename} onMouseDown={(e) => e.stopPropagation()} />
    </div>
  );
}

/** A chart an agent drew, drawn here from its spec: hover for values, the
 *  data as a table, copied or saved as a picture. Until the spec is read it
 *  is the chart's skeleton; a spec that is gone or isn't a chart is a card. */
function ChartFile({ held }: { held: Held }) {
  const [read, setRead] = useState<{ text: string } | "failed" | null>(null);
  const { hub, agent, file } = held;
  const host = useMemo<RichHost>(() => ({ openUrl, saveFile: saveMadeFile }), []);
  useEffect(() => {
    if (!hub) return;
    let live = true;
    setRead(null);
    chartText(hub, agent, file.artifact_id).then(
      (text) => live && setRead({ text }),
      () => live && setRead("failed"),
    );
    return () => {
      live = false;
    };
  }, [hub, agent, file.artifact_id]);
  const card = <FileCard held={held} />;
  if (!hub || read === "failed") return card;
  return (
    <RichHostProvider host={host}>
      <div className="att-chart rich">
        <RichBlock kind="chart" payload={read?.text ?? ""} streaming={read === null} fallback={card} />
      </div>
    </RichHostProvider>
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
