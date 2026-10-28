import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey, providerLabel, type Agent, type HubAccount } from "../chat/types";
import { effortName } from "../hub/providers";
import { useDesk } from "../hub/store";
import type { VoiceSpec } from "../platform";
import { BrainDialog } from "../providers/BrainDialog";
import { useProviders } from "../providers/store";
import { useSettings } from "../settings/store";
import { plainError } from "../ui/plainError";
import { useAgentBrain, useAgentConfigs } from "./agentBrain";
import { effortShort, isDefaultEffort, isDefaultModel, modelName, modelOf } from "./brain";
import { AGENT_FILES, ago, useDrafts } from "./files";
import { purposeOf, renameLocalAgent, setAgentBrain, setAgentPurpose, setAgentVoice } from "./local";
import { VoiceCard, VoiceDialog } from "./VoiceDialog";

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** An agent's Settings tab: who they are, how they think and sound, their
 *  files, and removing them. Agents elsewhere show what their hub says. */
export function AgentSettings({ agent, hub, onOpenFiles }: { agent: Agent; hub: HubAccount | undefined; onOpenFiles: () => void }) {
  const local = hub?.local ?? false;
  return (
    <div className="agent-page">
      <div className="agent-settings">
        <About agent={agent} hub={hub} local={local} />
        {local ? <Thinking agent={agent} /> : <ThinkingElsewhere agent={agent} hub={hub} />}
        <Sound agent={agent} local={local} />
        {local && <FineTuning agent={agent} onOpen={onOpenFiles} />}
        {local && !agent.isDefault && <Remove agent={agent} />}
      </div>
    </div>
  );
}

function About({ agent, hub, local }: { agent: Agent; hub: HubAccount | undefined; local: boolean }) {
  const desk = useDesk((s) => s.hub);
  const refreshDrafts = useDrafts((s) => s.refresh);
  const { rename, refreshRoster } = useChat();
  const [saved, setSaved] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  // The name as saved, kept while a rename is in flight so it can go back.
  const [savedName, setSavedName] = useState(agent.name);
  const [name, setName] = useState(agent.name);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setSavedName(agent.name);
    setName(agent.name);
    setState("idle");
    setProblem(null);
    // A new agent, not a new name: the roster renames during a save.
  }, [agent.hubId, agent.id]);

  useEffect(() => {
    if (!local || !desk) return;
    let live = true;
    desk.identityFile(agent.id, "SOUL.md").then(
      (soul) => {
        if (!live) return;
        setSaved(purposeOf(soul));
        setPurpose(purposeOf(soul));
      },
      () => live && setSaved(""),
    );
    return () => {
      live = false;
    };
  }, [desk, agent.id, local]);

  const key = agentKey(agent);
  const nextName = name.trim();
  const renaming = local && nextName !== "" && nextName !== savedName;
  const changed = (saved !== null && purpose.trim() !== saved) || renaming;
  const valid = !!nextName && (saved === null || !!purpose.trim() || purpose.trim() === saved);

  const save = async () => {
    if (!desk || !valid) return;
    const purposeChanged = saved !== null && purpose.trim() !== saved;
    setState("saving");
    setProblem(null);
    try {
      if (renaming) {
        // Everywhere at once; put back if the rename doesn't take.
        rename(key, nextName);
        try {
          await renameLocalAgent(desk, agent.id, nextName, purposeChanged ? purpose : undefined);
        } catch (e) {
          rename(key, savedName);
          throw e;
        }
        setSavedName(nextName);
        setName(nextName);
      } else if (purposeChanged) {
        await setAgentPurpose(desk, agent.id, agent.name, purpose);
      }
      refreshDrafts(key);
      if (purposeChanged) {
        setSaved(purpose.trim());
        setPurpose(purpose.trim());
      }
      setState("saved");
      if (renaming) void refreshRoster();
    } catch (e) {
      setProblem(plainError(e));
      setState("idle");
    }
  };

  const discard = () => {
    setPurpose(saved ?? "");
    setName(savedName);
    setProblem(null);
  };

  return (
    <section className="agent-section" aria-labelledby="about-head">
      <h2 id="about-head">About</h2>
      <label className="field-stack">
        <span className="field-label">Name</span>
        {local ? (
          <input
            value={name}
            maxLength={60}
            disabled={state === "saving"}
            onChange={(e) => {
              setName(e.target.value);
              setState("idle");
            }}
          />
        ) : (
          <input value={agent.name} readOnly aria-readonly="true" />
        )}
      </label>
      {local ? (
        <label className="field-stack">
          <span className="field-label">What they’re for</span>
          <textarea
            rows={2}
            value={purpose}
            disabled={saved === null}
            placeholder={saved === null ? "…" : `Say what ${nextName || agent.name} is for, and Desk writes it into their files.`}
            onChange={(e) => {
              setPurpose(e.target.value);
              setState("idle");
            }}
          />
        </label>
      ) : (
        <div className="think-rows">
          <div className="think-row">
            <span>Lives on</span>
            <b>{hub ? `${hub.label}` : agent.hubId}</b>
            <span />
          </div>
        </div>
      )}
      {local && (changed || state !== "idle" || problem) && (
        <div className="agent-section-actions">
          {changed && (
            <>
              <button type="button" className="btn btn-signal" disabled={state === "saving" || !valid} onClick={() => void save()}>
                {state === "saving" ? "Saving…" : "Save"}
              </button>
              <button type="button" className="btn btn-ghost" disabled={state === "saving"} onClick={discard}>
                Discard
              </button>
            </>
          )}
          {!changed && state === "saved" && <span className="small state-done">Saved into their files.</span>}
          {problem && <span className="small state-blocked">{problem}</span>}
        </div>
      )}
    </section>
  );
}

function Thinking({ agent }: { agent: Agent }) {
  const desk = useDesk((s) => s.hub);
  const refreshRoster = useChat((s) => s.refreshRoster);
  const putConfig = useAgentConfigs((s) => s.put);
  const { brain, provider } = useAgentBrain(agent, true);
  const fallback = useProviders((s) => s.fallback);
  const [choosing, setChoosing] = useState(false);
  const model = brain ? modelOf(provider, brain.model) : undefined;

  return (
    <section className="agent-section" aria-labelledby="think-head">
      <h2 id="think-head">How they think</h2>
      <div className="think-rows">
        <div className="think-row">
          <span>Provider</span>
          <b>
            {provider?.name ?? providerLabel(brain?.provider ?? agent.provider) ?? "…"}{" "}
            {provider && (
              <span className={provider.connected ? "state-on" : "state-blocked"}>
                · {provider.connected ? "Connected" : "Not connected"}
              </span>
            )}
          </b>
          <span />
        </div>
        <div className="think-row">
          <span>Model</span>
          <b>
            {!brain ? "…" : provider && !fallback ? modelName(provider, brain.model) : (agent.model ?? modelName(provider, brain.model))}{" "}
            {model && !fallback && <span>· {lower(model.description)}</span>}
          </b>
          {brain && isDefaultModel(provider, brain.model) ? <span className="chip chip-default">Default</span> : <span />}
        </div>
        {brain?.effort && (
          <div className="think-row">
            <span>Effort</span>
            <b>
              {effortName(brain.effort)} <span>· {effortShort(brain.effort)}</span>
            </b>
            {isDefaultEffort(provider, brain.effort, brain.model) ? <span className="chip chip-default">Default</span> : <span />}
          </div>
        )}
      </div>
      <div>
        <button type="button" className="btn" disabled={!brain} onClick={() => setChoosing(true)}>
          Change how they think
        </button>
      </div>
      {choosing && brain && desk && (
        <BrainDialog
          title={`How ${agent.name} thinks`}
          who={agent.name}
          initial={brain}
          onUse={async (next) => {
            try {
              putConfig(agentKey(agent), await setAgentBrain(desk, agent.id, next));
            } catch (e) {
              throw new Error(plainError(e));
            }
            await refreshRoster();
          }}
          onClose={() => setChoosing(false)}
        />
      )}
    </section>
  );
}

function ThinkingElsewhere({ agent, hub }: { agent: Agent; hub: HubAccount | undefined }) {
  return (
    <section className="agent-section" aria-labelledby="think-head">
      <h2 id="think-head">How they think</h2>
      <div className="think-rows">
        <div className="think-row">
          <span>Provider</span>
          <b>{providerLabel(agent.provider) ?? "Unknown"}</b>
          <span />
        </div>
        <div className="think-row">
          <span>Model</span>
          <b className="mono">{agent.model ?? "Unknown"}</b>
          <span />
        </div>
      </div>
      <p className="small faint">Set by {hub?.label ?? "their workspace"}, where {agent.name} lives.</p>
    </section>
  );
}

function Sound({ agent, local }: { agent: Agent; local: boolean }) {
  const desk = useDesk((s) => s.hub);
  const { agentVoices, defaultVoice, set } = useSettings();
  const key = agentKey(agent);
  const own = agentVoices[key] ?? null;
  const [choosing, setChoosing] = useState(false);

  const choose = async (spec: VoiceSpec | null) => {
    const { [key]: _was, ...others } = useSettings.getState().agentVoices;
    set({ agentVoices: spec ? { ...others, [key]: spec } : others });
    if (local && desk) {
      try {
        await setAgentVoice(desk, agent.id, spec ?? defaultVoice);
      } catch (e) {
        throw new Error(plainError(e));
      }
    }
  };

  return (
    <section className="agent-section" aria-labelledby="sound-head">
      <h2 id="sound-head">How they sound</h2>
      <VoiceCard who={agent.name} spec={own ?? defaultVoice} isDefault={!own} withModel onChange={() => setChoosing(true)} />
      {choosing && (
        <VoiceDialog
          title={`How ${agent.name} sounds`}
          who={agent.name}
          current={own}
          defaultVoice={defaultVoice}
          onUse={choose}
          onClose={() => setChoosing(false)}
        />
      )}
    </section>
  );
}

function FineTuning({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
  const desk = useDesk((s) => s.hub);
  const [edited, setEdited] = useState<string | null>(null);
  useEffect(() => {
    if (!desk) return;
    let live = true;
    void Promise.allSettled(AGENT_FILES.map((f) => desk.identityRevisions(agent.id, f.name))).then((all) => {
      const latest = all
        .flatMap((r) => (r.status === "fulfilled" ? r.value.slice(0, 1) : []))
        .map((r) => r.created_at)
        .sort()
        .at(-1);
      if (live) setEdited(latest ?? null);
    });
    return () => {
      live = false;
    };
  }, [desk, agent.id]);
  return (
    <section className="agent-section" aria-labelledby="tune-head">
      <h2 id="tune-head">Fine-tuning</h2>
      <button type="button" className="setting-card link-card" onClick={onOpen}>
        <span className="card-text">
          <b>Soul, Agents, Identity and Welcome</b>
          <span>The files that shape who they are.{edited ? ` Last edited ${ago(edited)}.` : ""}</span>
        </span>
        <span className="link-card-action">Edit files</span>
      </button>
    </section>
  );
}

function Remove({ agent }: { agent: Agent }) {
  const desk = useDesk((s) => s.hub);
  const { refreshRoster, forget } = useChat();
  const dropDrafts = useDrafts((s) => s.drop);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = async () => {
    if (!desk) return;
    setBusy(true);
    setProblem(null);
    try {
      await desk.deleteAgent(agent.id);
      dropDrafts(agentKey(agent));
      forget(agentKey(agent));
      await refreshRoster();
    } catch (e) {
      setProblem(plainError(e));
      setBusy(false);
    }
  };

  return (
    <section className="agent-remove" aria-label={`Remove ${agent.name}`}>
      <span className="card-text">
        <b>{confirming ? `Remove ${agent.name}?` : `Remove ${agent.name} from your crew`}</b>
        <span className={problem ? "state-blocked" : "faint"}>
          {problem ?? `Their chats are kept. Adding someone called ${agent.name} again brings them back.`}
        </span>
      </span>
      {confirming ? (
        <span className="prov-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
            Keep {agent.name}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove"}
          </button>
        </span>
      ) : (
        <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
    </section>
  );
}
