import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings, type Settings } from "../platform";
import { useSettings } from "../settings/store";
import { NIGHT } from "../theme/builtin";
import { DEFAULT_PICK, useThemeStore } from "../theme/store";
import type { ThemeSpec } from "../theme/tokens";
import { ThemeSwitcher } from "./ThemeSwitcher";

vi.mock("../platform", () => ({ loadSettings: vi.fn(), saveSettings: vi.fn(() => Promise.resolve()) }));

const DUSK: ThemeSpec = { ...NIGHT, id: "acme-dusk", name: "Acme Dusk", background: "#1A1B26", signal: "#7AA2F7", overrides: {} };

const saved = (theme: string, themePick?: string) =>
  ({ theme, themePick, tuple: false, newAgent: null, defaultVoice: { provider: "fish_audio" }, agentVoices: {}, voice: false, voiceEngine: "cascade", shortcuts: {} }) as Settings;

beforeEach(() => {
  useThemeStore.setState({ choice: "system", pick: DEFAULT_PICK, custom: [DUSK] });
  useSettings.setState({ loaded: false });
  vi.mocked(saveSettings).mockClear();
});
afterEach(cleanup);

const look = (onSettings = () => {}) => render(<ThemeSwitcher onSettings={onSettings} />);
const radio = (name: string) => screen.getByRole("radio", { name });
const chooser = () => screen.getByRole("button", { name: /^Theme:/ });

describe("the sidebar's look", () => {
  it("offers Auto, Night and Day, with Harbour in the chooser until another is picked", () => {
    look();
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Auto", "Night", "Day"]);
    expect(radio("Auto").getAttribute("aria-checked")).toBe("true");
    expect(chooser().textContent).toContain("Harbour");
    expect(chooser().className).not.toContain(" on");
    expect(chooser().getAttribute("aria-expanded")).toBe("false");
  });

  it("lists every theme but Night and Day, where each came from, and picks one", () => {
    look();
    fireEvent.click(chooser());
    const list = screen.getByRole("listbox", { name: "Themes" });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["HarbourBuilt in", "Acme DuskYours"]);
    expect(options.every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    fireEvent.click(options[1]!);
    expect(useThemeStore.getState()).toMatchObject({ choice: "acme-dusk", pick: "acme-dusk" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(list.isConnected).toBe(false);
    expect(screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(chooser().textContent).toContain("Acme Dusk");
    expect(chooser().className).toContain(" on");
    expect(document.activeElement).toBe(chooser());
  });

  it("Auto, Night or Day goes back, and the chooser keeps its theme", () => {
    useThemeStore.setState({ choice: "acme-dusk", pick: "acme-dusk" });
    look();
    fireEvent.click(radio("Night"));
    expect(useThemeStore.getState()).toMatchObject({ choice: "night", pick: "acme-dusk" });
    expect(radio("Night").getAttribute("aria-checked")).toBe("true");
    expect(chooser().textContent).toContain("Acme Dusk");
    expect(chooser().className).not.toContain(" on");
    fireEvent.click(chooser());
    expect(screen.getAllByRole("option").every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("works from the keyboard: arrows, Enter, and Escape back to the chooser", () => {
    look();
    fireEvent.keyDown(chooser(), { key: "ArrowDown" });
    const list = screen.getByRole("listbox");
    expect(document.activeElement).toBe(list);
    const active = () => document.getElementById(list.getAttribute("aria-activedescendant")!)?.textContent;
    expect(active()).toContain("Harbour");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toContain("Acme Dusk");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toContain("Acme Dusk");
    fireEvent.keyDown(list, { key: "Home" });
    expect(active()).toContain("Harbour");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(chooser());
    expect(useThemeStore.getState().choice).toBe("system");

    fireEvent.click(chooser());
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "End" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(useThemeStore.getState().choice).toBe("acme-dusk");

    fireEvent.keyDown(radio("Auto"), { key: "ArrowRight" });
    expect(useThemeStore.getState().choice).toBe("night");
  });

  it("sends you to Settings to import or edit themes", () => {
    const onSettings = vi.fn();
    look(onSettings);
    fireEvent.click(chooser());
    fireEvent.click(screen.getByRole("button", { name: "Import or edit themes in Settings…" }));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("a picked theme that's gone shows Harbour", () => {
    useThemeStore.setState({ choice: "night", pick: "deleted-one" });
    look();
    expect(chooser().textContent).toContain("Harbour");
  });
});

describe("the saved look", () => {
  it("an older Desk's Harbour shows as picked in the chooser", async () => {
    vi.mocked(loadSettings).mockResolvedValue(saved("harbour"));
    await useSettings.getState().load();
    expect(useThemeStore.getState()).toMatchObject({ choice: "harbour", pick: "harbour" });
    look();
    expect(chooser().className).toContain(" on");
    expect(screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("Auto stays Auto and the chooser comes back as it was", async () => {
    vi.mocked(loadSettings).mockResolvedValue(saved("system", "acme-dusk"));
    await useSettings.getState().load();
    expect(useThemeStore.getState()).toMatchObject({ choice: "system", pick: "acme-dusk" });
    look();
    expect(radio("Auto").getAttribute("aria-checked")).toBe("true");
    expect(chooser().textContent).toContain("Acme Dusk");
  });

  it("an older file with neither keeps following the system", async () => {
    vi.mocked(loadSettings).mockResolvedValue(saved("system"));
    await useSettings.getState().load();
    expect(useThemeStore.getState()).toMatchObject({ choice: "system", pick: "harbour" });
  });

  it("saves the choice and the chooser's theme together", async () => {
    vi.mocked(loadSettings).mockResolvedValue(saved("system"));
    await useSettings.getState().load();
    act(() => useThemeStore.getState().setChoice("acme-dusk"));
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "acme-dusk", themePick: "acme-dusk" }));
    act(() => useThemeStore.getState().setChoice("day"));
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "day", themePick: "acme-dusk" }));
  });
});
