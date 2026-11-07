import { afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ load: vi.fn<() => Promise<void>>() }));
const themes = vi.hoisted(() => ({ list: vi.fn<() => Promise<unknown[]>>() }));

vi.mock("../settings/store", () => ({ useSettings: { getState: () => ({ load: settings.load }) } }));
vi.mock("./custom", () => ({ loadCustomThemes: themes.list }));

import { customThemesRead, paintSavedTheme } from "./boot";
import { DAY } from "./builtin";
import { useThemeStore } from "./store";

afterEach(() => {
  useThemeStore.setState({ choice: "system", custom: [], systemDark: true });
  document.documentElement.removeAttribute("style");
});

describe("the theme before the first render", () => {
  it("is the saved one, painted, custom themes included", async () => {
    const mine = { ...DAY, id: "mine", name: "Mine", background: "#EEF2F6" };
    settings.load.mockImplementation(async () => useThemeStore.getState().setChoice("mine"));
    themes.list.mockResolvedValue([mine]);
    const theme = await paintSavedTheme();
    expect(theme.spec.id).toBe("mine");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#EEF2F6");
  });

  it("doesn't wait on a read that hangs, nor fail on one that fails", async () => {
    settings.load.mockReturnValue(new Promise(() => undefined));
    themes.list.mockRejectedValue(new Error("no folder"));
    const theme = await paintSavedTheme(20);
    // Auto with a dark system: Night.
    expect(theme.spec.id).toBe("night");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#111210");
  });

  it("hands the custom themes' first read to the shell once, then reads again", async () => {
    settings.load.mockResolvedValue(undefined);
    themes.list.mockResolvedValue([]);
    await paintSavedTheme();
    const again = vi.fn(() => Promise.resolve());
    await customThemesRead(again);
    expect(again).not.toHaveBeenCalled();
    expect(themes.list).toHaveBeenCalledTimes(1);
    await customThemesRead(again);
    expect(again).toHaveBeenCalledTimes(1);
  });
});
