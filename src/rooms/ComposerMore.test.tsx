import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/store";
import { useDmVoiceEntries } from "../voice/DmVoice";
import { useMic } from "../voice/mic";
import { useVoiceStore } from "../voice/store";
import { ComposerMore } from "./ComposerMore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));

const key = "local/atlas";

/** As the DM's composer has it: the emoji, and its voice. */
function More({ onEmoji = () => {} }: { onEmoji?: (e: string) => void }) {
  return <ComposerMore label="More for Atlas" onEmoji={onEmoji} more={useDmVoiceEntries(key, "Atlas")} />;
}

const items = () => [...document.querySelectorAll('[role^="menuitem"]')].map((e) => e.textContent);

beforeEach(() => {
  useMic.setState({ talk: null, hold: null, pressed: false, replying: 0, problem: null });
  useSettings.setState({ writtenReplies: [], loaded: true });
  useVoiceStore.setState({ here: true });
});
afterEach(cleanup);

describe("a narrow composer's overflow menu", () => {
  it("holds the emoji and the voice controls its buttons fold away", () => {
    render(<More />);
    fireEvent.click(screen.getByRole("button", { name: "More for Atlas" }));
    const said = items().join(" | ");
    expect(said).toContain("Add an emoji");
    expect(said).toContain("Talk with Atlas");
    expect(said).toContain("Hold to talk");
    expect(said).toContain("Atlas answers aloud");
    expect(said).toContain("Atlas answers in writing");
  });

  it("starts a spoken conversation, and says how to end it after", () => {
    render(<More />);
    fireEvent.click(screen.getByRole("button", { name: "More for Atlas" }));
    act(() => fireEvent.click(screen.getByText("Talk with Atlas")));
    expect(useMic.getState().talk).toBe(key);
    fireEvent.click(screen.getByRole("button", { name: "More for Atlas" }));
    expect(items().join(" | ")).toContain("End the conversation with Atlas");
  });

  it("opens the emoji picker from its own button", async () => {
    render(<More />);
    fireEvent.click(screen.getByRole("button", { name: "More for Atlas" }));
    act(() => fireEvent.click(screen.getByText("Add an emoji")));
    expect(await screen.findByRole("dialog", { name: "Emoji" })).toBeTruthy();
  });

  it("is only the emoji where voice doesn't run", () => {
    useVoiceStore.setState({ here: false });
    render(<More />);
    fireEvent.click(screen.getByRole("button", { name: "More for Atlas" }));
    expect(items()).toEqual(["Add an emoji"]);
  });
});
