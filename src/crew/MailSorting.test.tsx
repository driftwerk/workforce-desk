import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, HubAccount } from "../chat/types";
import type { SortRule } from "../hub/client";
import { MailSorting } from "./MailSorting";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

const fetchOnHub = vi.hoisted(() => vi.fn());
const openTarget = vi.hoisted(() => vi.fn());
const requestFocus = vi.hoisted(() => vi.fn());

vi.mock("../hub/net", async (original) => ({
  ...(await original<typeof import("../hub/net")>()),
  pairedHub: () => ({ fetch: fetchOnHub }),
}));
vi.mock("../shell/navigate", () => ({ openTarget }));
vi.mock("../shell/focus", () => ({ requestFocus }));

const hub: HubAccount = { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" };
const kat: Agent = { hubId: "local", id: "kat", name: "Kat", model: null, provider: null, isDefault: false };

const NEWS: SortRule = { rule_id: "sort-ab12cd34ef56", owner: "me@home", says: "New mail in home INBOX from news@shop.com → move it to News", enabled: true, watched_by: [] };
const BOSS: SortRule = { rule_id: "sort-111122223333", owner: null, says: "New mail in work INBOX from boss@acme.example → flag it", enabled: false, watched_by: ["Boss mail", "Digest"] };

const reply = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { "content-type": "application/json" } });

const serve = (rules: SortRule[], others: (method: string, path: string) => Response = () => reply(200, {})) =>
  fetchOnHub.mockImplementation(async (method: string, path: string) =>
    method === "GET" && path === "/api/monitors/sort-rules" ? reply(200, { rules }) : others(method, path),
  );

const calls = (method: string) => fetchOnHub.mock.calls.filter((c) => c[0] === method);

const show = async (rules: SortRule[] = [NEWS, BOSS], others?: (method: string, path: string) => Response) => {
  serve(rules, others);
  render(<MailSorting agent={kat} hub={hub} />);
  await screen.findByRole("heading", { name: "Mail sorting" });
};

const row = (says: string) => screen.getByText(says).closest(".ability-row") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("Mail sorting", () => {
  it("lists each rule with its sentence, and who else watches the mail", async () => {
    await show();
    expect(within(row(NEWS.says)).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(within(row(BOSS.says)).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(within(row(BOSS.says)).getByText("Also watched by: Boss mail, Digest")).toBeTruthy();
    expect(within(row(NEWS.says)).queryByText(/Also watched by/)).toBeNull();
    expect(within(row(NEWS.says)).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(row(NEWS.says)).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("switches a rule off at once, asking its hub with its owner, and leaves the owner out when it has none", async () => {
    await show();
    fireEvent.click(within(row(NEWS.says)).getByRole("switch"));
    expect(within(row(NEWS.says)).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(calls("PUT")).toHaveLength(1));
    const [, path, body] = calls("PUT")[0]!;
    expect(path).toBe("/api/monitors/sort-ab12cd34ef56/enabled?owner=me%40home");
    expect(JSON.parse(body.data)).toEqual({ enabled: false });

    fireEvent.click(within(row(BOSS.says)).getByRole("switch"));
    await waitFor(() => expect(calls("PUT")).toHaveLength(2));
    expect(calls("PUT")[1]![1]).toBe("/api/monitors/sort-111122223333/enabled");
    expect(JSON.parse(calls("PUT")[1]![2].data)).toEqual({ enabled: true });
  });

  it("puts the switch back and says why when the hub refuses", async () => {
    await show([NEWS], (method) => (method === "PUT" ? reply(500, { error: "The hub is busy." }) : reply(200, {})));
    fireEvent.click(within(row(NEWS.says)).getByRole("switch"));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(within(row(NEWS.says)).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect((within(row(NEWS.says)).getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks before removing, then deletes with the owner and drops the row", async () => {
    await show([NEWS, BOSS]);
    fireEvent.click(within(row(NEWS.says)).getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(calls("DELETE")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
    await waitFor(() => expect(screen.queryByText(NEWS.says)).toBeNull());
    expect(calls("DELETE").map((c) => c[1])).toEqual(["/api/monitors/sort-ab12cd34ef56?owner=me%40home"]);
    expect(screen.getByText(BOSS.says)).toBeTruthy();
  });

  it("keeps the rule when Remove is cancelled", async () => {
    await show([NEWS]);
    fireEvent.click(within(row(NEWS.says)).getByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(calls("DELETE")).toHaveLength(0);
    expect(screen.getByText(NEWS.says)).toBeTruthy();
  });

  it("keeps the rule and says why when the hub refuses to remove it", async () => {
    await show([NEWS], (method) => (method === "DELETE" ? reply(500, { error: "The hub is busy." }) : reply(200, {})));
    fireEvent.click(within(row(NEWS.says)).getByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove rule" }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toMatch(/Something broke/));
    expect(screen.getByText(NEWS.says)).toBeTruthy();
  });

  it("asks the agent in chat to change a rule, the request left open to finish", async () => {
    await show([NEWS]);
    fireEvent.click(within(row(NEWS.says)).getByRole("button", { name: "Edit" }));
    expect(openTarget).toHaveBeenCalledWith({ kind: "agent", key: "local/kat" }, { beside: true });
    expect(requestFocus).toHaveBeenCalledWith("agent:local/kat", `Change my mail sorting rule "${NEWS.says}" (${NEWS.rule_id}) so that `);
  });

  it("says Kat can sort mail when there are no rules", async () => {
    await show([]);
    expect(screen.getByText("Kat can sort new mail for you. Ask Kat to set up a rule.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows nothing at all on a hub without the route", async () => {
    fetchOnHub.mockResolvedValue(reply(404, { error: "Not Found" }));
    const { container } = render(<MailSorting agent={kat} hub={hub} />);
    await waitFor(() => expect(fetchOnHub).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });

  it("says why when the rules can't be read", async () => {
    fetchOnHub.mockResolvedValue(reply(500, { error: "The hub is busy." }));
    render(<MailSorting agent={kat} hub={hub} />);
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mail sorting" })).toBeTruthy();
  });
});
