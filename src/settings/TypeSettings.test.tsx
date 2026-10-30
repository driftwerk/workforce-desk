import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTheme } from "../platform";
import { NIGHT } from "../theme/builtin";
import { useThemeStore } from "../theme/store";
import { parseTheme } from "../theme/toml";
import { cssVariables, derive } from "../theme/tokens";
import { Appearance } from "./Appearance";
import { DESK_FONTS, FontPicker, fontOptions, matching } from "./FontPicker";
import { sizeFor } from "./TypeSettings";

vi.mock("../platform", () => ({
  writeTheme: vi.fn(() => Promise.resolve()),
  revealThemes: vi.fn(() => Promise.resolve()),
  systemFonts: vi.fn(() => Promise.resolve(["Georgia", "Inter", "Menlo", "Figtree Variable"])),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn(), writeTextFile: vi.fn() }));

beforeEach(() => {
  useThemeStore.setState({ choice: "night", custom: [], systemDark: true });
  vi.mocked(writeTheme).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const options = fontOptions(["Georgia", "Inter", "Menlo", "Figtree Variable"]);

describe("the font list", () => {
  it("has Desk's fonts first, then this computer's, each once", () => {
    expect(options.map((o) => o.name)).toEqual([...DESK_FONTS, "Georgia", "Inter", "Menlo"]);
    expect(options.filter((o) => o.desk).map((o) => o.name)).toEqual([...DESK_FONTS]);
  });

  it("matches on the name, case aside", () => {
    expect(matching(options, " mono ").map((o) => o.name)).toEqual(["Geist Mono Variable"]);
    expect(matching(options, "")).toHaveLength(options.length);
  });
});

describe("the font picker", () => {
  const picker = (onPick = vi.fn()) => {
    render(<FontPicker label="Headings" hint="titles and names" value="Figtree Variable" options={options} onPick={onPick} />);
    return onPick;
  };

  it("shows each font in its own face and searches by name", () => {
    picker();
    fireEvent.click(screen.getByRole("button", { name: /Headings/ }));
    const list = screen.getByRole("listbox", { name: "Headings font" });
    const georgia = within(list).getByRole("option", { name: /Georgia/ });
    expect(georgia.querySelector(".font-name")!.getAttribute("style")).toContain('"Georgia"');
    expect(within(list).getByRole("option", { name: /Figtree Variable/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "men" } });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["AaMenloThis computer"]);
    expect(screen.getByText("1 of 6 fonts matching “men”")).toBeTruthy();
  });

  it("moves with the arrows, picks with Enter and closes with Escape", () => {
    const onPick = picker();
    const button = screen.getByRole("button", { name: /Headings/ });
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const search = screen.getByRole("combobox");
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: /Geist Mono/ }).id);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("Geist Mono Variable");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

describe("type in Appearance", () => {
  it("sets each role's font and each kind of text's size, saved with the theme", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Appearance />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Code and terminals/ })));
    fireEvent.click(await screen.findByRole("option", { name: /Menlo/ }));
    fireEvent.change(screen.getByRole("slider", { name: "Chats and documents" }), { target: { value: "16.5" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Code and terminals size in pixels" }), { target: { value: "15" } });
    const preview = screen.getByTestId("type-preview");
    expect(preview.querySelector("pre")!.getAttribute("style")).toContain("font-size: 15px");
    await act(async () => vi.advanceTimersByTime(400));
    const [id, source] = vi.mocked(writeTheme).mock.calls.at(-1)!;
    const saved = parseTheme(id, source);
    expect(saved.fonts).toEqual({ ...NIGHT.fonts, mono: "Menlo", chatSize: 16.5, codeSize: 15 });
    await waitFor(() => expect(cssVariables(derive(saved))["--font-size-code"]).toBe("15px"));
  });

  it("keeps sizes in range, in half pixels", () => {
    expect(sizeFor("codeSize", 4)).toBe(9);
    expect(sizeFor("chatSize", 15.26)).toBe(15.5);
    expect(sizeFor("size", 40)).toBe(22);
  });
});
