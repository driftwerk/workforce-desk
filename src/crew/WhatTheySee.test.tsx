import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent, HubAccount } from "../chat/types";
import type { KnowsHeld, KnowsRule, KnowsView } from "../hub/knows";
import { placesSaid } from "./places";
import { narrows } from "./WhatTheySee";
import { forgetLinks, WhatTheySee } from "./WhatTheySee";

const api = {
  rules: vi.fn(),
  rule: vi.fn(),
  setRule: vi.fn(),
  choose: vi.fn(),
  log: vi.fn(),
};
const linkKnows = vi.fn();
const here = vi.hoisted(() => ({ linker: true }));

vi.mock("../hub/knows", async (original) => ({
  ...(await original<typeof import("../hub/knows")>()),
  knowsOf: () => api,
  knowsLinker: () => (here.linker ? (...a: unknown[]) => linkKnows(...a) : null),
}));

const local: HubAccount = { id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" };
const driftwerk: HubAccount = { id: "dw", label: "Driftwerk", url: "https://hub.example", local: false, revision: "t" };
const ledger: Agent = { hubId: "local", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false };
const allan: Agent = { hubId: "dw", id: "Allan", name: "Allan", model: null, provider: null, isDefault: false };

const NONE: KnowsHeld = { items: 0, transcripts: 0, sessions: 0, by_kind: {} };
const ruleOf = (agent: string, over: Partial<KnowsRule> = {}): KnowsRule => ({
  agent,
  places: [],
  transcripts: false,
  digest: "off",
  revision: 1,
  changedAt: null,
  ...over,
});
const viewOf = (rule: KnowsRule, heldOutside = NONE): KnowsView => ({ rule, heldOutside, sharedToday: [] });

let kept: KnowsView;

beforeEach(() => {
  forgetLinks();
  here.linker = true;
  linkKnows.mockReset();
  linkKnows.mockResolvedValue({ kind: "kept", agent: "allan" });
  vi.clearAllMocks();
  kept = viewOf(ruleOf("local/ledger"));
  api.rule.mockImplementation(() => Promise.resolve(kept));
  api.rules.mockImplementation(() => Promise.resolve([kept.rule]));
  api.setRule.mockImplementation((agent: string, b: { places: string[]; transcripts: boolean; digest: KnowsRule["digest"] }) => {
    kept = viewOf(ruleOf(agent, b), kept.heldOutside);
    return Promise.resolve({ rule: kept.rule, heldOutside: kept.heldOutside });
  });
  api.choose.mockResolvedValue({ choice: "keep", covered: 0 });
  api.log.mockResolvedValue([]);
  useChat.setState({ hubs: [local, driftwerk], roster: [ledger, allan] });
});
afterEach(cleanup);

const show = async (agent = ledger, hub = local) => {
  render(<WhatTheySee agent={agent} hub={hub} />);
  await screen.findByRole("radio", { name: /Everything/ });
};

describe("What they see", () => {
  it("is set to everything, with the rest of the rule as it was", async () => {
    kept = viewOf(ruleOf("local/ledger", { transcripts: true, digest: "live" }));
    await show();
    expect(screen.getByRole("radio", { name: /Only their own work/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Everything/ }));
    await waitFor(() => expect(api.setRule).toHaveBeenCalledWith("local/ledger", { places: ["all"], transcripts: true, digest: "live" }));
    expect(linkKnows).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Everything/ }).getAttribute("aria-checked")).toBe("true"));
  });

  it("turns transcripts on and picks the digest", async () => {
    await show();
    fireEvent.click(screen.getByRole("switch", { name: "Include transcripts" }));
    await waitFor(() => expect(api.setRule).toHaveBeenLastCalledWith("local/ledger", { places: [], transcripts: true, digest: "off" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Include transcripts" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("radio", { name: "Daily" }));
    await waitFor(() => expect(api.setRule).toHaveBeenLastCalledWith("local/ledger", { places: [], transcripts: true, digest: "daily" }));
  });

  it("asks before deleting what a narrowed rule no longer covers, with Keep focused, and Escape keeps", async () => {
    kept = viewOf(ruleOf("local/ledger", { places: ["all"], transcripts: true }));
    api.setRule.mockImplementationOnce((agent: string, b: { places: string[]; transcripts: boolean }) => {
      kept = viewOf(ruleOf(agent, b), { items: 1032, transcripts: 1032, sessions: 14, by_kind: { transcript: 1032 } });
      return Promise.resolve({ rule: kept.rule, heldOutside: kept.heldOutside });
    });
    await show();
    fireEvent.click(screen.getByRole("switch", { name: "Include transcripts" }));
    const dialog = await screen.findByRole("dialog", { name: "Ledger keeps what Desk already shared?" });
    expect(dialog.textContent).toContain("Desk stopped sharing transcripts with Ledger. They hold 1,032 transcript exchanges from 14 sessions.");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep what they have" })));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(api.choose).toHaveBeenCalledWith("local/ledger", "keep"));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Kept, it is said once and can still be deleted later: no asking again.
    expect(await screen.findByText(/that they no longer see/)).toBeTruthy();
  });

  it("doesn't ask again about what was kept earlier when a change adds nothing to it", async () => {
    const earlier: KnowsHeld = { items: 40, transcripts: 0, sessions: 2, by_kind: { account: 40 } };
    kept = viewOf(ruleOf("local/ledger", { places: ["all"], transcripts: true }), earlier);
    await show();
    fireEvent.click(screen.getByRole("switch", { name: "Include transcripts" }));
    await waitFor(() => expect(api.setRule).toHaveBeenCalledWith("local/ledger", { places: ["all"], transcripts: false, digest: "off" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Include transcripts" }).getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("deletes them when asked", async () => {
    kept = viewOf(ruleOf("local/ledger"), { items: 3, transcripts: 0, sessions: 1, by_kind: { account: 3 } });
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Delete them…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete them" }));
    await waitFor(() => expect(api.choose).toHaveBeenCalledWith("local/ledger", "delete"));
  });

  it("links an agent on another hub before its rule, and keeps the rule by the id its hub gave", async () => {
    kept = viewOf(ruleOf("dw/Allan"));
    linkKnows.mockResolvedValue({ kind: "kept", agent: "allan" });
    await show(allan, driftwerk);
    fireEvent.click(screen.getByRole("radio", { name: /Everything/ }));
    await waitFor(() => expect(api.setRule).toHaveBeenCalledWith("dw/allan", { places: ["all"], transcripts: false, digest: "off" }));
    expect(linkKnows).toHaveBeenCalledWith("dw", "Allan");
    expect(linkKnows.mock.invocationCallOrder[0]).toBeLessThan(api.setRule.mock.invocationCallOrder[0]!);
    // Linked once a run.
    fireEvent.click(screen.getByRole("radio", { name: "Live" }));
    await waitFor(() => expect(api.setRule).toHaveBeenCalledTimes(2));
    expect(linkKnows).toHaveBeenCalledTimes(1);
  });

  it("says in plain words when the agent's hub won't take Desk work, and keeps nothing", async () => {
    kept = viewOf(ruleOf("dw/Allan"));
    linkKnows.mockResolvedValue({ kind: "notAllowed", status: 403, error: "This hub's admin has turned off sharing Desk work with its agents." });
    await show(allan, driftwerk);
    fireEvent.click(screen.getByRole("radio", { name: /Everything/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Driftwerk’s admin has turned this off.");
    expect(api.setRule).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /Only their own work/ }).getAttribute("aria-checked")).toBe("true");

    linkKnows.mockResolvedValue({ kind: "notAllowed", status: 403, error: "That agent doesn't take Desk work here." });
    fireEvent.click(screen.getByRole("radio", { name: /Everything/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Allan doesn’t take Desk work on Driftwerk."));
  });

  it("leaves an agent elsewhere as it was in a window that can't link it", async () => {
    here.linker = false;
    kept = viewOf(ruleOf("dw/Allan"));
    await show(allan, driftwerk);
    fireEvent.click(screen.getByRole("radio", { name: /Everything/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("This is set in Desk’s main window.");
    expect(api.setRule).not.toHaveBeenCalled();
  });

  it("after a restart, reads an agent elsewhere's rule by the id its hub gave", async () => {
    kept = viewOf(ruleOf("dw/allan", { places: ["all"], transcripts: true }));
    api.rule.mockImplementation((agent: string) => Promise.resolve(agent === "dw/allan" ? kept : viewOf(ruleOf(agent))));
    await show(allan, driftwerk);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Everything/ }).getAttribute("aria-checked")).toBe("true"));
    expect(api.rule).toHaveBeenCalledWith("dw/allan");
    // Turned all off, it is the rule that shares that is changed.
    fireEvent.click(screen.getByRole("radio", { name: /Only their own work/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Include transcripts" }));
    await waitFor(() => expect(api.setRule).toHaveBeenCalledTimes(2));
    expect(api.setRule.mock.calls.every(([agent]) => agent === "dw/allan")).toBe(true);
  });

  it("moves between the choices with the arrows without changing what is shared", async () => {
    await show();
    const own = screen.getByRole("radio", { name: /Only their own work/ });
    own.focus();
    fireEvent.keyDown(own, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Chosen places/ }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Everything/ }));
    expect(api.setRule).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("changes nothing when a later delete is cancelled", async () => {
    kept = viewOf(ruleOf("local/ledger"), { items: 3, transcripts: 0, sessions: 1, by_kind: { account: 3 } });
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Delete them…" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.choose).not.toHaveBeenCalled();
  });

  it("doesn't ask when a change shares more", async () => {
    kept = viewOf(ruleOf("local/ledger"), { items: 40, transcripts: 0, sessions: 1, by_kind: { account: 40 } });
    await show();
    fireEvent.click(screen.getByRole("radio", { name: /Everything/ }));
    await waitFor(() => expect(api.setRule).toHaveBeenCalled());
    await waitFor(() => expect(api.rule).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("picks places from a filtered list", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    const dialog = await screen.findByRole("dialog", { name: "What Ledger sees" });
    expect((within(dialog).getByRole("button", { name: "Use these" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Filter places" }), { target: { value: "all" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Allan/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Use these" }));
    await waitFor(() => expect(api.setRule).toHaveBeenCalledWith("local/ledger", { places: ["agent:dw/Allan"], transcripts: false, digest: "off" }));
    expect(await screen.findByText("Allan")).toBeTruthy();
  });
});

describe("narrows", () => {
  it("is a change that shares less", () => {
    const r = (places: string[], transcripts = false) => ({ places, transcripts });
    expect(narrows(r(["all"], true), r(["all"], false))).toBe(true);
    expect(narrows(r(["all"]), r(["group:a"]))).toBe(true);
    expect(narrows(r(["group:a", "group:b"]), r(["group:b"]))).toBe(true);
    expect(narrows(r(["group:a"]), r([]))).toBe(true);
    expect(narrows(r(["group:a"]), r(["group:a", "group:b"]))).toBe(false);
    expect(narrows(r([]), r(["all"], true))).toBe(false);
  });
});

describe("placesSaid", () => {
  it("names groups, boards and grids, and counts many sessions", () => {
    const known = new Map([
      ["group:p", { place: "group:p", kind: "group" as const, name: "Patchwork" }],
      ["board:a", { place: "board:a", kind: "board" as const, name: "Atlas" }],
    ]);
    expect(placesSaid(["group:p", "board:a", "session:1", "session:2", "session:3"], known)).toBe("Patchwork · Atlas board · 3 sessions");
    expect(placesSaid(["group:gone"], known)).toBe("a group that’s gone");
  });
});
