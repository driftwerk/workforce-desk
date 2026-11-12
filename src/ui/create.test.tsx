import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubError, type DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { NewRoom } from "../rooms/NewRoom";
import { NewSession } from "../session/NewSession";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  inApp: false,
  pickFolder: vi.fn(async () => null),
  claudePluginDir: vi.fn(async () => null),
  programsUnder: vi.fn(async () => []),
}));

const flush = () => act(async () => {});
const openRoom = vi.fn(async () => {});

beforeEach(() => {
  openRoom.mockClear();
  useDesk.setState({ error: null, openRoom, openId: null } as never);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const room = (id: string, name: string) => ({ id, name, slug: name, members: [], defaultMember: null });

/** A promise held open until `release`. */
const held = <T,>() => {
  let release!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => ((release = res), (reject = rej)));
  return { p, release, reject };
};

const typeRoom = (name: string) => fireEvent.change(screen.getByPlaceholderText("release"), { target: { value: name } });

it("a room is made once however often Create is pressed", async () => {
  const slow = held<ReturnType<typeof room>>();
  const createRoom = vi.fn(() => slow.p);
  useDesk.setState({ hub: { rooms: vi.fn(async () => []), createRoom } as unknown as DeskHub });
  render(<NewRoom onClose={() => {}} />);
  typeRoom("release");
  const form = screen.getByRole("form", { name: "New room" });
  await act(async () => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  fireEvent.submit(form);
  await flush();
  expect(createRoom).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => slow.release(room("r1", "release")));
  expect(openRoom).toHaveBeenCalledWith("r1");
});

it("after a 5xx it looks for the room, and opens it when it was made", async () => {
  const rooms = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([room("r9", "release")]);
  const createRoom = vi.fn(async () => {
    throw new HubError(503, "timed out");
  });
  useDesk.setState({ hub: { rooms, createRoom } as unknown as DeskHub });
  const onClose = vi.fn();
  render(<NewRoom onClose={onClose} />);
  typeRoom("release");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
  expect(openRoom).toHaveBeenCalledWith("r9");
  expect(onClose).toHaveBeenCalled();
  expect(useDesk.getState().error).toBeNull();
  expect(createRoom).toHaveBeenCalledTimes(1);
});

it("after a 5xx with no such room, it offers Retry, which sends the form as it is now", async () => {
  const rooms = vi.fn(async () => []);
  const createRoom = vi.fn().mockRejectedValueOnce(new HubError(500, "pg down")).mockResolvedValueOnce(room("r2", "renamed"));
  useDesk.setState({ hub: { rooms, createRoom } as unknown as DeskHub });
  render(<NewRoom onClose={() => {}} />);
  typeRoom("release");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
  const fix = useDesk.getState().error?.fix;
  expect(fix?.label).toBe("Retry");
  typeRoom("renamed");
  await act(async () => fix!.run!());
  expect(createRoom).toHaveBeenCalledTimes(2);
  expect(createRoom.mock.calls[1]![0]).toBe("renamed");
});

it("after a 5xx it can't tell about, it offers no Retry", async () => {
  const createRoom = vi.fn(async () => {
    throw new HubError(500, "pg down");
  });
  useDesk.setState({ hub: { rooms: vi.fn(async () => Promise.reject(new Error("down"))), createRoom } as unknown as DeskHub });
  render(<NewRoom onClose={() => {}} />);
  typeRoom("release");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
  expect(useDesk.getState().error?.fix?.label).not.toBe("Retry");
});

it("a refusal (4xx) is safe to retry", async () => {
  const createRoom = vi.fn(async () => {
    throw new HubError(409, "A room called release already exists.");
  });
  useDesk.setState({ hub: { rooms: vi.fn(async () => []), createRoom } as unknown as DeskHub });
  render(<NewRoom onClose={() => {}} />);
  typeRoom("release");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
  expect(useDesk.getState().error?.fix?.label).toBe("Retry");
});

const type = (v: string) => fireEvent.change(screen.getByLabelText("Folder"), { target: { value: v } });

it("a session is started once, opened when a 5xx hid that it was, else retried with the current folder", async () => {
  const sessions = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "s-7", cwd: "/work/atlas", name: "atlas" }]);
  const start = vi.fn(async () => {
    throw new HubError(502, "bad gateway");
  });
  useDesk.setState({ hub: { start, sessions, engines: vi.fn(async () => null) } as unknown as DeskHub });
  const onClose = vi.fn();
  render(<NewSession onClose={onClose} />);
  type("/work/atlas");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  expect(useDesk.getState().openId).toBe("s-7");
  expect(onClose).toHaveBeenCalled();
  expect(start).toHaveBeenCalledTimes(1);
});

it("a session's Retry uses what is in the form now, and a double click starts one", async () => {
  const slow = held<{ id: string }>();
  const start = vi.fn().mockRejectedValueOnce(new HubError(500, "x")).mockReturnValueOnce(slow.p);
  useDesk.setState({ hub: { start, sessions: vi.fn(async () => []), engines: vi.fn(async () => null) } as unknown as DeskHub });
  render(<NewSession onClose={() => {}} />);
  type("/work/one");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
  const fix = useDesk.getState().error?.fix;
  expect(fix?.label).toBe("Retry");
  type("/work/two");
  await act(async () => {
    fix!.run!();
    fix!.run!();
  });
  expect(start).toHaveBeenCalledTimes(2);
  expect((start.mock.calls[1] as unknown as [{ cwd: string }])[0].cwd).toBe("/work/two");
  await act(async () => slow.release({ id: "s-1" }));
});
