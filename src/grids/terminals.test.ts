import { describe, expect, it, vi } from "vitest";
import type { Session, TerminalInfo } from "../hub/types";
import { describeTerminal, heardTerminals, terminalEnv, trackedIn, useTerminals } from "./terminals";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  inApp: false,
  claudePluginDir: vi.fn(async () => "/Applications/Desk.app/Contents/Resources/claude-plugin"),
  programsUnder: vi.fn(async () => []),
}));

const terminal = (id: string, over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  name: "acme-web",
  cwd: "/work/acme-web",
  envKeys: ["CLAUDE_CODE_PLUGIN_DIRS", "DESK_HOOK_TOKEN"],
  shell: "/bin/zsh",
  state: "running",
  live: true,
  exitCode: null,
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

describe("grid terminals", () => {
  it("follow what the hub announces", () => {
    heardTerminals({ type: "snapshot", sessions: [], restore: [], rooms: [], terminals: [terminal("a"), terminal("b")] });
    expect(useTerminals.getState().known).toBe(true);
    heardTerminals({ type: "terminal", terminal: terminal("a", { cwd: "/work/atlas", live: false, state: "exited", exitCode: 1 }) });
    heardTerminals({ type: "terminalRemoved", id: "b" });
    expect(Object.keys(useTerminals.getState().byId)).toEqual(["a"]);
    expect(useTerminals.getState().byId.a).toMatchObject({ cwd: "/work/atlas", state: "exited" });
  });

  it("carry Desk's plugin folder, and leave the hooks' token to the hub", async () => {
    const env = await terminalEnv();
    expect(env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: "/Applications/Desk.app/Contents/Resources/claude-plugin" });
  });

  it("say what runs in them, and recognise Codex by its process", () => {
    expect(describeTerminal(terminal("a"), undefined)).toMatchObject({ shell: "zsh", running: null, codex: false });
    expect(describeTerminal(terminal("a"), ["zsh", "node", "codex"])).toMatchObject({ shell: "zsh", running: "node", codex: true });
    expect(describeTerminal(terminal("a"), ["zsh", "claude", "sh"])).toMatchObject({ running: "claude", claude: true });
  });

  it("know the session a terminal hosts while it runs", () => {
    const s = (id: string, over: Partial<Session>) => ({ id, live: true, terminalId: null, ...over }) as Session;
    const sessions = { x: s("x", { terminalId: "a" }), y: s("y", { terminalId: "b", live: false }) };
    expect(trackedIn(sessions, "a")?.id).toBe("x");
    expect(trackedIn(sessions, "b")).toBeNull();
    expect(trackedIn(sessions, null)).toBeNull();
  });
});
