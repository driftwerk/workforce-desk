import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Need, RoomMessage } from "../hub/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
const kept = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: {
    get: (k: string) => kept.get(k),
    set: (k: string, v: unknown) => void kept.set(k, v),
    remove: (k: string) => void kept.delete(k),
    subscribe: () => () => {},
  },
}));

const { useChat } = await import("../chat/store");
const { useDesk } = await import("../hub/store");
const { useFloor, useNeeds } = await import("../floor/store");
const { NeedRow } = await import("../floor/NeedRow");
const { agent, need, ready, view } = await import("../floor/testing");
const { useNeedsDismissed } = await import("./needsSeen");
const { useRoomMarker } = await import("./Marks");

const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 9, 0, s)).toISOString();
const post = (id: string, s: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
  id,
  roomId: "r1",
  threadId: null,
  author: "you",
  content: "hello",
  hop: 0,
  createdAt: at(s),
  ...over,
});
const asked = (over: Partial<Need> = {}): Need =>
  need("q-1", agent("lattice"), { ask: "Can you ask him whether he saw it?", since: at(10), place: { kind: "room", room: "r1", thread: null }, ...over });

let listed: number[] = [];
let badge = { count: 0, dot: false };
function Probe() {
  listed.push(useNeeds().length);
  badge = useRoomMarker("r1");
  return null;
}

beforeEach(() => {
  kept.clear();
  listed = [];
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "", local: true, revision: "" }], roster: [] });
  useDesk.setState({ timelines: { r1: [] }, roomDrafts: {}, rooms: {} });
  useNeedsDismissed.setState({ gone: new Set() });
  useFloor.setState({ hubs: { local: ready(view({ needs: [asked()] })) } });
});
afterEach(cleanup);

describe("an agent's question in a room", () => {
  it("is a need on the room's badge until you post there after it, to anyone", () => {
    render(<Probe />);
    expect(badge).toMatchObject({ count: 1, dot: false });
    act(() => useDesk.setState({ timelines: { r1: [post("early", 5)] } }));
    expect(badge.count).toBe(1);
    act(() => useDesk.setState({ timelines: { r1: [post("early", 5), post("later", 20)] } }));
    expect(badge).toMatchObject({ count: 0, dot: false });
    expect(listed.at(-1)).toBe(0);
  });

  it("is answered in a thread only by a post in that thread", () => {
    useFloor.setState({ hubs: { local: ready(view({ needs: [asked({ place: { kind: "room", room: "r1", thread: "t1" } })] })) } });
    render(<Probe />);
    act(() => useDesk.setState({ timelines: { r1: [post("main", 20)] } }));
    expect(listed.at(-1)).toBe(1);
    act(() => useDesk.setState({ timelines: { r1: [post("main", 20), post("in", 21, { threadId: "t1" })] } }));
    expect(listed.at(-1)).toBe(0);
  });

  it("is not answered by a post in a DM, which needs a message in that DM", () => {
    useFloor.setState({ hubs: { local: ready(view({ needs: [need("q-2", agent("lattice"))] })) } });
    render(<Probe />);
    act(() => useDesk.setState({ timelines: { r1: [post("later", 20)] } }));
    expect(listed.at(-1)).toBe(1);
  });

  it("can be dismissed as not needed from its card, and the room's badge goes with it", () => {
    const n = { ...asked(), hubId: "local", local: true, key: "local/q-1", stale: false };
    render(
      <>
        <Probe />
        <NeedRow need={n} now={Date.parse(at(70))} actions />
      </>,
    );
    expect(badge.count).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /not needed/ }));
    expect(badge).toMatchObject({ count: 0, dot: false });
    expect(kept.get("unread.needs.dismissed")).toEqual(["local/q-1"]);
  });
});
