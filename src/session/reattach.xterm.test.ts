import { Terminal as XTerm } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { reattachPrefix } from "./Terminal";

const written = (x: XTerm, d: string) => new Promise<void>((r) => x.write(d, r));
const lines = (x: XTerm) => {
  const b = x.buffer.active;
  return Array.from({ length: b.length }, (_, i) => b.getLine(i)!.translateToString(true));
};

describe("a pane attached again", () => {
  it("keeps the output it had above the hub's replay, beyond what the hub keeps", async () => {
    const x = new XTerm({ rows: 5, cols: 40, scrollback: 1000, allowProposedApi: true });
    for (let i = 0; i < 30; i++) await written(x, `old ${i}\r\n`);
    await written(x, reattachPrefix(x.rows));
    // The hub's replay: its last few rows of history, then the screen.
    for (let i = 27; i < 30; i++) await written(x, `old ${i}\r\n`);
    await written(x, "$ ");
    const all = lines(x);
    expect(all).toContain("old 0");
    const mark = all.indexOf("— reconnected —");
    expect(mark).toBeGreaterThan(all.indexOf("old 29"));
    // Right below the line, nothing between, nothing garbled.
    expect(all.slice(mark + 1, mark + 5).map((l) => l.trimEnd())).toEqual(["old 27", "old 28", "old 29", "$"]);
  });

  it("leaves a full-screen program's screen first, keeping the output from before it", async () => {
    const x = new XTerm({ rows: 5, cols: 40, scrollback: 1000, allowProposedApi: true });
    for (let i = 0; i < 10; i++) await written(x, `old ${i}\r\n`);
    await written(x, "\x1b[?1049h\x1b[Hvim screen");
    expect(x.buffer.active.type).toBe("alternate");
    await written(x, reattachPrefix(x.rows, true));
    expect(x.buffer.active.type).toBe("normal");
    await written(x, "replay");
    const all = lines(x);
    expect(all).toContain("old 0");
    expect(all.indexOf("— reconnected —")).toBeGreaterThan(all.indexOf("old 9"));
  });
});
