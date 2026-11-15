import { useState } from "react";
import { agentKey, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import { useProviders } from "../providers/store";
import { plainError } from "../ui/plainError";
import { useAgentBrain, useAgentConfigs } from "./agentBrain";
import { OTHER_PLAN, usesAnotherProvider } from "./brain";
import { setAgentFailover } from "./local";

/** The "How they think" row for a subscription agent: when its accounts
 *  can't serve (a limit, a refused login), wait and tell the person, or go
 *  to the other plan. Wait is the default. */
export function Failover({ agent }: { agent: Agent }) {
  const desk = useDesk((s) => s.hub);
  const { brain } = useAgentBrain(agent, true);
  const config = useAgentConfigs((s) => s.configs[agentKey(agent)]);
  const providers = useProviders((s) => s.providers);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const own = brain?.provider;
  const other = own ? OTHER_PLAN[own] : undefined;
  if (!own || !other || config === undefined) return null;
  const otherProvider = providers.find((p) => p.id === other);
  const connected = !!otherProvider?.connected;
  const otherName = otherProvider?.name ?? other;
  const another = usesAnotherProvider(config, own);

  const choose = async (on: boolean) => {
    if (!desk || on === another) return;
    setBusy(true);
    setProblem(null);
    try {
      useAgentConfigs.getState().put(agentKey(agent), await setAgentFailover(desk, agent.id, own, other, on));
    } catch (e) {
      setProblem(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="think-row">
      <span>When its accounts can’t serve</span>
      <div>
        <div className="seg" role="radiogroup" aria-label="When its accounts can’t serve">
          <button type="button" role="radio" aria-checked={!another} disabled={busy} onClick={() => void choose(false)}>
            Wait and tell me
          </button>
          <button type="button" role="radio" aria-checked={another} disabled={busy || (!connected && !another)} onClick={() => void choose(true)}>
            Use another provider
          </button>
        </div>
        {!connected && !another && <p className="small faint">Sign in to {otherName} in Settings → Providers to use it</p>}
        {another && <p className="small faint">Goes to {otherName} when its own accounts can’t answer.</p>}
        {problem && <p className="small state-blocked">{problem}</p>}
      </div>
      <span />
    </div>
  );
}
