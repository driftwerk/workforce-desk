// Framing a picture in a square: the image is drawn covering the square at
// `zoom` (1: it just covers it), moved by `x`, `y` (its centre from the
// square's, in the square's pixels), never so far that the square shows
// past its edge.

export interface Size {
  w: number;
  h: number;
}

export interface Frame {
  zoom: number;
  x: number;
  y: number;
}

export const MAX_ZOOM = 4;
/** The side of the square a picture is saved at, in pixels. */
export const OUTPUT = 512;
/** The largest file Desk opens to frame. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The image as drawn in a square of `view` px: its size and its scale. */
export const drawn = (image: Size, view: number, zoom: number): Size & { scale: number } => {
  const scale = (view / Math.min(image.w, image.h)) * zoom;
  return { w: image.w * scale, h: image.h * scale, scale };
};

/** `frame` kept to what covers the square. */
export const fitFrame = (image: Size, view: number, frame: Frame): Frame => {
  const zoom = clamp(frame.zoom, 1, MAX_ZOOM);
  const d = drawn(image, view, zoom);
  const mx = (d.w - view) / 2;
  const my = (d.h - view) / 2;
  return { zoom, x: clamp(frame.x, -mx, mx), y: clamp(frame.y, -my, my) };
};

/** The square of the image the frame shows, in the image's own pixels. */
export const sourceSquare = (image: Size, view: number, frame: Frame): { sx: number; sy: number; size: number } => {
  const f = fitFrame(image, view, frame);
  const d = drawn(image, view, f.zoom);
  return { sx: ((d.w - view) / 2 - f.x) / d.scale, sy: ((d.h - view) / 2 - f.y) / d.scale, size: view / d.scale };
};

/** What the first bytes of a file say it is, of the pictures Desk takes. */
export const pictureType = (head: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null => {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => head[i + j] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
};
