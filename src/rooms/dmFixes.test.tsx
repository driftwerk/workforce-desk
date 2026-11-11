import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { readableError } from "../chat/agentError";
import { HubError, refusal } from "../hub/client";
import { useDesk, type RoomDraft } from "../hub/store";
import type { Room } from "../hub/types";
import { useUi } from "../shell/ui";
import { nameClash } from "./clash";
import { Draft } from "./Draft";
import { MemberPicker } from "./MemberPicker";
import { NotShared, savingShared, ShareAsk } from "./share";

const room = (id: string, name: string): Room => ({ id, name, slug: name.toLowerCase(), members: [], defaultMember: null }) as unknown as Room;

beforeEach(() => {
  useChat.setState({
    hubs: [
      { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" },
      { id: "dw", label: "Driftwerk", url: "https://dw.example", local: false, revision: "t" },
    ],
    roster: [],
  });
});
afterEach(cleanup);

describe("a room reaching another workspace", () => {
  it("reads the workspaces the hub asks about from its refusal", async () => {
    const e = await refusal(new Response(JSON.stringify({ error: "Agents on dw will see this room's conversation", hubs: ["dw"] }), { status: 409 }));
    expect(e.hubs).toEqual(["dw"]);
    const plain = await refusal(new Response(JSON.stringify({ error: "there is already a room called Release" }), { status: 409 }));
    expect(plain.hubs).toBeUndefined();
  });

  it("asks the person in Desk's own dialog, and saves again saying yes", async () => {
    render(<ShareAsk />);
    const save = vi.fn((shareWith: string[]) =>
      shareWith.length ? Promise.resolve(room("r1", "Release")) : Promise.reject(new HubError(409, "Agents on dw will see…", undefined, ["dw"])),
    );
    let saved: Promise<Room>;
    await act(async () => {
      saved = savingShared("Release", save);
    });
    expect(await screen.findByRole("dialog", { name: "Share Release with Driftwerk?" })).toBeTruthy();
    expect(screen.getByText(/Agents on Driftwerk will see this room’s conversation/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Share with Driftwerk" })));
    await expect(saved!).resolves.toMatchObject({ id: "r1" });
    expect(save.mock.calls).toEqual([[[]], [["dw"]]]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("saves nothing when the person says no, and leaves every other refusal as it was", async () => {
    render(<ShareAsk />);
    const save = vi.fn(() => Promise.reject(new HubError(409, "asks", undefined, ["dw"])));
    let saved: Promise<unknown>;
    await act(async () => {
      saved = savingShared("Release", save).catch((e: unknown) => e);
    });
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Cancel" })));
    expect(await saved!).toBeInstanceOf(NotShared);
    expect(save).toHaveBeenCalledTimes(1);
    const other = new HubError(409, "there is already a room called Release");
    await expect(savingShared("Release", () => Promise.reject(other))).rejects.toBe(other);
  });

  it("tells a name clash from a workspace to ask about", () => {
    useDesk.setState({ rooms: { r1: room("r1", "Release"), r2: room("r2", "Design") } });
    expect(nameClash(new HubError(409, "there is already a room called release"), " release ")?.id).toBe("r1");
    expect(nameClash(new HubError(409, "there is already a room called Release"), "Release", "r1")).toBeNull();
    expect(nameClash(new HubError(409, "asks", undefined, ["dw"]), "Release")).toBeNull();
    expect(nameClash(new HubError(400, "bad"), "Release")).toBeNull();
  });
});

describe("picking a room's crew", () => {
  it("says there's no crew yet, with New crew member, rather than that everyone is in", () => {
    useUi.setState({ newCrew: false });
    render(<MemberPicker picked={[]} onToggle={() => undefined} />);
    expect(screen.queryByText("Everyone in your crew is in it.")).toBeNull();
    expect(screen.getByText(/You have no crew yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New crew member" }));
    expect(useUi.getState().newCrew).toBe(true);
    cleanup();
    useChat.setState({ roster: [{ hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: true }] });
    render(<MemberPicker picked={[]} onToggle={() => undefined} leaveOut={["local/scout"]} />);
    expect(screen.getByText("Everyone in your crew is in it.")).toBeTruthy();
  });
});

const draft = (error: string): RoomDraft => ({
  id: "a1",
  member: "local/scout",
  threadId: null,
  asked: "m1",
  since: 0,
  text: "",
  working: null,
  tools: [],
  attachments: [],
  prompts: [],
  state: "failed",
  error,
});

describe("a member's turn that failed in a room", () => {
  it("says why as the DM does, with signing in where that would help, and still offers Retry", () => {
    useDesk.setState({ hub: null });
    render(
      <Draft
        roomId="r1"
        name="Scout"
        draft={draft("Agent error: no route could serve this turn: claude-code:opus — subscription unavailable: no Claude login for x")}
      />,
    );
    expect(screen.getByText(/Couldn’t answer: no Claude account is signed in for this agent/)).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("offers Reconnect for a member on a workspace Desk lost", () => {
    const opened = vi.fn();
    useUi.setState({ openSettings: opened } as never);
    render(<Draft roomId="r1" name="Scout" draft={draft("Scout is on a workspace Desk isn’t connected to any more.")} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(opened).toHaveBeenCalledWith("hubs");
  });

  it("says what to change when the model provider refused, and nothing of it for other refusals", () => {
    expect(readableError("Agent error: anthropic API returned 401: invalid x-api-key").text).toBe(
      "Couldn’t answer: its model provider refused the key or account it uses. Switch its model, or its key, in its settings.",
    );
    expect(readableError("Agent error: Permission denied (os error 13)").text).toBe("Couldn’t answer: Permission denied (os error 13)");
  });
});
