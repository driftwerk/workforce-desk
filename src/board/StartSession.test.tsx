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
  fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/w/repo" } });
};
const chosen = () => screen.getAllByRole("radio", { name: /./ }).find((r) => r.getAttribute("aria-checked") === "true" && ["Acme", "Side", "Ungrouped"].includes(r.textContent ?? ""))?.textContent;

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
