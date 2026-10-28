import { useEffect } from "react";
import { create } from "zustand";
import { agentKey, type Agent } from "../chat/types";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { useProviderList } from "../providers/store";
import { brainOf, type Brain } from "./brain";
import type { Provider } from "../hub/providers";

interface ConfigsState {
  /** Local agents' config.toml, by agent key, as last read or written. */
  configs: Record<string, string>;
  load: (hub: DeskHub, agent: Agent) => Promise<void>;
  put: (key: string, toml: string) => void;
}

export const useAgentConfigs = create<ConfigsState>((set) => ({
  configs: {},
  load: async (hub, agent) => {
    try {
      const toml = await hub.agentConfig(agent.id);
      set((s) => ({ configs: { ...s.configs, [agentKey(agent)]: toml } }));
    } catch {
      // The roster's provider and model stand in.
    }
  },
  put: (key, toml) => set((s) => ({ configs: { ...s.configs, [key]: toml } })),
}));

/** How a local agent thinks, as its config says, with its provider; null
 *  for agents elsewhere (their hub decides) or until the config is read. */
export function useAgentBrain(agent: Agent | undefined, local: boolean): { brain: Brain | null; provider: Provider | undefined } {
  const hub = useDesk((s) => s.hub);
  const { providers } = useProviderList();
  const key = agent ? agentKey(agent) : "";
  const config = useAgentConfigs((s) => s.configs[key]);
  useEffect(() => {
    if (hub && agent && local) void useAgentConfigs.getState().load(hub, agent);
  }, [hub, agent?.id, local]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!agent || !local || config === undefined) return { brain: null, provider: undefined };
  const brain = brainOf(config, providers, { provider: agent.provider, model: agent.model });
  return { brain, provider: providers.find((p) => p.id === brain.provider) };
}
