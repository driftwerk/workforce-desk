import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => void state.set(k, v), remove: (k: string) => void state.delete(k) },
}));
const removed = vi.hoisted(() => [] as unknown[]);
vi.mock("./engine", () => ({
  removeMember: vi.fn(async (_room: unknown, m: unknown) => void removed.push(m)),
  closeRoom: vi.fn(async () => {}),
}));

const { useChat } = await import("../chat/store");
const { HubError } = await import("../hub/client");
const { useDesk } = await import("../hub/store");
const { levelOf } = await import("../unread/prefs");
const { RoomDetails } = await import("./RoomDetails");

const room = {
  id: "r1",
  slug: "atlas-launch",
  name: "Atlas launch",
  members: [
    { hub: "local", agent: "allan" },
    { hub: "dw", agent: "sarah" },
  ],
  defaultMember: "local/allan",
  createdAt: "",
  updatedAt: "",
};
let patches: unknown[] = [];
const updateRoom = vi.fn(async (_id: string, patch: { name?: string }) => {
  patches.push(patch);
  if (patch.name === "acme-web") throw new HubError(409, "a room is called that");
  return { ...room, ...patch };
});

beforeEach(() => {
  state.clear();
  patches = [];
  removed.length = 0;
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "", local: true, revision: "" }],
    roster: [
      { hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false },
      { hubId: "dw", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: false },
      { hubId: "local", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false },
    ],
  });
  useDesk.setState({
    rooms: { r1: room },
    hub: { updateRoom } as never,
    roomDrafts: { r1: [{ id: "d", member: "local/allan", threadId: null, asked: "q", since: 0, text: "", working: null, tools: [], attachments: [], prompts: [], state: "live" }] },
  });
});
afterEach(cleanup);

const details = () => render(<RoomDetails room={room} rename={false} onClose={() => {}} />);

describe("a room's details", () => {
  it("renames it, and says so when another room has that name", async () => {
    details();
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "acme-web" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "There’s already a room called acme-web.");
    fireEvent.change(name, { target: { value: "Atlas release" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(patches.at(-1)).toEqual({ name: "Atlas release" }));
  });

  it("says what each member is doing, and whose workspace isn't connected", () => {
    details();
    const members = screen.getByRole("region", { name: "Members" });
    expect(within(members).getByText(/This computer · Answering/)).toBeTruthy();
    expect(within(members).getByText(/Workspace not connected/)).toBeTruthy();
  });

  it("sets the lead and clears it", async () => {
    details();
    fireEvent.click(screen.getByRole("radio", { name: "Sarah leads" }));
    fireEvent.click(screen.getByRole("radio", { name: /No lead/ }));
    await vi.waitFor(() => expect(patches).toEqual([{ defaultMember: "dw/sarah" }, { defaultMember: null }]));
  });

  it("removes a member through the engine, which stops their answer first", async () => {
    details();
    fireEvent.click(screen.getByRole("button", { name: "Remove Allan" }));
    await vi.waitFor(() => expect(removed).toEqual([{ hub: "local", agent: "allan" }]));
  });

  it("adds someone from the crew not in it", async () => {
    details();
    fireEvent.click(screen.getByRole("button", { name: "Add someone" }));
    expect(screen.queryByRole("checkbox", { name: "" })).toBeNull();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(1);
    fireEvent.click(boxes[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Add to the room" }));
    await vi.waitFor(() => expect(patches).toEqual([{ members: [...room.members, { hub: "local", agent: "atlas" }] }]));
  });

  it("keeps its notification level", () => {
    details();
    fireEvent.click(screen.getByRole("radio", { name: /^Off/ }));
    expect(levelOf({ kind: "room", room: "r1" })).toBe("off");
    expect(levelOf({ kind: "thread", room: "r1", thread: "t1" })).toBe("off");
    expect(state.get("notify.room:r1")).toBe("off");
    fireEvent.click(screen.getByRole("radio", { name: /^Only things for me/ }));
    expect(state.has("notify.room:r1")).toBe(false);
  });
});
