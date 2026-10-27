import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { writeTheme } from "../platform";
import { NIGHT } from "../theme/builtin";
import { useThemeStore } from "../theme/store";
import { parseTheme } from "../theme/toml";
import { derive } from "../theme/tokens";
import { Appearance } from "./Appearance";
import { applyEdit, isBuiltin, uniqueId } from "./editing";

vi.mock("../platform", () => ({
  writeTheme: vi.fn(() => Promise.resolve()),
  revealThemes: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn(), writeTextFile: vi.fn() }));

const written = () => vi.mocked(writeTheme).mock.calls;

beforeEach(() => {
  useThemeStore.setState({ choice: "night", custom: [], systemDark: true });
  vi.mocked(writeTheme).mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Appearance", () => {
  it("editing a built-in theme saves an editable copy", () => {
    vi.useFakeTimers();
    render(<Appearance />);
    fireEvent.click(screen.getByRole("button", { name: "Plum" }));

    const { choice, custom } = useThemeStore.getState();
    expect(custom.map((t) => t.id)).toEqual(["night-copy"]);
    expect(choice).toBe("night-copy");
    expect(writeTheme).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    expect(written()).toHaveLength(1);
    const [id, source] = written()[0]!;
    expect(isBuiltin(id)).toBe(false);
    const saved = parseTheme(id, source);
    expect([saved.name, saved.background, saved.signal]).toEqual(["Night copy", "#1A1423", NIGHT.signal]);
    expect(derive(saved).colors.surface).not.toBe(derive(NIGHT).colors.surface);
    expect(screen.getByLabelText("Theme file").textContent).toBe(source);
  });

  it("edits in quick succession are one write to the same file", () => {
    vi.useFakeTimers();
    render(<Appearance />);
    fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
    fireEvent.click(screen.getByRole("radio", { name: "Round" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Moss" } });
    act(() => vi.advanceTimersByTime(300));

    expect(written()).toHaveLength(1);
    const [id, source] = written()[0]!;
    const saved = parseTheme(id, source);
    expect([id, saved.name, saved.density, saved.corners]).toEqual(["night-copy", "Moss", "compact", "round"]);
    expect(derive(saved).colors.surface).toBe(derive(NIGHT).colors.surface);
  });

  it("a token override can be set and cleared", () => {
    vi.useFakeTimers();
    render(<Appearance />);
    fireEvent.click(screen.getByRole("button", { name: "Plum" }));
    fireEvent.click(screen.getByRole("button", { name: "needs you" }));
    fireEvent.change(screen.getByLabelText("blocked colour"), { target: { value: "#ff0000" } });
    expect(useThemeStore.getState().custom[0]?.overrides.blocked).toBe("#FF0000");
    fireEvent.click(screen.getByRole("button", { name: "Clear override" }));
    expect(useThemeStore.getState().custom[0]?.overrides.blocked).toBeUndefined();
  });

  it("closing the screen saves a pending edit", () => {
    vi.useFakeTimers();
    const view = render(<Appearance />);
    fireEvent.click(screen.getByRole("button", { name: "Mist" }));
    view.unmount();
    expect(written().map(([id]) => id)).toEqual(["night-copy"]);
  });

  it("imports a theme under a name no built-in uses", async () => {
    vi.mocked(open).mockResolvedValue("/Users/k/Downloads/Night");
    vi.mocked(readTextFile).mockResolvedValue("background = 1e1e2e\nforeground = cdd6f4\npalette = 4=#89b4fa\n");
    render(<Appearance />);
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));

    await waitFor(() => expect(writeTheme).toHaveBeenCalled());
    const [id, source] = written()[0]!;
    expect(id).toBe("night-2");
    expect(useThemeStore.getState().choice).toBe("night-2");
    expect(parseTheme(id, source)).toMatchObject({ name: "Night", background: "#1E1E2E", signal: "#89B4FA" });
  });
});

describe("theme edits", () => {
  it("never reuses a built-in id or the system choice", () => {
    expect(uniqueId("Night", ["night", "day", "harbour"])).toBe("night-2");
    expect(uniqueId("System", [])).toBe("system-2");
  });

  it("clearing a built-in's text drops its pinned text colour", () => {
    const next = applyEdit(NIGHT, { text: undefined }, ["night"]);
    expect(next.overrides.text).toBeUndefined();
    expect(next.id).toBe("night-copy");
  });
});
