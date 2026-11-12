import { afterEach, describe, expect, it, vi } from "vitest";
import { explain } from "./problem";
import { checkPane, openPane, paneFix, permissionOf, permissionProblem } from "./privacy";
import { useHost } from "../shell/host";

const invoke = vi.fn();
vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  invoke: (...a: unknown[]) => invoke(...a),
}));

afterEach(() => {
  invoke.mockReset();
  useHost.setState({ platform: "macos" });
});

describe("the system's privacy settings", () => {
  it("knows a withheld permission from Desk's native words, and which pane grants it", () => {
    expect(permissionOf("starting voice: Desk isn’t allowed to use the microphone.")).toEqual({
      plain: "Allow Desk to use the microphone.",
      pane: "microphone",
    });
    expect(permissionOf("Desk isn’t allowed to read shot.png. Allow it in Files and Folders.")).toEqual({
      plain: "Allow Desk to read shot.png.",
      pane: "filesAndFolders",
    });
    expect(permissionOf("Desk isn’t allowed to read Mail.emlx. Allow it in Full Disk Access.")?.pane).toBe("fullDiskAccess");
    // Windows: nothing of Desk's to change, so no button.
    expect(permissionOf("Desk isn’t allowed to read a.txt.")).toEqual({ plain: "Allow Desk to read a.txt.", pane: null });
    expect(permissionOf("no microphone input")).toBeNull();
  });

  it("puts it in the one problem shape, with the button that opens the pane", () => {
    const p = permissionProblem("starting audio: Desk isn’t allowed to use the microphone.", "starting voice")!;
    expect(p.plain).toBe("Allow Desk to use the microphone.");
    expect(p.fix?.label).toBe("Open Microphone settings");
    expect(p.details).toContain("starting audio");
    invoke.mockResolvedValueOnce(undefined);
    p.fix!.run!();
    expect(invoke).toHaveBeenCalledWith("privacy_open", { pane: "microphone" });
    useHost.setState({ platform: "windows" });
    expect(paneFix("microphone").label).toBe("Open Windows Settings");
  });

  it("is what explain() says of it anywhere, never the raw OS text", () => {
    const p = explain(new Error("Desk isn’t allowed to read secret.txt. Allow it in Files and Folders."));
    expect(p.plain).toBe("Allow Desk to read that file.");
    expect(p.fix?.label).toBe("Open Files and Folders settings");
    expect(p.details).toContain("secret.txt");
    expect(explain(new Error("Desk isn’t allowed to use the microphone.")).plain).toBe("Allow Desk to use the microphone.");
  });

  it("says when a pane wouldn't open, and reads a permission as unknown when it can't", async () => {
    const { setOpenReporter } = await import("../platform");
    const said: unknown[] = [];
    setOpenReporter((e) => said.push(e));
    invoke.mockRejectedValueOnce("Desk couldn't open the Microphone settings.");
    await openPane("microphone");
    expect(said).toEqual(["Desk couldn't open the Microphone settings."]);
    setOpenReporter(null);
    invoke.mockRejectedValueOnce(new Error("no"));
    expect(await checkPane("accessibility")).toBe("unknown");
    invoke.mockResolvedValueOnce("granted");
    expect(await checkPane("microphone")).toBe("granted");
  });
});
