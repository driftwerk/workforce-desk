import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings, type Settings } from "../platform";
import { Chat } from "./Chat";
import { useSettings } from "./store";

vi.mock("../platform", () => ({ loadSettings: vi.fn(), saveSettings: vi.fn(() => Promise.resolve()) }));

const older = { theme: "system", voice: false, voiceEngine: "cascade" } as Partial<Settings> as Settings;

afterEach(cleanup);

describe("Settings → Chat", () => {
  it("turns emoticons into emoji unless turned off, older settings files included, and saves the choice", async () => {
    vi.mocked(loadSettings).mockResolvedValue(older);
    await useSettings.getState().load();
    expect(useSettings.getState().emoticons).toBe(true);
    render(<Chat />);
    const toggle = screen.getByRole("checkbox", { name: /Turn emoticons into emoji as you type/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(useSettings.getState().emoticons).toBe(false);
    expect(vi.mocked(saveSettings).mock.lastCall![0]).toMatchObject({ emoticons: false });
    vi.mocked(loadSettings).mockResolvedValue({ ...older, emoticons: false });
    await useSettings.getState().load();
    expect(useSettings.getState().emoticons).toBe(false);
  });
});
