import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string, protocol: string) => `http://${protocol}.localhost/${encodeURIComponent(path)}`,
}));

const { fileUrl, safeFilename } = await import("./platform");

const hub = { id: "dw", label: "Driftwerk", url: "https://dw.example.com", local: false, revision: "t" };

describe("files in conversations", () => {
  it("are shown from where the webview serves Desk's file scheme, each part of the path kept apart", () => {
    expect(fileUrl(hub, "allan", "art/1 2")).toBe("http://deskfile.localhost/dw/allan/art%2F1%202");
  });

  it("are saved under a name every system takes", () => {
    expect(safeFilename("report.pdf")).toBe("report.pdf");
    expect(safeFilename("..\\..\\Startup\\run.bat")).toBe("run.bat");
    expect(safeFilename("/etc/passwd")).toBe("passwd");
    expect(safeFilename('a<b>:c"d|e?f*.txt')).toBe("a_b__c_d_e_f_.txt");
    expect(safeFilename("notes. ")).toBe("notes");
    expect(safeFilename("CON.txt")).toBe("_CON.txt");
    expect(safeFilename("..")).toBe("_");
  });
});
