import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { Preference } from "../hub/types";
import { useSettings } from "../settings/store";
import { BossPreferences, patchOf, scopeSaid, usedSaid } from "./BossPreferences";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

const pref = (over: Partial<Preference>): Preference => ({
  id: "p1",
  bossScope: "main",
  whenText: "a session wants to merge with CI red",
  thenText: "make it wait for green",
  scope: "all",
  source: "asked",
  fromItem: null,
  createdAt: "2026-11-12T10:00:00Z",
  changedAt: "2026-11-12T10:00:00Z",
  appliedCount: 4,
  lastAppliedAt: "2026-11-13T09:00:00Z",
  overruledCount: 0,
  state: "active",
  ...over,
});

let list: Preference[];
let asked: { method: string; path: string; body?: unknown }[];
let answer: (method: string, path: string, body: unknown) => Response;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const transport: DeskTransport = {
  fetch: async (method, path, body) => {
    const parsed = body ? JSON.parse(String(body.data)) : undefined;
    asked.push({ method, path, body: parsed });
    return answer(method, path, parsed);
  },
  socket: () => ({}) as DeskSocket,
};
/** The hub as H9 answers: the list, a change, a state. */
const hubAnswers = (method: string, path: string, body: unknown): Response => {
  if (method === "GET") return json(list);
  const id = path.split("/")[4];
  const p = list.find((x) => x.id === id);
  if (!p) return json({ error: "There is no such preference." }, 404);
  if (method === "PATCH") return json({ ...p, ...(body as object) });
  const to = path.split("/")[5];
  return json({ ...p, state: to === "pause" ? "paused" : to === "resume" ? "active" : "retired" });
};

beforeEach(() => {
  asked = [];
  list = [
    pref({}),
    pref({ id: "p2", bossScope: "g-acme", whenText: "a session wants the prod key", thenText: "use the staging key" }),
    pref({ id: "p3", whenText: "a deploy is still rolling out", thenText: "let it finish", scope: "group:g-acme", state: "paused", overruledCount: 2, appliedCount: 1 }),
  ];
  answer = hubAnswers;
  useSettings.setState({ groups: [{ id: "g-acme", name: "Acme", collapsed: false, items: [] }] });
  useDesk.setState({ hub: new DeskHub(transport) });
});
afterEach(() => {
  cleanup();
  useDesk.setState({ hub: null });
  useSettings.setState({ groups: [] });
});

describe("a boss's preferences", () => {
  it("lists only this boss's, in words, with where each holds and how often it was used", async () => {
    render(<BossPreferences name="Desk" group={null} />);
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("When a session wants to merge with CI red");
    expect(rows[0]!.textContent).toContain("Make it wait for green.");
    expect(rows[0]!.textContent).toContain("Every session · Used 4 times");
    // The group by its name, not its id; paused, and why.
    expect(rows[1]!.textContent).toContain("Sessions in Acme · Used once · paused after you undid it 2 times");
    expect(rows[1]!.textContent).not.toContain("g-acme");
    expect(screen.queryByText(/prod key/)).toBeNull();
  });

  it("shows a group boss its own", async () => {
    render(<BossPreferences name="Ledger" group="g-acme" />);
    expect((await screen.findAllByRole("listitem")).map((r) => r.textContent)).toEqual([expect.stringContaining("prod key")]);
  });

  it("says none yet when there are none for this boss", async () => {
    list = [];
    render(<BossPreferences name="Desk" group={null} />);
    expect(await screen.findByText("None yet.")).toBeTruthy();
  });

  it("shows nothing on a hub that keeps none", async () => {
    answer = () => new Response("", { status: 404 });
    const { container } = render(<BossPreferences name="Desk" group={null} />);
    await waitFor(() => expect(asked).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("reads them again when you come back to Desk, and after a failure on Try again", async () => {
    answer = (m, p, b) => (m === "GET" ? json({ error: "The hub is busy." }, 500) : hubAnswers(m, p, b));
    render(<BossPreferences name="Desk" group={null} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Try again");
    answer = hubAnswers;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByRole("listitem")).toHaveLength(2);
    list.push(pref({ id: "p9", whenText: "a new rule arrives", thenText: "show it" }));
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
  });

  it("pauses and resumes through the hub", async () => {
    render(<BossPreferences name="Desk" group={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause: when a session wants to merge with CI red" }));
    const resume = await screen.findByRole("button", { name: "Resume: when a session wants to merge with CI red" });
    expect(asked.at(-1)).toEqual({ method: "POST", path: "/api/desk/preferences/p1/pause", body: undefined });
    list[0] = { ...list[0]!, state: "paused" };
    fireEvent.click(resume);
    await screen.findByRole("button", { name: "Pause: when a session wants to merge with CI red" });
    expect(asked.at(-1)?.path).toBe("/api/desk/preferences/p1/resume");
  });

  it("forgets only after you say so, and the row goes", async () => {
    render(<BossPreferences name="Desk" group={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Forget: when a session wants to merge with CI red" }));
    expect(asked.filter((a) => a.method === "POST")).toHaveLength(0);
    const row = screen.getAllByRole("listitem")[0]!;
    fireEvent.click(within(row).getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Forget: when a session wants to merge with CI red" }));
    fireEvent.click(within(screen.getAllByRole("listitem")[0]!).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(asked.at(-1)?.path).toBe("/api/desk/preferences/p1/retire");
  });

  it("drops a row the hub no longer has", async () => {
    render(<BossPreferences name="Desk" group={null} />);
    const pause = await screen.findByRole("button", { name: "Pause: when a session wants to merge with CI red" });
    list = list.filter((p) => p.id !== "p1");
    fireEvent.click(pause);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  });

  it("edits only what changed, and shows the hub's words after", async () => {
    render(<BossPreferences name="Desk" group={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit: when a session wants to merge with CI red" }));
    fireEvent.change(screen.getByLabelText("Then"), { target: { value: "make it wait for green CI" } });
    fireEvent.change(screen.getByLabelText("For"), { target: { value: "group:g-acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Make it wait for green CI.");
    expect(asked.at(-1)).toEqual({
      method: "PATCH",
      path: "/api/desk/preferences/p1",
      body: { thenText: "make it wait for green CI", scope: "group:g-acme" },
    });
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Sessions in Acme");
  });

  it("sends nothing when nothing changed, and says the hub's problem in place", async () => {
    render(<BossPreferences name="Desk" group={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit: when a session wants to merge with CI red" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(asked.filter((a) => a.method === "PATCH")).toHaveLength(0);
    expect(screen.queryByLabelText("Then")).toBeNull();

    answer = (m, p, b) => (m === "PATCH" ? json({ error: "A repository scope names it: repo:<owner/name>." }, 400) : hubAnswers(m, p, b));
    fireEvent.click(screen.getByRole("button", { name: "Edit: when a session wants to merge with CI red" }));
    fireEvent.change(screen.getByLabelText("For"), { target: { value: "repo" } });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("repo:<owner/name>");
    expect(screen.getByLabelText("Then")).toBeTruthy();
  });
});

describe("its words", () => {
  it("say where and how often", () => {
    const name = (id: string) => (id === "g1" ? "Acme" : null);
    expect(scopeSaid("all", name)).toBe("Every session");
    expect(scopeSaid("group:g1", name)).toBe("Sessions in Acme");
    expect(scopeSaid("group:gone", name)).toBe("Sessions in a group that’s gone");
    expect(scopeSaid("repo:acme/web", name)).toBe("Sessions in acme/web");
    expect(usedSaid(pref({ appliedCount: 0 }))).toBe("Not used yet");
    expect(usedSaid(pref({ appliedCount: 1, overruledCount: 1 }))).toBe("Used once · you undid it once");
    expect(usedSaid(pref({ appliedCount: 2, overruledCount: 1, state: "paused" }))).toBe("Used 2 times · paused");
  });

  it("patch only what changed", () => {
    const p = pref({});
    expect(patchOf(p, p.whenText, p.thenText, "all")).toBeNull();
    expect(patchOf(p, ` ${p.whenText} `, "x", "repo:a/b")).toEqual({ thenText: "x", scope: "repo:a/b" });
  });
});
