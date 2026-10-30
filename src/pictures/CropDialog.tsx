import { useEffect, useMemo, useRef, useState } from "react";
import { CloseButton, Dialog } from "../ui/Dialog";
import { pictureRefusal } from "./everywhere";
import { drawn, fitFrame, MAX_ZOOM, OUTPUT, sourceSquare, type Frame, type Size } from "./crop";

/** The square the picture is framed in, in px. */
const VIEW = 280;
/** How far an arrow key moves it (with ⇧, four times as far). */
const STEP = 8;

/** The square of `img` the frame shows, saved at `OUTPUT` px: WebP where
 *  the webview writes it, else PNG. */
const encode = (img: HTMLImageElement, size: Size, frame: Frame): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return reject(new Error("Desk couldn’t draw the picture."));
    const { sx, sy, size: side } = sourceSquare(size, VIEW, frame);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, side, side, 0, 0, OUTPUT, OUTPUT);
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Desk couldn’t save the picture."))), "image/webp", 0.92);
  });

/** Frames a chosen picture in a square: drag it (or use the arrow keys) to
 *  move it, the slider (or + and −) to zoom. */
export function CropDialog({
  file,
  who,
  person,
  onUse,
  onClose,
}: {
  file: File;
  /** Whose picture it is, for the heading. */
  who: string;
  person: boolean;
  onUse: (image: Blob) => Promise<void>;
  onClose: () => void;
}) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const img = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [frame, setFrame] = useState<Frame>({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; from: Frame } | null>(null);

  const put = (next: Frame) => size && setFrame(fitFrame(size, VIEW, next));
  const shown = size ? drawn(size, VIEW, frame.zoom) : null;

  const use = async () => {
    if (!img.current || !size) return;
    setBusy(true);
    setProblem(null);
    try {
      await onUse(await encode(img.current, size, frame));
      onClose();
    } catch (e) {
      setProblem(pictureRefusal(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              Frame {who}’s picture
            </h1>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-body crop-body">
        <div
          className={`crop-view ${person ? "crop-round" : ""}`}
          style={{ width: VIEW, height: VIEW }}
          role="application"
          aria-label="Picture framing: arrow keys move it, plus and minus zoom"
          tabIndex={0}
          data-autofocus
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, from: frame };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) put({ ...d.from, x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y });
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) => put({ ...frame, zoom: frame.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08) })}
          onKeyDown={(e) => {
            const step = e.shiftKey ? STEP * 4 : STEP;
            const moves: Record<string, Partial<Frame>> = {
              ArrowLeft: { x: frame.x - step },
              ArrowRight: { x: frame.x + step },
              ArrowUp: { y: frame.y - step },
              ArrowDown: { y: frame.y + step },
              "+": { zoom: frame.zoom * 1.1 },
              "=": { zoom: frame.zoom * 1.1 },
              "-": { zoom: frame.zoom / 1.1 },
            };
            const move = moves[e.key];
            if (!move) return;
            e.preventDefault();
            put({ ...frame, ...move });
          }}
        >
          <img
            ref={img}
            src={url}
            alt=""
            draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setProblem("Desk couldn’t open that picture.")}
            style={
              shown
                ? { width: shown.w, height: shown.h, left: (VIEW - shown.w) / 2 + frame.x, top: (VIEW - shown.h) / 2 + frame.y }
                : { visibility: "hidden" }
            }
          />
        </div>
        <label className="crop-zoom">
          <span className="small muted">Zoom</span>
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={frame.zoom}
            disabled={!size}
            onChange={(e) => put({ ...frame, zoom: Number(e.target.value) })}
          />
        </label>
      </div>
      <footer className="dialog-foot">
        <span className="dialog-foot-note state-blocked">{problem}</span>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-signal" disabled={busy || !size} onClick={() => void use()}>
          {busy ? "Saving…" : "Use picture"}
        </button>
      </footer>
    </Dialog>
  );
}
