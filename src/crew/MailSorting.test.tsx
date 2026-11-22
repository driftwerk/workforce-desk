import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, HubAccount } from "../chat/types";
import type { SortRule } from "../hub/client";
import { MailSorting, useMailSorting } from "./MailSorting";

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

const remote: HubAccount = { id: "acme", label: "Acme", url: "https://hub.acme.example", local: false, revision: "r" };

function Section({ on = true, at = hub }: { on?: boolean; at?: HubAccount }) {
  const mail = useMailSorting(at, "kat", on);
  return <MailSorting agent={kat} mail={mail} />;
}

const reply = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { "content-type": "application/json" } });

const serve = (rules: SortRule[], others: (method: string, path: string) => Response = () => reply(200, {})) =>
  fetchOnHub.mockImplementation(async (method: string, path: string) =>
    method === "GET" && path === "/api/monitors/sort-rules" ? reply(200, { rules }) : others(method, path),
  );

const calls = (method: string) => fetchOnHub.mock.calls.filter((c) => c[0] === method);

const show = async (rules: SortRule[] = [NEWS, BOSS], others?: (method: string, path: string) => Response) => {
  serve(rules, others);
  render(<Section />);
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

  it("words the rules as the person's own, and says they have none yet", async () => {
    await show([]);
    expect(screen.getByText("You have no mail sorting rules yet. Ask Kat to set one up.")).toBeTruthy();
    expect(screen.getByText(/Your rules for sorting new mail/)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("says it is reading the rules until they arrive", async () => {
    serve([NEWS]);
    render(<Section />);
    expect(screen.getByRole("status").textContent).toBe("Reading your mail sorting rules…");
    expect(await screen.findByText(NEWS.says)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reads again when Desk is looked at again, keeping a rule being saved as it is", async () => {
    await show([NEWS]);
    serve([NEWS, BOSS]);
    fireEvent.focus(window);
    expect(await screen.findByText(BOSS.says)).toBeTruthy();

    serve([], (method) => (method === "PUT" ? new Promise<Response>(() => {}) as never : reply(200, {})));
    fireEvent.click(within(row(NEWS.says)).getByRole("switch"));
    const reads = calls("GET").length;
    fireEvent.focus(window);
    expect(calls("GET")).toHaveLength(reads);
    expect(screen.getByText(NEWS.says)).toBeTruthy();
  });

  it("does not read again while Desk is hidden, and keeps what it has when a later read fails", async () => {
    await show([NEWS]);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const reads = calls("GET").length;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(calls("GET")).toHaveLength(reads);
    hidden.mockReturnValue("visible");
    fetchOnHub.mockResolvedValue(reply(500, { error: "The hub is busy." }));
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(calls("GET")).toHaveLength(reads + 1));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(NEWS.says)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    hidden.mockRestore();
  });

  it("neither reads nor shows anything for an agent without the email skill", async () => {
    serve([NEWS]);
    const { container } = render(<Section on={false} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchOnHub).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing at all on a hub without the route", async () => {
    fetchOnHub.mockResolvedValue(reply(404, { error: "Not Found" }));
    const { container } = render(<Section />);
    await waitFor(() => expect(fetchOnHub).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });

  it("shows only the latest read when an earlier one answers after it", async () => {
    let answerFirst: (r: Response) => void = () => {};
    let n = 0;
    fetchOnHub.mockImplementation(async () => {
      n += 1;
      return n === 1 ? new Promise<Response>((r) => (answerFirst = r)) : reply(200, { rules: [BOSS] });
    });
    render(<Section />);
    fireEvent.focus(window);
    expect(await screen.findByText(BOSS.says)).toBeTruthy();
    answerFirst(reply(200, { rules: [NEWS] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(NEWS.says)).toBeNull();
    expect(screen.getByText(BOSS.says)).toBeTruthy();
  });

  it("reads once for a hub however often it is handed over afresh", async () => {
    await show([NEWS]);
    const reads = calls("GET").length;
    cleanup();
    serve([NEWS]);
    const { rerender } = render(<Section at={{ ...hub }} />);
    await screen.findByText(NEWS.says);
    const after = calls("GET").length;
    rerender(<Section at={{ ...hub }} />);
    rerender(<Section at={{ ...hub }} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls("GET")).toHaveLength(after);
    expect(after).toBe(reads + 1);
    rerender(<Section at={{ ...hub, revision: "renewed" }} />);
    await waitFor(() => expect(calls("GET")).toHaveLength(after + 1));
  });

  it("elsewhere, shows the rules only when that hub has email for the agent", async () => {
    const tools = (answer: Response) =>
      fetchOnHub.mockImplementation(async (method: string, path: string) =>
        path === "/api/agents/kat/tools"
          ? answer
          : method === "GET" && path === "/api/monitors/sort-rules"
            ? reply(200, { rules: [NEWS] })
            : reply(200, {}),
      );
    const hidden = async (answer: Response) => {
      vi.clearAllMocks();
      tools(answer);
      const { container } = render(<Section at={remote} />);
      await waitFor(() => expect(fetchOnHub).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(container.innerHTML).toBe("");
      expect(fetchOnHub.mock.calls.map((c) => c[1])).toEqual(["/api/agents/kat/tools"]);
      cleanup();
    };
    await hidden(reply(200, { tools: [{ name: "email.setup" }, { name: "email.sort_rules" }] }));
    await hidden(reply(403, { error: "Forbidden" }));
    tools(reply(200, { tools: [{ name: "email.inbox" }, { name: "email.sort_rules" }] }));
    render(<Section at={remote} />);
    expect(await screen.findByText(NEWS.says)).toBeTruthy();
  });

  it("says why when the rules can't be read", async () => {
    fetchOnHub.mockResolvedValue(reply(500, { error: "The hub is busy." }));
    render(<Section />);
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mail sorting" })).toBeTruthy();
  });
});
