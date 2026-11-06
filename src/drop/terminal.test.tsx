import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMachines } from "../hub/engines";
import { useDesk } from "../hub/store";
import { machine, noEngines, withEngine } from "../machines/testing";
import { Terminal } from "../session/Terminal";
import { DropRouter, ZONE_ATTR } from "./route";
import { clipboardImage, copyingText, giveDropped, givePasted, type DropNote } from "./terminal";

const terms: { pasted: string[]; field?: HTMLTextAreaElement }[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    field?: HTMLTextAreaElement;
    pasted: string[] = [];
    buffer = { active: { type: "normal" } };
    private data?: (d: string) => void;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terms.push(this);
    }
    loadAddon() {}
    open(el: HTMLElement) {
      this.field = el.appendChild(document.createElement("textarea"));
      // As xterm: a paste on its field is typed in.
      this.field.addEventListener("paste", (e) => this.paste((e as unknown as { clipboardData: DataTransfer }).clipboardData.getData("text/plain")));
    }
    paste(text: string) {
      this.pasted.push(text);
      this.data?.(text);
    }
    write() {}
    focus() {}
    resize() {}
    dispose() {}
    onData(f: (d: string) => void) {
      this.data = f;
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
  },
}));
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { proposeDimensions = () => ({ cols: 80, rows: 24 }); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

type Sent = { send: ReturnType<typeof vi.fn> };
const socket = (): Sent & { readyState: number; close: () => void; onopen?: () => void } => ({ readyState: 1, send: vi.fn(), close: vi.fn() });

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  invoke.mockReset();
  terms.length = 0;
  noEngines();
  useMachines.setState({ machines: [machine({ id: "devbox", name: "devbox" })], listed: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The pane's frame, and a router dropping on whatever zone is at the
 *  point named `where`. */
const frame = () => document.querySelector<HTMLElement>(".terminal-frame")!;
const router = (where: Record<string, HTMLElement | null>) =>
  new DropRouter((p) => where[`${p.x},${p.y}`]?.closest(`[${ZONE_ATTR}]`)?.getAttribute(ZONE_ATTR) ?? null);
const decoded = (s: Sent) => s.send.mock.calls.map(([d]) => (ArrayBuffer.isView(d) ? new TextDecoder().decode(d) : null)).filter(Boolean);

describe("files dropped on a session's terminal", () => {
  it("on this computer: their paths are typed in, escaped, and nothing presses Enter", async () => {
    const s = socket();
    useDesk.setState({ hub: { ptySocket: () => s } as never });
    invoke.mockImplementation(async (cmd: string, args: { paths: string[] }) => (cmd === "terminal_drop" ? args.paths : undefined));
    render(<Terminal sessionId="s1" />);
    const r = router({ "5,5": frame() });
    act(() => r.handle({ type: "enter", paths: ["/Users/me/a b.png"], position: { x: 5, y: 5 } }));
    expect(frame().classList.contains("drop-over")).toBe(true);
    act(() => r.handle({ type: "drop", paths: ["/Users/me/a b.png", "/Users/me/café's.pdf"], position: { x: 5, y: 5 } }));
    expect(frame().classList.contains("drop-over")).toBe(false);
    await waitFor(() => expect(terms[0]!.pasted).toEqual(["/Users/me/a\\ b.png /Users/me/café\\'s.pdf"]));
    expect(invoke).toHaveBeenCalledWith("terminal_drop", expect.objectContaining({ machine: null, scope: "s1", paths: ["/Users/me/a b.png", "/Users/me/café's.pdf"] }));
    expect(decoded(s)).toEqual(["/Users/me/a\\ b.png /Users/me/café\\'s.pdf"]);
    // No note for a drop on this computer.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("on a machine: copied there first, saying so, then the copies' paths are typed in", async () => {
    const s = socket();
    withEngine("devbox", { ptySocket: () => s } as never);
    let done!: (v: string[]) => void;
    invoke.mockImplementation((cmd: string, args: { progress: { onmessage: (p: unknown) => void } }) => {
      if (cmd !== "terminal_drop") return Promise.resolve();
      args.progress.onmessage({ sent: 512 * 1024, total: 1024 * 1024 });
      return new Promise((res) => (done = res));
    });
    render(<Terminal sessionId="s9" machine="devbox" />);
    const r = router({ "5,5": frame() });
    act(() => r.handle({ type: "drop", paths: ["/Users/me/shot.png"], position: { x: 5, y: 5 } }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Copying the file to devbox… · 512/);
    expect(invoke).toHaveBeenCalledWith("terminal_drop", expect.objectContaining({ machine: "devbox", scope: "s9" }));
    expect(terms[0]!.pasted).toEqual([]);
    await act(async () => done(["/home/dev/.local/share/Desk/uploads/s9/1-0/shot.png"]));
    expect(terms[0]!.pasted).toEqual(["/home/dev/.local/share/Desk/uploads/s9/1-0/shot.png"]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("on a machine that can't take them: says why in place, and types nothing", async () => {
    withEngine("devbox", { ptySocket: () => socket() } as never);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "terminal_drop") throw "That's 2048 MB; Desk copies up to 1024 MB at a time to a machine.";
    });
    render(<Terminal sessionId="s9" machine="devbox" />);
    act(() => router({ "5,5": frame() }).handle({ type: "drop", paths: ["/big.iso"], position: { x: 5, y: 5 } }));
    expect((await screen.findByRole("alert")).textContent).toContain("Desk copies up to 1024 MB");
    expect(terms[0]!.pasted).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dropped beside it (the sidebar, a page with no terminal) gives it nothing", () => {
    useDesk.setState({ hub: { ptySocket: () => socket() } as never });
    render(
      <>
        <nav data-testid="sidebar">Ada</nav>
        <Terminal sessionId="s1" />
      </>,
    );
    const r = router({ "1,1": screen.getByTestId("sidebar"), "5,5": frame() });
    act(() => r.handle({ type: "enter", paths: ["/a.png"], position: { x: 1, y: 1 } }));
    expect(frame().classList.contains("drop-over")).toBe(false);
    act(() => r.handle({ type: "drop", paths: ["/a.png"], position: { x: 1, y: 1 } }));
    expect(invoke).not.toHaveBeenCalledWith("terminal_drop", expect.anything());
    expect(terms[0]!.pasted).toEqual([]);
  });
});

describe("an image pasted into a terminal", () => {
  const pasteEvent = (data: Partial<DataTransfer>) => {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: data });
    return e;
  };
  const imageData = (file: File): Partial<DataTransfer> => ({
    types: ["Files"],
    items: [{ kind: "file", type: file.type, getAsFile: () => file }] as unknown as DataTransferItemList,
    files: [file] as unknown as FileList,
    getData: () => "",
  });

  it("is saved, and its path typed in instead", async () => {
    useDesk.setState({ hub: { ptySocket: () => socket() } as never });
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "terminal_paste_image" ? "/Users/me/Library/Application Support/Desk/pastes/s1/pasted-1.png" : undefined,
    );
    render(<Terminal sessionId="s1" />);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });
    act(() => void terms[0]!.field!.dispatchEvent(pasteEvent(imageData(png))));
    await waitFor(() => expect(terms[0]!.pasted).toEqual(["/Users/me/Library/Application\\ Support/Desk/pastes/s1/pasted-1.png"]));
    const [cmd, body, opts] = invoke.mock.calls.find(([c]) => c === "terminal_paste_image")!;
    expect(cmd).toBe("terminal_paste_image");
    expect(Array.from(body as Uint8Array)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(opts).toEqual({ headers: { "x-desk-scope": "s1", "x-desk-type": "image%2Fpng" } });
  });

  it("on a machine, goes there", async () => {
    withEngine("devbox", { ptySocket: () => socket() } as never);
    invoke.mockImplementation(async (cmd: string) => (cmd === "terminal_paste_image" ? "/home/dev/.local/share/Desk/uploads/s9/1-0/pasted-1.png" : undefined));
    render(<Terminal sessionId="s9" machine="devbox" />);
    const png = new File(["x"], "image.png", { type: "image/png" });
    act(() => void terms[0]!.field!.dispatchEvent(pasteEvent(imageData(png))));
    await waitFor(() => expect(terms[0]!.pasted).toEqual(["/home/dev/.local/share/Desk/uploads/s9/1-0/pasted-1.png"]));
    const opts = invoke.mock.calls.find(([c]) => c === "terminal_paste_image")![2] as { headers: Record<string, string> };
    expect(opts.headers["x-desk-machine"]).toBe("devbox");
  });

  it("leaves a paste of text as xterm's own", () => {
    useDesk.setState({ hub: { ptySocket: () => socket() } as never });
    render(<Terminal sessionId="s1" />);
    act(() => void terms[0]!.field!.dispatchEvent(pasteEvent({ types: ["text/plain", "Files"], items: [] as never, files: [] as never, getData: () => "echo hi" })));
    expect(terms[0]!.pasted).toEqual(["echo hi"]);
    expect(invoke).not.toHaveBeenCalledWith("terminal_paste_image", expect.anything(), expect.anything());
  });
});

describe("a drop's steps", () => {
  const target = () => {
    const notes: (DropNote | null)[] = [];
    const written: string[] = [];
    return { notes, written, t: { machine: "devbox", machineName: "devbox", scope: "s", write: (x: string) => written.push(x), note: (n: DropNote | null) => notes.push(n) } };
  };

  it("say how far a copy to a machine has got", () => {
    expect(copyingText("devbox", 1)).toBe("Copying the file to devbox…");
    expect(copyingText("devbox", 3, { sent: 0, total: 3 * 1024 * 1024 })).toMatch(/^Copying 3 files to devbox… · 0 B? of 3/);
  });

  it("type nothing for a path a terminal couldn't take safely", async () => {
    const { t, notes, written } = target();
    await giveDropped(t, ["/x"], async () => ["/home/dev/a\nrm -rf ~"]);
    expect(written).toEqual([]);
    expect(notes.at(-1)).toEqual({ kind: "error", text: expect.stringMatching(/control character/) });
  });

  it("say why a pasted image couldn't be saved", async () => {
    const { t, notes, written } = target();
    await givePasted(t, new Blob(["x"], { type: "image/png" }), async () => {
      throw new Error("devbox turned your SSH key away, or it needs unlocking first (ssh-add).");
    });
    expect(written).toEqual([]);
    expect(notes[0]).toEqual({ kind: "copying", text: "Copying the image to devbox…" });
    expect(notes.at(-1)).toEqual({ kind: "error", text: expect.stringContaining("ssh-add") });
  });

  it("find no image on a clipboard of text and one, or of nothing", () => {
    expect(clipboardImage(null)).toBeNull();
    expect(clipboardImage({ types: ["text/plain"], items: [] } as never)).toBeNull();
    const f = new File(["x"], "a.png", { type: "image/png" });
    expect(clipboardImage({ types: ["Files", "text/html"], items: [{ kind: "file", type: "image/png", getAsFile: () => f }] } as never)).toBe(f);
    expect(clipboardImage({ types: ["Files"], items: [], files: [new File(["x"], "a.txt", { type: "text/plain" })] } as never)).toBeNull();
  });
});
