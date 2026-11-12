import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/store";
import { useDesk } from "../hub/store";
import { StartSession } from "./StartSession";
import { useBoard } from "./store";
import { ACME, ticket } from "./testing";

const t = ticket(7, { title: "Fix the flaky payment test on checkout" });
const GROUPS = [
  { id: "g1", name: "Acme", collapsed: false, items: [] as string[] },
  { id: "g2", name: "Side", collapsed: false, items: [] as string[] },
];

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  assign = vi.fn(async () => ({ ...t, assignee: { kind: "session", id: "s-new", name: "x", engine: "claude" } }));
  useSettings.setState({ groups: GROUPS.map((g) => ({ ...g, items: [] })), ungrouped: { collapsed: false, items: [] }, sessionNames: {} });
  useDesk.setState({ hub: { engines: async () => [], assignTicket: assign } as never, sessions: {} });
  useBoard.setState({ boards: { [ACME.id]: { ...ACME, group: "g1" } }, tickets: { [t.id]: t } });
});
afterEach(cleanup);

const start = () => {
  render(<StartSession ticket={t} onClose={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText("Choose a folder, or type its path"), { target: { value: "/w/repo" } });
};
const chosen = () => screen.getAllByRole("radio", { name: /./ }).find((r) => r.getAttribute("aria-checked") === "true" && ["Acme", "Side", "Ungrouped"].includes(r.textContent ?? ""))?.textContent;

describe("Start a session on a ticket: folders", () => {
  it("offers the folders sessions worked in, newest first and each once, and picking one fills the field", () => {
    const s = (id: string, cwd: string, updatedAt: string) => ({ id, cwd, updatedAt, name: id, engine: "claude" }) as never;
    useDesk.setState({ sessions: { a: s("a", "/w/api", "2026-11-12T08:00:00Z"), b: s("b", "/w/web/", "2026-11-12T09:00:00Z"), c: s("c", "/w/api", "2026-11-11T09:00:00Z") } });
    render(<StartSession ticket={t} onClose={() => {}} />);
    const chips = screen.getAllByRole("radio").filter((r) => r.closest("[aria-label='Recent folders']"));
    expect(chips.map((c) => c.textContent)).toEqual(["web", "api"]);
    fireEvent.click(chips[1]!);
    expect((screen.getByPlaceholderText("Choose a folder, or type its path") as HTMLInputElement).value).toBe("/w/api");
  });
});

describe("Start a session on a ticket: what it goes by", () => {
  const sess = (id: string, cwd: string, engine: string, updatedAt: string) => ({ id, cwd, engine, updatedAt, name: id }) as never;
  const folder = () => (screen.getByPlaceholderText("Choose a folder, or type its path") as HTMLInputElement).value;
  it("takes the folder and engine of the board's newest session when the ticket has none", () => {
    const other = ticket(8, { assignee: { kind: "session", id: "old", name: "old", engine: "codex" } });
    useBoard.setState({ tickets: { [t.id]: t, [other.id]: other } });
    useDesk.setState({ sessions: { old: sess("old", "/w/api", "codex", "2026-11-12T09:00:00Z"), z: sess("z", "/w/elsewhere", "claude", "2026-11-12T10:00:00Z") } });
    render(<StartSession ticket={t} onClose={() => {}} />);
    expect(folder()).toBe("/w/api");
  });
  it("falls back to what the board's last start used, then asks nothing it can know", async () => {
    useDesk.setState({ sessions: {} });
    localStorage.setItem(`desk.board.start.${t.board}`, JSON.stringify({ cwd: "/w/saved", engine: "claude" }));
    render(<StartSession ticket={t} onClose={() => {}} />);
    expect(folder()).toBe("/w/saved");
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(`desk.board.start.${t.board}`)!)).toEqual({ cwd: "/w/saved", engine: "claude" }));
  });
});

describe("Start a session on a ticket", () => {
  it("offers New session's group picker, set to the board's group", () => {
    start();
    expect(screen.getByRole("radiogroup", { name: "Group" })).toBeTruthy();
    expect(chosen()).toBe("Acme");
  });
  it("puts the new session in the chosen group, remembers it for boards without one, and gives it a short name", async () => {
    start();
    fireEvent.click(screen.getByRole("radio", { name: "Side" }));
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(useSettings.getState().groups.find((g) => g.id === "g2")!.items).toContain("session:s-new"));
    expect(useSettings.getState().sessionNames["s-new"]).toBe("ACM-7 Fix the flaky");
    cleanup();
    useBoard.setState({ boards: { [ACME.id]: { ...ACME, group: null } } });
    start();
    expect(chosen()).toBe("Side");
  });
});
