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

  it("asks to be allowed a file the system kept from Desk, and attaches it once it is", async () => {
    let allowed = false;
    invoke.mockImplementation(async (cmd: string, args: { paths?: string[]; path?: string }) => {
      if (cmd === "dropped_files") {
        if (!allowed) throw "Desk isn’t allowed to read shot.png. Allow it in Files and Folders.";
        return args.paths!.map((path) => ({ path, name: path.split("/").pop()!, size: 4, folder: false }));
      }
      if (cmd === "dropped_file_read") return new TextEncoder().encode("data").buffer;
      if (cmd === "privacy_open") return undefined;
    });
    const sent: File[][] = [];
    render(<Box sent={sent} />);
    const box = screen.getByTestId("box");
    const r = new DropRouter(() => zoneOf(box));
    act(() => r.handle({ type: "drop", paths: ["/Users/me/Desktop/shot.png"], position: { x: 1, y: 1 } }));
    expect(await screen.findByText("Allow Desk to read shot.png.")).toBeTruthy();
    expect(screen.queryByText(/os error|Operation not permitted/)).toBeNull();
    act(() => screen.getByRole("button", { name: "Open Files and Folders settings" }).click());
    expect(invoke).toHaveBeenCalledWith("privacy_open", { pane: "filesAndFolders" });
    // Allowed, and Desk back in front: read again without a new drop.
    allowed = true;
    // The composer asks again on each focus, once the note has shown and its
    // effect has attached the listener. That attaches after the note is on
    // screen, not with it, so a focus sent the instant the note appears can
    // go nowhere on a slow machine. Focus as Desk would, until it is read.
    await waitFor(() => {
      act(() => void window.dispatchEvent(new Event("focus")));
      expect(screen.getByText("shot.png")).toBeTruthy();
    });
    expect(screen.queryByText("Allow Desk to read shot.png.")).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("attaches what it could read of a drop at once, and the rest once allowed", async () => {
    let allowed = false;
    invoke.mockImplementation(async (cmd: string, args: { paths?: string[]; path?: string }) => {
      if (cmd === "dropped_files")
        return args.paths!.map((path) => {
          if (path.endsWith("b.png") && !allowed) throw "Desk isn’t allowed to read b.png. Allow it in Files and Folders.";
          return { path, name: path.split("/").pop()!, size: 4, folder: false };
        });
      if (cmd === "dropped_file_read") return new TextEncoder().encode("data").buffer;
    });
    const sent: File[][] = [];
    render(<Box sent={sent} />);
    const box = screen.getByTestId("box");
    const r = new DropRouter(() => zoneOf(box));
    act(() => r.handle({ type: "drop", paths: ["/Users/me/a.png", "/Users/me/Desktop/b.png"], position: { x: 1, y: 1 } }));
    expect(await screen.findByText("Allow Desk to read b.png.")).toBeTruthy();
    // a.png didn't wait for b.png.
    expect(sent.map((f) => f.map((x) => x.name))).toEqual([["a.png"]]);
    allowed = true;
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(sent.map((f) => f.map((x) => x.name))).toEqual([["a.png"], ["b.png"]]));
    // Only b.png was asked for again.
    const asked = invoke.mock.calls.filter(([c]) => c === "dropped_files").map(([, a]) => (a as { paths: string[] }).paths);
    expect(asked.at(-1)).toEqual(["/Users/me/Desktop/b.png"]);
    expect(screen.queryByText("Allow Desk to read b.png.")).toBeNull();
  });

  it("says to drop it again when a kept drop is too old to read, never sticking", async () => {
    let expired = false;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "dropped_files") {
        if (expired) throw "Desk only reads files dropped on it. Drop it again.";
        throw "Desk isn’t allowed to read c.png. Allow it in Files and Folders.";
      }
    });
    render(<Box sent={[]} />);
    const box = screen.getByTestId("box");
    const r = new DropRouter(() => zoneOf(box));
    act(() => r.handle({ type: "drop", paths: ["/Users/me/Desktop/c.png"], position: { x: 1, y: 1 } }));
    expect(await screen.findByText("Allow Desk to read c.png.")).toBeTruthy();
    // Still not allowed: it stays.
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(screen.getByText("Allow Desk to read c.png.")).toBeTruthy();
    expired = true;
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText("Desk only reads files dropped on it. Drop it again.")).toBeTruthy();
    expect(screen.queryByText("Allow Desk to read c.png.")).toBeNull();
  });
});
