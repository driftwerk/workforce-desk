// A conversation's composer, in the app: files dropped from the system's
// own drag and drop are attached as before (read through Desk's native
// side), the overlay shows while they're over it, and a drop on a terminal
// beside it isn't taken.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropOverlay, PendingFiles, useFileDrop, usePendingFiles } from "../attachments/Compose";
import { DropRouter, registerZone, setNativeDrops, ZONE_ATTR } from "./route";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));

beforeEach(() => {
  setNativeDrops(true);
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: { paths?: string[]; path?: string }) => {
    if (cmd === "dropped_files")
      return args.paths!.map((path) => {
        const name = path.split("/").pop()!;
        return { path, name, size: name === "huge.mov" ? 500 * 1024 * 1024 : 4, folder: name === "Photos" };
      });
    if (cmd === "dropped_file_read") return new TextEncoder().encode("data").buffer;
  });
});
afterEach(() => {
  cleanup();
  setNativeDrops(false);
});

function Box({ sent }: { sent: File[][] }) {
  const files = usePendingFiles();
  const drop = useFileDrop((f) => {
    sent.push(f);
    files.add(f);
  }, files.setProblem);
  return (
    <div data-testid="box" {...drop.handlers}>
      <PendingFiles pending={files.pending} problem={files.problem} onRemove={files.remove} />
      {drop.dragging && <DropOverlay to="Allan" />}
    </div>
  );
}

const zoneOf = (el: HTMLElement) => el.closest(`[${ZONE_ATTR}]`)?.getAttribute(ZONE_ATTR) ?? null;

describe("a composer, with the system's drag and drop", () => {
  it("attaches the files dropped on it, with the overlay while they're over it", async () => {
    const sent: File[][] = [];
    render(<Box sent={sent} />);
    const box = screen.getByTestId("box");
    const r = new DropRouter(() => zoneOf(box));
    act(() => r.handle({ type: "enter", paths: ["/Users/me/notes.txt"], position: { x: 1, y: 1 } }));
    expect(screen.getByText("Drop to send to Allan")).toBeTruthy();
    act(() => r.handle({ type: "drop", paths: ["/Users/me/notes.txt", "/Users/me/shot.png"], position: { x: 1, y: 1 } }));
    expect(screen.queryByText("Drop to send to Allan")).toBeNull();
    await waitFor(() => expect(screen.getByText("shot.png")).toBeTruthy());
    expect(screen.getByText("notes.txt")).toBeTruthy();
    const [notes, shot] = sent[0]!;
    expect(await notes!.text()).toBe("data");
    expect(shot!.type).toBe("image/png");
    expect(invoke).toHaveBeenCalledWith("dropped_file_read", { path: "/Users/me/shot.png" });
  });

  it("says what it couldn't take, a folder or a file too big, reading neither", async () => {
    const sent: File[][] = [];
    render(<Box sent={sent} />);
    const box = screen.getByTestId("box");
    const r = new DropRouter(() => zoneOf(box));
    act(() => r.handle({ type: "drop", paths: ["/Users/me/Photos", "/Users/me/huge.mov", "/Users/me/ok.txt"], position: { x: 1, y: 1 } }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Photos is a folder.*huge\.mov is 500/));
    expect(screen.getByText("ok.txt")).toBeTruthy();
    expect(invoke.mock.calls.filter(([c]) => c === "dropped_file_read")).toEqual([["dropped_file_read", { path: "/Users/me/ok.txt" }]]);
  });

  it("reads no more files than a message carries", async () => {
    render(<Box sent={[]} />);
    const box = screen.getByTestId("box");
    const paths = Array.from({ length: 25 }, (_, i) => `/Users/me/f${i}.txt`);
    act(() => new DropRouter(() => zoneOf(box)).handle({ type: "drop", paths, position: { x: 1, y: 1 } }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("up to 20 files"));
    expect(invoke.mock.calls.filter(([c]) => c === "dropped_file_read")).toHaveLength(20);
  });

  it("takes nothing dropped on a terminal beside it", () => {
    const sent: File[][] = [];
    render(<Box sent={sent} />);
    const term = vi.fn();
    const off = registerZone("term", { label: "session", drop: term });
    const r = new DropRouter(() => "term");
    act(() => r.handle({ type: "drop", paths: ["/a.png"], position: { x: 1, y: 1 } }));
    expect(term).toHaveBeenCalledWith(["/a.png"]);
    expect(invoke).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    off();
  });
});
