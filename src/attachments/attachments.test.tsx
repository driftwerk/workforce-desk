import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../chat/types";

const opened = vi.hoisted(() => [] as unknown[][]);
const saved = vi.hoisted(() => [] as unknown[][]);
const uploads = vi.hoisted(() => ({ fail: null as Error | null, sent: [] as string[] }));
const saveFails = vi.hoisted(() => ({ error: null as Error | null }));
const charts = vi.hoisted(() => ({ asked: [] as string[], answer: (_url: string): Response => new Response("{}") }));
vi.mock("../hub/net", () => ({
  pairedHub: (hub: { id: string }) => ({
    fetch: async (method: string, path: string, body?: unknown) => {
      charts.asked.push(`${method} ${hub.id} ${path}${body === undefined ? "" : " with a body"}`);
      return charts.answer(path);
    },
  }),
}));
vi.mock("../platform", () => ({
  openUrl: () => {},
  fileUrl: (hub: { id: string }, agent: string, artifact: string) => `deskfile://localhost/${hub.id}/${agent}/${artifact}`,
  openFile: async (...args: unknown[]) => void opened.push(args),
  saveFileAs: async (...args: unknown[]) => {
    if (saveFails.error) throw saveFails.error;
    saved.push(args);
    return true;
  },
  uploadFile: async (_hub: unknown, _agent: string, _channel: string, file: File): Promise<Attachment> => {
    if (uploads.fail) throw uploads.fail;
    uploads.sent.push(file.name);
    return { artifact_id: `art_${file.name}`, media_type: file.type, filename: file.name, size: file.size };
  },
}));

const { useChat } = await import("../chat/store");
const { Attachments, thumbnailOf } = await import("./Attachments");
const { adding, AttachButton, DropOverlay, PendingFiles, useFileDrop, usePendingFiles } = await import("./Compose");
const { describe: describeKind, formatDuration, formatSize, kindOf } = await import("./kinds");
const { MAX_FILE_BYTES, MAX_FILES, tooBig, uploadAll, uploadError } = await import("./upload");

const hub = { id: "dw", label: "Driftwerk", url: "https://dw.example.com", local: false, revision: "t" };
const file = (filename: string, media_type: string, more: Partial<Attachment> = {}): Attachment => ({
  artifact_id: `art_${filename}`,
  media_type,
  filename,
  size: 412 * 1024,
  ...more,
});

beforeEach(() => {
  opened.length = 0;
  saved.length = 0;
  uploads.fail = null;
  saveFails.error = null;
  uploads.sent.length = 0;
  useChat.setState({ hubs: [hub] });
});
afterEach(cleanup);

describe("what a file is", () => {
  it("is shown as an image, a PDF, a player or a card, and called what you'd call it", () => {
    expect(kindOf("image/png", "burndown.png").shown).toBe("image");
    expect(kindOf("application/pdf", "report.pdf")).toMatchObject({ shown: "pdf", label: "PDF" });
    expect(kindOf("video/mp4", "demo.mp4").shown).toBe("video");
    expect(kindOf("audio/mpeg", "memo.mp3").shown).toBe("audio");
    expect(kindOf("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "ticket-numbers.xlsx")).toMatchObject({
      shown: "file",
      label: "Spreadsheet",
      badge: "XLSX",
      family: "sheet",
    });
    expect(kindOf("application/octet-stream", "blob")).toMatchObject({ label: "File", badge: "OCTE" });
    expect(kindOf("application/vnd.workforce.chart+json", "signups.json")).toMatchObject({ shown: "chart", label: "Chart" });
  });

  it("says its size and length in plain figures", () => {
    expect([formatSize(900), formatSize(412 * 1024), formatSize(9.2 * 1024 * 1024)]).toEqual(["900 B", "412 KB", "9.2 MB"]);
    expect([formatDuration(48), formatDuration(3723)]).toEqual(["0:48", "1:02:03"]);
    expect(describeKind(kindOf("video/mp4", "demo.mp4"), 9.2 * 1024 * 1024, 48)).toBe("Video · 0:48 · 9.2 MB");
  });

  it("names the thumbnail its PDF's first page is", () => {
    expect(thumbnailOf("/api/agents/scout/attachments/art_thumb")).toBe("art_thumb");
    expect(thumbnailOf(null)).toBeNull();
    expect(thumbnailOf("/api/agents/scout/attachments/art%E0%A4%A")).toBeNull();
  });
});

describe("a chart an agent drew", () => {
  const CHART = "application/vnd.workforce.chart+json";
  const spec = { kind: "bar", title: "Signups by plan", labels: ["Free", "Pro"], series: [{ data: [420, 180] }] };
  beforeEach(() => {
    charts.asked.length = 0;
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    Object.defineProperty(window, "ResizeObserver", { writable: true, value: class { observe() {} disconnect() {} } });
  });

  it("is drawn from its spec, read from its hub by id", async () => {
    charts.answer = () => new Response(JSON.stringify(spec));
    const { container } = render(<Attachments files={[file("signups.json", CHART, { artifact_id: "art_c1" })]} home={{ hub: "dw", agent: "allan" }} />);
    // The chart's renderer is a lazy chunk, slow to load the first time.
    await vi.waitFor(() => expect(container.querySelector(".wf-chart")).not.toBeNull(), { timeout: 15000 });
    expect(charts.asked).toEqual(["GET dw /api/agents/allan/attachments/art_c1"]);
    expect(container.querySelector(".wf-chart-plot")!.getAttribute("aria-label")).toBe("bar chart: Signups by plan");
    expect(screen.getByRole("button", { name: "Show data" })).toBeTruthy();
  }, 20000);

  it("is a card when its spec is gone or is not a chart", async () => {
    charts.answer = (url) => (url.endsWith("art_gone") ? new Response("", { status: 404 }) : new Response('{"kind":"donut"}'));
    const { container } = render(
      <Attachments
        files={[file("gone.json", CHART, { artifact_id: "art_gone" }), file("odd.json", CHART, { artifact_id: "art_odd" })]}
        home={{ hub: "dw", agent: "allan" }}
      />,
    );
    await vi.waitFor(() => expect(container.querySelectorAll(".att-badge")).toHaveLength(2));
    expect(container.querySelector(".wf-chart")).toBeNull();
    expect(screen.getByText("gone.json")).toBeTruthy();
  });
});

describe("a message's files", () => {
  it("shows an image inline that zooms when clicked, and saves on a right-click", () => {
    render(<Attachments files={[file("burndown.png", "image/png", { width: 640, height: 320 })]} home={{ hub: "dw", agent: "allan" }} />);
    const img = screen.getByAltText("burndown.png") as HTMLImageElement;
    expect(img.src).toBe("deskfile://localhost/dw/allan/art_burndown.png");
    fireEvent.click(screen.getByRole("button", { name: "Zoom burndown.png" }));
    expect(screen.getByRole("dialog", { name: "burndown.png" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Zoom burndown.png" }));
    expect(saved).toEqual([[hub, "allan", "art_burndown.png", "burndown.png"]]);
  });

  it("keeps focus in the zoomed image until it closes, then gives it back", () => {
    render(<Attachments files={[file("burndown.png", "image/png")]} home={{ hub: "dw", agent: "allan" }} />);
    const opener = screen.getByRole("button", { name: "Zoom burndown.png" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    const buttons = [...dialog.querySelectorAll("button")];
    buttons.at(-1)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(buttons.at(-1));
    fireEvent.click(close);
    expect(document.activeElement).toBe(opener);
  });

  it("says when saving from a right-click went wrong", async () => {
    saveFails.error = new Error("the disk is full");
    render(<Attachments files={[file("burndown.png", "image/png")]} home={{ hub: "dw", agent: "allan" }} />);
    await act(async () => fireEvent.contextMenu(screen.getByRole("button", { name: "Zoom burndown.png" })));
    expect(screen.getByRole("alert").textContent).toBe("Couldn’t save burndown.png: the disk is full");
  });

  it("shows a PDF's first page when the hub made one, a page of lines when not, to open or save", async () => {
    const { container } = render(
      <Attachments
        files={[
          file("report.pdf", "application/pdf", { thumbnail_url: "/api/agents/allan/attachments/art_thumb" }),
          file("draft.pdf", "application/pdf", { artifact_id: "art_draft" }),
        ]}
        home={{ hub: "dw", agent: "allan" }}
      />,
    );
    const pages = container.querySelectorAll(".att-page");
    expect(pages[0]!.querySelector("img")!.getAttribute("src")).toBe("deskfile://localhost/dw/allan/art_thumb");
    expect(pages[1]!.querySelector("img")).toBeNull();
    expect(screen.getAllByText("PDF · 412 KB")).toHaveLength(2);
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!));
    expect(opened).toEqual([[hub, "allan", "art_report.pdf", "report.pdf"]]);
  });

  it("plays video and audio from the hub, which seeks by range", () => {
    const { container } = render(
      <Attachments files={[file("demo.mp4", "video/mp4", { duration: 48 }), file("memo.mp3", "audio/mpeg")]} home={{ hub: "dw", agent: "allan" }} />,
    );
    expect(container.querySelector("video")!.getAttribute("src")).toBe("deskfile://localhost/dw/allan/art_demo.mp4");
    expect(container.querySelector("audio")!.getAttribute("src")).toBe("deskfile://localhost/dw/allan/art_memo.mp3");
    expect(screen.getByText("Video · 0:48 · 412 KB")).toBeTruthy();
  });

  it("shows any other file as a card, from the hub and agent a room message's file names", async () => {
    render(<Attachments files={[file("ticket-numbers.xlsx", "application/octet-stream", { hub: "dw", agent: "atlas" })]} />);
    expect(screen.getByText("XLSX")).toBeTruthy();
    expect(screen.getByText("Spreadsheet · 412 KB")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save as…" })));
    expect(saved).toEqual([[hub, "atlas", "art_ticket-numbers.xlsx", "ticket-numbers.xlsx"]]);
  });

  it("says when a file's workspace isn't connected any more", () => {
    render(<Attachments files={[file("x.zip", "application/zip", { hub: "gone", agent: "a" })]} />);
    expect(screen.getByText("Its workspace isn’t connected to Desk any more.")).toBeTruthy();
  });
});

describe("sending files", () => {
  const big = (name: string, size: number) => Object.defineProperty(new File(["x"], name), "size", { value: size });

  it("refuses a file over the cap or empty, in plain words, and keeps to what a message carries", () => {
    expect(tooBig(big("huge.mov", MAX_FILE_BYTES + 1))).toBe("huge.mov is 100 MB; a file can be up to 100 MB.");
    expect(tooBig(big("empty.txt", 0))).toBe("empty.txt is empty.");
    let n = 0;
    const id = () => `p${++n}`;
    const some = Array.from({ length: MAX_FILES + 2 }, (_, i) => new File(["x"], `f${i}.txt`));
    const added = adding([], [...some, big("huge.mov", MAX_FILE_BYTES + 1)], id);
    expect(added.pending).toHaveLength(MAX_FILES);
    expect(added.problem).toBe(`huge.mov is 100 MB; a file can be up to 100 MB. A message can carry up to ${MAX_FILES} files.`);
  });

  it("uploads in order and says which file failed and why", async () => {
    const files = [new File(["a"], "a.txt", { type: "text/plain" }), new File(["b"], "b.txt", { type: "text/plain" })];
    expect((await uploadAll(hub, "allan", "desk", files)).map((f) => f.artifact_id)).toEqual(["art_a.txt", "art_b.txt"]);
    uploads.fail = new Error("a file may be at most 50 MB");
    await expect(uploadAll(hub, "allan", "desk", files)).rejects.toThrow("a.txt is too big to send: a file can be at most 50 MB.");
    expect(uploadError("q.pdf", new TypeError("Failed to fetch")).message).toBe("Couldn’t send q.pdf: its workspace can’t be reached right now.");
  });

  function Box({ onSend }: { onSend: (names: string[]) => void }) {
    const files = usePendingFiles();
    const drop = useFileDrop(files.add);
    return (
      <div data-testid="box" {...drop.handlers}>
        <PendingFiles pending={files.pending} problem={files.problem} onRemove={files.remove} />
        <AttachButton onFiles={files.add} />
        <button type="button" onClick={() => onSend(files.files.map((f) => f.name))}>
          Send
        </button>
        <button type="button" onClick={() => files.sent(files.files.slice(0, 1))}>
          Sent the first
        </button>
        {drop.dragging && <DropOverlay to="Allan" />}
      </div>
    );
  }

  it("takes files from 📎 and a drop, shows them as chips to take off again, and the overlay while dragging", () => {
    const sent: string[][] = [];
    const { container } = render(<Box onSend={(n) => sent.push(n)} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["a"], "contract-draft.pdf", { type: "application/pdf" })] } });
    expect(screen.getByText("contract-draft.pdf")).toBeTruthy();
    const box = screen.getByTestId("box");
    const dataTransfer = { types: ["Files"], files: [new File(["b"], "notes.txt")], dropEffect: "none" };
    fireEvent.dragEnter(box, { dataTransfer });
    expect(screen.getByText("Drop to send to Allan")).toBeTruthy();
    fireEvent.drop(box, { dataTransfer });
    expect(screen.queryByText("Drop to send to Allan")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove contract-draft.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).toEqual([["notes.txt"]]);
  });

  it("lets go only of the files a message took, keeping one picked while it went", () => {
    const { container } = render(<Box onSend={() => {}} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["a"], "first.pdf"), new File(["b"], "later.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "Sent the first" }));
    expect(screen.queryByText("first.pdf")).toBeNull();
    expect(screen.getByText("later.txt")).toBeTruthy();
  });

  it("leaves a drag of something other than files alone", () => {
    render(<Box onSend={() => {}} />);
    fireEvent.dragEnter(screen.getByTestId("box"), { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(screen.queryByText("Drop to send to Allan")).toBeNull();
  });
});
