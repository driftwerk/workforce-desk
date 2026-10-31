import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", async (real) => ({ ...(await real<object>()), openUrl: vi.fn() }));
vi.mock("./navigate", () => ({ openTarget: vi.fn() }));

const { openUrl } = await import("../platform");
const { openTarget } = await import("./navigate");
const { useDesk } = await import("../hub/store");
const { deskLink, linkParts, openLink, parseDeskLink } = await import("./links");

const ROOM = "6f1c2a4e-0b7d-4c55-9a51-3d2e8f9b1c07";
const MSG = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  vi.mocked(openUrl).mockClear();
  vi.mocked(openTarget).mockClear();
  useDesk.setState({ rooms: { [ROOM]: { id: ROOM } as never }, error: null });
});

describe("desk links", () => {
  it("name a room message, and nothing else", () => {
    expect(deskLink({ room: ROOM, message: MSG })).toBe(`desk://room/${ROOM}/msg/${MSG}`);
    expect(parseDeskLink(deskLink({ room: ROOM, message: MSG }))).toEqual({ room: ROOM, message: MSG });
    expect(parseDeskLink(`desk://room/${ROOM}`)).toBeNull();
    expect(parseDeskLink(`desk://room/x/msg/y`)).toBeNull();
    expect(parseDeskLink("https://example.com")).toBeNull();
  });

  it("open in Desk, and other links as the system does", () => {
    openLink(deskLink({ room: ROOM, message: MSG }));
    expect(openTarget).toHaveBeenCalledWith({ kind: "room", roomId: ROOM, threadId: null, messageId: MSG });
    openLink("https://example.com/a");
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
  });

  it("say so for a room this computer doesn't have", () => {
    openLink(deskLink({ room: "99999999-2222-4333-8444-555555555555", message: MSG }));
    expect(openTarget).not.toHaveBeenCalled();
    expect(useDesk.getState().error).toBe("That message isn’t in any of your rooms.");
  });
});

describe("links in plain text", () => {
  it("split out http(s) and desk links, leaving a sentence's punctuation", () => {
    expect(linkParts(`See https://example.com/a?b=1, and desk://room/${ROOM}/msg/${MSG}.`)).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://example.com/a?b=1", url: "https://example.com/a?b=1" },
      { kind: "text", text: ", and " },
      { kind: "link", text: `desk://room/${ROOM}/msg/${MSG}`, url: `desk://room/${ROOM}/msg/${MSG}` },
      { kind: "text", text: "." },
    ]);
    expect(linkParts("no links here")).toEqual([{ kind: "text", text: "no links here" }]);
  });
});
