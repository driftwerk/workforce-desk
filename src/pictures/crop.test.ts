import { describe, expect, it } from "vitest";
import { fitFrame, MAX_ZOOM, pictureType, sourceSquare } from "./crop";

describe("framing a picture", () => {
  const wide = { w: 800, h: 400 };

  it("covers the square: a wide picture shows its middle square at first", () => {
    expect(sourceSquare(wide, 200, { zoom: 1, x: 0, y: 0 })).toEqual({ sx: 200, sy: 0, size: 400 });
  });

  it("moves no further than its edges, and zooms between covering and four times that", () => {
    expect(fitFrame(wide, 200, { zoom: 1, x: 500, y: 30 })).toEqual({ zoom: 1, x: 100, y: 0 });
    expect(sourceSquare(wide, 200, { zoom: 1, x: 500, y: 0 })).toEqual({ sx: 0, sy: 0, size: 400 });
    expect(fitFrame(wide, 200, { zoom: 9, x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
    expect(fitFrame(wide, 200, { zoom: 0.2, x: 0, y: 0 }).zoom).toBe(1);
  });

  it("zoomed in, shows a smaller square around where it's moved to", () => {
    expect(sourceSquare(wide, 200, { zoom: 2, x: -50, y: 50 })).toEqual({ sx: 350, sy: 50, size: 200 });
  });
});

describe("what a file is", () => {
  it("knows PNG, JPEG and WebP by their first bytes, and nothing else", () => {
    expect(pictureType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(pictureType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(pictureType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(pictureType(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(pictureType(new TextEncoder().encode("<svg"))).toBeNull();
  });
});
