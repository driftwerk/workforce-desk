import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "../chat/types";
import { agentKey } from "../chat/types";
import type { DeskHub } from "../hub/client";
import type { Provider } from "../hub/providers";
import { useDesk } from "../hub/store";
import { useProviders } from "../providers/store";
import { useAgentConfigs } from "./agentBrain";
import { Failover } from "./Failover";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

const agent = { hubId: "local", id: "ledger", name: "Ledger", model: null, provider: "claude-code", isDefault: false } as unknown as Agent;
const plan = (id: string, name: string, connected: boolean) =>
  ({ id, name, group: "plan", description: "", connected, connect: { kind: "login", fields: [] }, models: [{ id: "standard", name: "Std", description: "", default: true }], efforts: [], defaultEffort: null }) as unknown as Provider;

const setup = (config: string, chatgpt: boolean) => {
  const saveAgentConfig = vi.fn(async () => undefined);
  useDesk.setState({ hub: { agentConfig: async () => config, saveAgentConfig, providers: async () => [] } as unknown as DeskHub });
  useProviders.setState({ providers: [plan("claude-code", "Claude plan", true), plan("chatgpt", "ChatGPT plan", chatgpt)], fallback: false, loaded: true, loading: false, problem: null });
  useAgentConfigs.setState({ configs: { [agentKey(agent)]: config } });
  return saveAgentConfig;
};

beforeEach(() => useAgentConfigs.setState({ configs: {} }));
afterEach(cleanup);

it("waits and tells by default, and goes to the other provider when asked, in [llm] failover", async () => {
  const save = setup('[llm]\nprovider = "claude-code"\n', true);
  render(<Failover agent={agent} />);
  expect(screen.getByRole("radio", { name: "Wait and tell me" }).getAttribute("aria-checked")).toBe("true");
  await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Use another provider" })));
  expect(save).toHaveBeenCalledTimes(1);
  expect((save.mock.calls[0] as unknown as [string, string])[1]).toContain('failover = [ "chatgpt" ]');
  expect(screen.getByRole("radio", { name: "Use another provider" }).getAttribute("aria-checked")).toBe("true");
});

it("shows another provider as chosen when failover names one, and waits again by dropping it", async () => {
  const save = setup('[llm]\nprovider = "claude-code"\nfailover = ["chatgpt"]\n', true);
  render(<Failover agent={agent} />);
  expect(screen.getByRole("radio", { name: "Use another provider" }).getAttribute("aria-checked")).toBe("true");
  await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Wait and tell me" })));
  expect((save.mock.calls[0] as unknown as [string, string])[1]).not.toContain("failover");
});

it("disables the other provider, saying where to sign in, while it isn't connected", () => {
  setup('[llm]\nprovider = "claude-code"\n', false);
  render(<Failover agent={agent} />);
  expect((screen.getByRole("radio", { name: "Use another provider" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Sign in to ChatGPT plan in Settings → Providers to use it")).toBeTruthy();
});

it("is not there for an agent on an API key", () => {
  setup('[llm]\nprovider = "openrouter"\n', true);
  const { container } = render(<Failover agent={{ ...agent, provider: "openrouter" }} />);
  expect(container.textContent).toBe("");
});
