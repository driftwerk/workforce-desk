import { useEffect, useRef, useState } from "react";
import { CloseButton, Dialog } from "../ui/Dialog";
import { pictureRefusal } from "./everywhere";
import { drawn, fitFrame, MAX_ZOOM, OUTPUT, sourceSquare, zoomFrame, type Frame, type Size } from "./crop";

/** The square the picture is framed in, in px. */
const VIEW = 280;
/** How far an arrow key moves it (with Shift, four times as far). */
const STEP = 8;
/** How much a key press zooms. */
const ZOOM_STEP = 1.1;
/** How much a pixel of scrolling zooms, as an exponent. */
const WHEEL_ZOOM = 0.002;

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
 *  move it, the slider (or + and −, or scrolling) to zoom, Enter to use it.
 *  It can't be closed while it saves. */
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
  /** Your own picture, framed round. */
  person: boolean;
  onUse: (image: Blob) => Promise<void>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file]);
  const img = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [frame, setFrame] = useState<Frame>({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; from: Frame } | null>(null);

  const put = (next: Frame) => size && setFrame(fitFrame(size, VIEW, next));
  const zoomTo = (zoom: number) => size && setFrame(zoomFrame(size, VIEW, frame, zoom));
  const close = () => !busy && onClose();
  const shown = size ? drawn(size, VIEW, frame.zoom) : null;

  const use = async () => {
    if (!img.current || !size || busy) return;
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
      onClose={close}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {person ? "Frame your picture" : `Frame ${who}’s picture`}
            </h1>
          </span>
          <CloseButton onClose={close} />
        </header>
      )}
    >
      <div className="dialog-body crop-body">
        <div
          className={`crop-view ${person ? "crop-round" : ""}`}
          style={{ width: VIEW, height: VIEW }}
          role="group"
          aria-roledescription="crop area"
          aria-label="Picture framing: arrow keys move it, plus and minus zoom, Enter uses it"
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
          onWheel={(e) => e.deltaY !== 0 && zoomTo(frame.zoom * Math.exp(-e.deltaY * WHEEL_ZOOM))}
          onKeyDown={(e) => {
            const step = e.shiftKey ? STEP * 4 : STEP;
            const keys: Record<string, () => void> = {
              ArrowLeft: () => put({ ...frame, x: frame.x - step }),
              ArrowRight: () => put({ ...frame, x: frame.x + step }),
              ArrowUp: () => put({ ...frame, y: frame.y - step }),
              ArrowDown: () => put({ ...frame, y: frame.y + step }),
              "+": () => zoomTo(frame.zoom * ZOOM_STEP),
              "=": () => zoomTo(frame.zoom * ZOOM_STEP),
              "-": () => zoomTo(frame.zoom / ZOOM_STEP),
              Enter: () => void use(),
            };
            const run = keys[e.key];
            if (!run) return;
            e.preventDefault();
            run();
          }}
        >
          <img
            ref={img}
            src={url ?? undefined}
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
            aria-valuetext={`${frame.zoom.toFixed(1)}×`}
            disabled={!size}
            onChange={(e) => zoomTo(Number(e.target.value))}
          />
        </label>
      </div>
      <footer className="dialog-foot">
        <span className="dialog-foot-note state-blocked">{problem}</span>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-signal" disabled={busy || !size} onClick={() => void use()}>
          {busy ? "Saving…" : "Use picture"}
        </button>
      </footer>
    </Dialog>
  );
}
