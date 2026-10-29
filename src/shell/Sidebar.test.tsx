import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/store";
import { DEFAULT_SHORTCUTS } from "../shortcuts/keys";
import { Sidebar } from "./Sidebar";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

afterEach(cleanup);

const none = () => {};
const sidebar = () => render(<Sidebar onAsk={none} onNewSession={none} onNewRoom={none} onNewCrew={none} onSettings={none} />);

describe("Sidebar", () => {
  it("shows each shortcut's configured keys", () => {
    useSettings.setState({ shortcuts: {}, keys: DEFAULT_SHORTCUTS });
    sidebar();
    expect(screen.getByRole("button", { name: /Ask anyone/ }).textContent).toBe("Ask anyone ⌃⇧K");
    expect(screen.getByRole("button", { name: "New session" }).textContent).toBe("New session ⌘N");
    expect(screen.getByRole("button", { name: /^Settings/ }).textContent).toBe("Settings ⌘,");
    cleanup();
    useSettings.getState().set({ shortcuts: { ask: "Alt+Space", newSession: "Super+J", settings: "Control+Alt+Comma" } });
    sidebar();
    expect(screen.getByRole("button", { name: /Ask anyone/ }).textContent).toBe("Ask anyone ⌥Space");
    expect(screen.getByRole("button", { name: "New session" }).textContent).toBe("New session ⌘J");
    expect(screen.getByRole("button", { name: /^Settings/ }).textContent).toBe("Settings ⌃⌥,");
  });
});
