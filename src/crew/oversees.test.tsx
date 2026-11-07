import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { useAgentConfigs } from "./agentBrain";
import { OverseesTheCrew } from "./OverseesTheCrew";

const ledger: Agent = { hubId: "local", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false };
const desk: Agent = { hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true };

const START = `[llm]\nprovider = "claude-code"\n`;

let file = START;
const fakeHub = () =>
  ({
    agentConfig: vi.fn(() => Promise.resolve(file)),
    saveAgentConfig: vi.fn((_id: string, toml: string) => {
      file = toml;
      return Promise.resolve();
    }),
    manager: vi.fn(() => Promise.resolve({ agentId: "desk", level: "watch" })),
    overview: vi.fn(() => Promise.resolve({ brief: null, counts: { working: 0, needsYou: 0, doneToday: 0 }, items: [] })),
    engines: vi.fn(() => Promise.resolve(ENGINES)),
  }) as unknown as DeskHub;

const caps = (line: "submit" | "paste" | "none") => ({ state: "hooks", approvals: "desk", resume: "byId", interrupt: "keys", plan: null, line, notes: [] });
/** Claude Code and Codex have Desk's line; Gemini CLI hasn't, and Cursor
 *  isn't installed. */
const ENGINES = [
  { engine: "claude", title: "Claude Code", program: "claude", installed: true, version: "2.1.300", signIn: { state: "unknown" }, views: ["terminal"], caps: { terminal: caps("submit") } },
  { engine: "codex", title: "Codex", program: "codex", installed: true, version: "0.80.0", signIn: { state: "unknown" }, views: ["desk", "terminal"], caps: { desk: caps("paste") } },
  { engine: "gemini", title: "Gemini CLI", program: "gemini", installed: true, version: "1", signIn: { state: "unknown" }, views: ["terminal"], caps: { terminal: caps("none") } },
  { engine: "cursor", title: "Cursor CLI", program: null, installed: false, version: null, signIn: { state: "unknown" }, views: ["terminal"], caps: { terminal: caps("submit") } },
];

const oversight = () => (parse(file) as { oversight?: Record<string, unknown> }).oversight;

const show = (hub: DeskHub, toml = START) => {
  file = toml;
  useDesk.setState({ hub });
  useAgentConfigs.setState({ configs: { "local/ledger": toml } });
  render(<OverseesTheCrew agent={ledger} />);
};

beforeEach(() => {
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }], roster: [desk, ledger] });
  useOverview.setState({ manager: { agentId: "desk", level: "watch" }, managerSupport: "yes", overviewSupport: "unknown" });
});
afterEach(cleanup);

describe("Oversees the crew", () => {
  it("asks before taking over from the current overseer, then writes only this agent's config", async () => {
    const hub = fakeHub();
    show(hub);
    expect(screen.getByText("Desk oversees the crew now.")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Oversees the crew" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("dialog", { name: "Make Ledger the overseer?" })).toBeTruthy();
    expect(screen.getByText(/Desk oversees the crew now — make Ledger the overseer instead\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep Desk" }));
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make Ledger the overseer" })));
    await waitFor(() => expect(hub.saveAgentConfig).toHaveBeenCalledTimes(1));
    expect((hub.saveAgentConfig as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("ledger");
    expect(oversight()).toMatchObject({ enabled: true, level: "watch" });
    expect((parse(file) as { llm: unknown }).llm).toEqual({ provider: "claude-code" });
    expect(hub.manager).toHaveBeenCalled();
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("says a group's boss oversees only its group, and switching it off names the group no more", async () => {
    useSettings.setState({ groups: [{ id: "g-acme", name: "Acme", collapsed: false, items: ["agent:local/ledger"] }] });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\ngroup = "g-acme"\n`);
    expect(screen.getByText("Oversees only Acme: its sessions and agents.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Oversees the crew" })));
    await waitFor(() => expect(oversight()?.enabled).toBe(false));
    expect("group" in oversight()!).toBe(false);
    useSettings.setState({ groups: [] });
  });

  it("shows Act's own rules only at Act, and saves each choice as it's made", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "suggest" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "suggest"\n`);
    expect(screen.getByRole("radio", { name: /Suggest/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("heading", { name: "What Ledger may do without asking" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /Act/ })));
    expect(screen.getByRole("heading", { name: "What Ledger may do without asking" })).toBeTruthy();
    expect(screen.getByText(/Ledger always asks you first before pushing code/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Hand out work/ })));
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Crew in your workspaces/ })));
    await waitFor(() => expect(oversight()).toMatchObject({ level: "act", act: { hand_out_work: true }, track: { workspaces: true } }));
  });

  it("says in plain words what's wrong with a number or time, and saves it once it's right", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "watch" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\n`);
    const waiting = screen.getByRole("textbox", { name: "Minutes waiting" });
    fireEvent.change(waiting, { target: { value: "0" } });
    fireEvent.blur(waiting);
    expect(screen.getByRole("alert").textContent).toBe("Use 1 to 1440 minutes (a day).");
    expect(waiting.getAttribute("aria-invalid")).toBe("true");
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    fireEvent.change(waiting, { target: { value: "12" } });
    await act(async () => fireEvent.keyDown(waiting, { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 12 } }));

    const evening = screen.getByRole("textbox", { name: "End-of-day summary time" }) as HTMLInputElement;
    expect(evening.disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: "End-of-day summary at" })));
    await waitFor(() => expect(oversight()).toMatchObject({ summaries: { evening: "18:00" } }));
    fireEvent.change(evening, { target: { value: "6pm" } });
    fireEvent.blur(evening);
    expect(screen.getByRole("alert").textContent).toBe("Use a time like 09:00 or 18:30.");

    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: "Something has waited on you for" })));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 0 } }));
    expect((screen.getByRole("textbox", { name: "Minutes waiting" }) as HTMLInputElement).value).toBe("12");
  });

  it("spends check-ins by the hour, under a ceiling for the day", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "watch" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nmax_checkins_per_day = 150\n`);
    expect((screen.getByRole("textbox", { name: "Check-ins a day" }) as HTMLInputElement).value).toBe("150");
    const hourly = screen.getByRole("textbox", { name: "Check-ins an hour" }) as HTMLInputElement;
    expect(hourly.value).toBe("6");
    fireEvent.change(hourly, { target: { value: "61" } });
    fireEvent.blur(hourly);
    expect(screen.getByRole("alert").textContent).toBe("Use a whole number from 1 to 60.");
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    fireEvent.change(hourly, { target: { value: "4" } });
    await act(async () => fireEvent.keyDown(hourly, { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ max_checkins_per_hour: 4, max_checkins_per_day: 150 }));
  });

  it("reads minutes of 0 as off, and turns them back on with the last minutes, else 5 and 30", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "watch" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nwake = { waiting_minutes = 0, quiet_minutes = 0 }\n`);
    const waitingBox = () => screen.getByRole("checkbox", { name: "Something has waited on you for" }) as HTMLInputElement;
    const quietBox = () => screen.getByRole("checkbox", { name: "Work has gone quiet while working for" }) as HTMLInputElement;
    const quiet = () => screen.getByRole("textbox", { name: "Minutes quiet" }) as HTMLInputElement;
    expect(waitingBox().checked).toBe(false);
    expect(quietBox().checked).toBe(false);
    expect((screen.getByRole("textbox", { name: "Minutes waiting" }) as HTMLInputElement).value).toBe("5");
    expect(quiet().value).toBe("30");
    expect(quiet().disabled).toBe(true);

    await act(async () => fireEvent.click(quietBox()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { quiet_minutes: 30, waiting_minutes: 0 } }));
    expect(quietBox().checked).toBe(true);

    fireEvent.change(quiet(), { target: { value: "45" } });
    await act(async () => fireEvent.keyDown(quiet(), { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { quiet_minutes: 45 } }));
    await act(async () => fireEvent.click(quietBox()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { quiet_minutes: 0 } }));
    expect(quietBox().checked).toBe(false);
    expect(quiet().value).toBe("45");
    await act(async () => fireEvent.click(quietBox()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { quiet_minutes: 45 } }));

    await act(async () => fireEvent.click(waitingBox()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 5, quiet_minutes: 45 } }));
  });

  it("turns minutes back on with what they were, not something typed that can't be used", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "watch" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nwake = { waiting_minutes = 0 }\n`);
    const box = () => screen.getByRole("checkbox", { name: "Something has waited on you for" }) as HTMLInputElement;
    const field = () => screen.getByRole("textbox", { name: "Minutes waiting" }) as HTMLInputElement;
    await act(async () => fireEvent.click(box()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 5 } }));
    fireEvent.change(field(), { target: { value: "lots" } });
    fireEvent.blur(field());
    expect(screen.getByRole("alert").textContent).toBe("Use a whole number of minutes.");
    await act(async () => fireEvent.click(box()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 0 } }));
    await waitFor(() => expect(field().value).toBe("5"));
    await act(async () => fireEvent.click(box()));
    await waitFor(() => expect(oversight()).toMatchObject({ wake: { waiting_minutes: 5 } }));
  });

  it("says how it works, and writes each choice to [oversight.work] as the hub reads it", async () => {
    useOverview.setState({ manager: { agentId: "ledger", level: "act" } });
    const hub = fakeHub();
    show(hub, `${START}\n[oversight]\nenabled = true\nlevel = "act"\n`);
    expect(screen.getByRole("heading", { name: "How Ledger works" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Prefer real sessions/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /Only what I hand it/ }).getAttribute("aria-checked")).toBe("true");
    const parallel = screen.getByRole("textbox", { name: "Sessions at once" }) as HTMLInputElement;
    expect(parallel.value).toBe("4");
    // The engines a session of it could run on: installed, with Desk's line.
    const engine = screen.getByRole("combobox", { name: "New sessions run" }) as HTMLSelectElement;
    await waitFor(() => expect([...engine.options].map((o) => o.textContent)).toEqual(["Claude Code", "Codex"]));

    fireEvent.change(parallel, { target: { value: "13" } });
    fireEvent.blur(parallel);
    expect(screen.getByRole("alert").textContent).toBe("How many sessions it may run at once must be a whole number from 1 to 12.");
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    fireEvent.change(parallel, { target: { value: "6" } });
    await act(async () => fireEvent.keyDown(parallel, { key: "Enter" }));
    await waitFor(() => expect(oversight()).toMatchObject({ work: { parallel: 6 } }));

    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /Every session it can/ })));
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Prefer real sessions/ })));
    await act(async () => fireEvent.change(engine, { target: { value: "codex" } }));
    const turns = screen.getByRole("textbox", { name: "Work turns an hour" });
    fireEvent.change(turns, { target: { value: "90" } });
    await act(async () => fireEvent.blur(turns));
    await waitFor(() =>
      expect(oversight()?.work).toEqual({ prefer_sessions: false, parallel: 6, take_on: "all", engine: "codex", max_turns_per_hour: 90 }),
    );
    expect(file).toContain("[oversight.work]");
  });

  it("says a watching overseer runs no sessions", () => {
    show(fakeHub(), `${START}\n[oversight]\nenabled = true\n`);
    expect(screen.getByText("At Watch, Ledger runs no sessions. Set it to Suggest or Act to hand it work.")).toBeTruthy();
  });

  it("isn't offered by a hub that has no overseer", () => {
    useOverview.setState({ managerSupport: "no", manager: null });
    show(fakeHub());
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("won't change a config it can't read", () => {
    const hub = fakeHub();
    show(hub, "[llm\nprovider =");
    expect(screen.getByText("Their settings file has a mistake in it, so Desk won’t change it.")).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  });
});
