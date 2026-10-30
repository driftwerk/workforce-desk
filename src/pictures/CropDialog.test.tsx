import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CropDialog } from "./CropDialog";

const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "me.png", { type: "image/png" });

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:crop-${++n}`);
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => {} } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) => done(new Blob(["x"], { type: "image/webp" })));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The dialog with its picture loaded, 800 by 400. */
const shown = (props: Partial<Parameters<typeof CropDialog>[0]> = {}) => {
  const onUse = vi.fn(() => Promise.resolve());
  const onClose = vi.fn();
  render(
    <StrictMode>
      <CropDialog file={file} who="Allan" person={false} onUse={onUse} onClose={onClose} {...props} />
    </StrictMode>,
  );
  const img = screen.getByRole("dialog").querySelector("img")!;
  Object.defineProperties(img, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
  fireEvent.load(img);
  return { img, onUse, onClose, area: screen.getByRole("group", { name: /Picture framing/ }), zoom: screen.getByRole("slider") as HTMLInputElement };
};

describe("framing a picture", () => {
  it("shows the picture from a URL it keeps while it's open, and lets go of it after", () => {
    const { img } = shown();
    expect(img.getAttribute("src")).toMatch(/^blob:crop-/);
    expect(vi.mocked(URL.revokeObjectURL).mock.calls.map(([u]) => u)).not.toContain(img.getAttribute("src"));
    const src = img.getAttribute("src");
    cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(src);
  });

  it("zooms on a vertical scroll only, a little for a little", () => {
    const { area, zoom } = shown();
    fireEvent.wheel(area, { deltaX: 40, deltaY: 0 });
    expect(zoom.value).toBe("1");
    fireEvent.wheel(area, { deltaY: -10 });
    expect(Number(zoom.value)).toBeCloseTo(Math.exp(0.02));
    expect(zoom.getAttribute("aria-valuetext")).toBe("1.0×");
  });

  it("uses the picture on Enter, and can't be closed while it saves", async () => {
    let saved = () => {};
    const onUse = vi.fn(() => new Promise<void>((done) => (saved = done)));
    const { area, onClose } = shown({ onUse });
    await act(async () => fireEvent.keyDown(area, { key: "Enter" }));
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(area, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => saved());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is headed for whose picture it is", () => {
    shown({ person: true });
    expect(screen.getByRole("heading", { name: "Frame your picture" })).toBeTruthy();
  });
});
