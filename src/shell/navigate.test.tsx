import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { reveal } from "../grids/windows";
import { useDesk } from "../hub/store";
import type { Room, RoomMessage, Session } from "../hub/types";
import { openUrl } from "../platform";
import { openAgent } from "../rooms/AgentPanel";
import { requestFocus, useFocus, useFocusRequest } from "./focus";
import { openTarget, targetOfItem } from "./navigate";
import { useUi } from "./ui";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../grids/windows", () => ({ reveal: vi.fn(() => false) }));
vi.mock("../platform", () => ({ openUrl: vi.fn() }));
vi.mock("../rooms/AgentPanel", () => ({ openAgent: vi.fn() }));

const message = (id: string): RoomMessage => ({ id, roomId: "r1", threadId: null, author: "you", content: "hi", hop: 0, createdAt: "" });

beforeEach(() => {
  vi.mocked(reveal).mockReturnValue(false);
  useDesk.setState({
    sessions: { "s-1": { id: "s-1" } as Session },
    rooms: { r1: { id: "r1" } as Room },
    timelines: { r1: [message("m-1")] },
    openId: null,
    activeRoom: null,
    view: "floor",
    hub: null,
  });
  useChat.setState({ roster: [{ hubId: "b", id: "scout", name: "Scout", model: null, provider: null, isDefault: false }] });
  useFocus.setState({ where: null, nonce: 0 });
  useUi.setState({ roomThreads: {} });
  vi.mocked(openAgent).mockClear();
});
afterEach(cleanup);

describe("going to a target", () => {
  it("shows a session where a grid shows it, else opens its card, and focuses its terminal to reply", () => {
    vi.mocked(reveal).mockReturnValueOnce(true);
    openTarget({ kind: "session", sessionId: "s-1" });
    expect(reveal).toHaveBeenCalledWith({ kind: "session", sessionId: "s-1" });
    expect(useDesk.getState().openId).toBeNull();
    openTarget({ kind: "session", sessionId: "s-1" }, { reply: true });
    expect(useDesk.getState().openId).toBe("s-1");
    expect(useFocus.getState().where).toBe("session:s-1");
    openTarget({ kind: "session", sessionId: "unknown" });
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it("opens an agent's DM on any hub where Desk shows it, its composer focused to reply", () => {
    openTarget({ kind: "agent", key: "b/scout" }, { reply: true });
    expect(openAgent).toHaveBeenCalledWith("b/scout");
    expect(useFocus.getState().where).toBe("agent:b/scout");
    openTarget({ kind: "agent", key: "b/nobody" });
    expect(openAgent).toHaveBeenCalledTimes(1);
  });

  it("opens a room at its thread, or its main timeline when the thread is gone", async () => {
    openTarget({ kind: "room", roomId: "r1", threadId: "m-1" }, { reply: true });
    await vi.waitFor(() => expect(useFocus.getState().where).toBe("room:r1/m-1"));
    expect(useDesk.getState().activeRoom).toBe("r1");
    expect(useUi.getState().roomThreads).toEqual({ r1: "m-1" });
    openTarget({ kind: "room", roomId: "r1", threadId: "m-gone" }, { reply: true });
    await vi.waitFor(() => expect(useFocus.getState().where).toBe("room:r1"));
    expect(useUi.getState().roomThreads).toEqual({});
  });

  it("opens a thread older than the room's latest messages at the thread", async () => {
    const reply = { ...message("m-r"), threadId: "m-old" };
    useDesk.setState({
      hub: { roomMessages: vi.fn(async (_: string, thread?: string) => (thread === "m-old" ? [reply] : [])) } as never,
    });
    openTarget({ kind: "room", roomId: "r1", threadId: "m-old" }, { reply: true });
    await vi.waitFor(() => expect(useFocus.getState().where).toBe("room:r1/m-old"));
    expect(useUi.getState().roomThreads).toEqual({ r1: "m-old" });
  });

  it("opens Slack in the browser", () => {
    openTarget({ kind: "slack", url: "https://slack.com/app_redirect?channel=C1" });
    expect(openUrl).toHaveBeenCalledWith("https://slack.com/app_redirect?channel=C1");
  });

  it("knows where a sidebar item opens", () => {
    expect(targetOfItem("session:s-1")).toEqual({ kind: "session", sessionId: "s-1" });
    expect(targetOfItem("agent:b/scout")).toEqual({ kind: "agent", key: "b/scout" });
    expect(targetOfItem("other")).toBeNull();
  });
});

function Field({ where }: { where: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useFocusRequest(where, ref);
  return <textarea ref={ref} aria-label={where} />;
}

describe("asking for focus", () => {
  it("focuses the composer asked for, even one shown after the asking, once", () => {
    requestFocus("agent:b/scout");
    const { getByLabelText } = render(
      <>
        <Field where="agent:b/other" />
        <Field where="agent:b/scout" />
      </>,
    );
    expect(document.activeElement).toBe(getByLabelText("agent:b/scout"));
    expect(useFocus.getState().where).toBeNull();
    act(() => (getByLabelText("agent:b/other") as HTMLElement).focus());
    act(() => requestFocus("agent:b/scout"));
    expect(document.activeElement).toBe(getByLabelText("agent:b/scout"));
  });
});
