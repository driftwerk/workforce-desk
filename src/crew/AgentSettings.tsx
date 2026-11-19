import { createContext, useContext, useEffect, useState, type ComponentType } from "react";
import { agentIdsOn, useChat } from "../chat/store";
import { agentKey, providerLabel, yourRoute, type Agent, type HubAccount } from "../chat/types";
import { effortName } from "../hub/providers";
import { useDesk } from "../hub/store";
import type { VoiceSpec } from "../platform";
import type { Provider } from "../hub/providers";
import { BrainDialog } from "../providers/BrainDialog";
import { useProviders } from "../providers/store";
import { useSettings } from "../settings/store";
import { plainError } from "../ui/plainError";
import { useAgentBrain, useAgentConfigs } from "./agentBrain";
import { backgroundOf, conversationOf, effortShort, isDefaultEffort, isDefaultModel, modelName, modelOf, SAME_AS_CHAT, type Work } from "./brain";
import { Failover } from "./Failover";
import { AGENT_FILES, ago, useDrafts } from "./files";
import { NAME_TAKEN, nameTaken, purposeOf, renameLocalAgent, setAgentBackground, setAgentBrain, setAgentConversation, setAgentPurpose, setAgentVoice } from "./local";
import { tickFloor, useFloor } from "../floor/store";
import type { Choice, Need } from "../hub/types";
import { useUi } from "../shell/ui";
import { PictureField } from "../pictures/PictureField";
import { useAgentImage } from "../pictures/who";
import { CheckingIn, HowTheyRemember, HowTheyWork } from "./AgentAbilities";
import { BossPlans } from "./PlanRow";
import { UpdatesSettings } from "./Updates";
import { OverseesTheCrew } from "./OverseesTheCrew";
import { WhatTheySee } from "./WhatTheySee";
import { VoiceCard, VoiceDialog } from "./VoiceDialog";
import { AgentRoute } from "../hubs/RunMyWorkOn";
import { SwitchRow } from "../ui/SwitchRow";
import { canStartThreads, setRepliesInThreads, useRepliesInThreads } from "../chat/threadReplies";

/** Parts of an agent's settings only Desk's main window has, handed down
 *  by its shell (see crew/mainWindow.ts), as the Board's chrome is: a
 *  grid's own window, which can show an agent's settings, has none, and
 *  never reaches the boss commands they use. */
export interface AgentSettingsParts {
  BossOfAGroup?: ComponentType<{ agent: Agent; hub: HubAccount }>;
}
export const MainWindowParts = createContext<AgentSettingsParts>({});

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** An agent's Settings tab: who they are, how they think and sound, their
 *  files, and removing them. Agents elsewhere show what their hub says. */
export function AgentSettings({ agent, hub, onOpenFiles }: { agent: Agent; hub: HubAccount | undefined; onOpenFiles: () => void }) {
  const local = hub?.local ?? false;
  const { BossOfAGroup } = useContext(MainWindowParts);
  return (
    <div className="agent-page">
      <div className="agent-settings">
        {local && <SectionLinks />}
        {local && <ChangedElsewhere agent={agent} />}
        <About agent={agent} hub={hub} local={local} />
        {local ? <Thinking agent={agent} /> : <ThinkingElsewhere agent={agent} hub={hub} />}
        <Sound agent={agent} local={local} />
        <Replying agent={agent} />
        {local && <HowTheyRemember agent={agent} ago={ago} />}
        {local && <HowTheyWork agent={agent} />}
        <WhatTheySee agent={agent} hub={hub} />
        {local && (
          <CheckingIn
            agent={agent}
            ago={ago}
            onEditList={() => {
              useUi.getState().setAgentFile(agentKey(agent), "HEARTBEAT.md");
              onOpenFiles();
            }}
          />
        )}
        {local && <OverseesTheCrew agent={agent} />}
        {/* An agent on a paired hub (not a machine's engine) can boss one
            of the person's groups, through that group's Boss sheet. */}
        {hub && !local && !hub.machine && BossOfAGroup && <BossOfAGroup agent={agent} hub={hub} />}
        {local && <UpdatesSettings agent={agent} />}
        {local && <BossPlans boss={agent.id} name={agent.name} />}
        {local && <FineTuning agent={agent} onOpen={onOpenFiles} />}
        {local && !agent.isDefault && <Remove agent={agent} />}
      </div>
    </div>
  );
}

const SECTIONS: { id: string; name: string }[] = [
  { id: "about", name: "About" },
  { id: "think", name: "How they think" },
  { id: "sound", name: "How they sound" },
  { id: "remember", name: "How they remember" },
  { id: "work", name: "How they work" },
  { id: "sees", name: "What they see" },
  { id: "checkin", name: "Checking in" },
  { id: "tune", name: "Fine-tuning" },
];

/** Links to each section of a long Settings tab. */
function SectionLinks() {
  return (
    <nav className="section-links" aria-label="Sections">
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(s.id)?.scrollIntoView({ block: "start", behavior: "smooth" });
          }}
        >
          {s.name}
        </a>
      ))}
    </nav>
  );
}

function About({ agent, hub, local }: { agent: Agent; hub: HubAccount | undefined; local: boolean }) {
  const desk = useDesk((s) => s.hub);
  const refreshDrafts = useDrafts((s) => s.refresh);
  const { rename, refreshRoster, setPicture, settle } = useChat();
  const src = useAgentImage(agentKey(agent));
  const [saved, setSaved] = useState<string | null>(null);
  // Saved, but their hub hadn't served them again when Desk stopped waiting.
  const [starting, setStarting] = useState(false);
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
  const roster = useChat((s) => s.roster);
  // Its own name in another case is no clash.
  const clash = renaming && nameTaken(nextName, roster, agent.hubId, agent.id);
  const changed = (saved !== null && purpose.trim() !== saved) || renaming;
  const valid = !!nextName && !clash && (saved === null || !!purpose.trim() || purpose.trim() === saved);

  const save = async () => {
    if (!desk || !valid) return;
    const purposeChanged = saved !== null && purpose.trim() !== saved;
    setState("saving");
    setProblem(null);
    // A new name or new instructions build the agent again on its hub: until
    // it serves, the roster keeps it, so it stays where it is shown.
    settle(key, true);
    const listed = hub ? () => agentIdsOn(hub) : undefined;
    let served = true;
    try {
      if (renaming) {
        // Shown everywhere at once; put back if the hub doesn't take it.
        const was = savedName;
        rename(key, nextName);
        try {
          served = await renameLocalAgent(desk, agent.id, nextName, purposeChanged ? purpose : undefined, listed);
        } catch (e) {
          rename(key, was);
          setProblem(plainError(e));
          setState("idle");
          return;
        }
        setSavedName(nextName);
        setName(nextName);
      } else if (purposeChanged) {
        try {
          served = await setAgentPurpose(desk, agent.id, agent.name, purpose, listed);
        } catch (e) {
          setProblem(plainError(e));
          setState("idle");
          return;
        }
      }
      await refreshRoster();
    } finally {
      settle(key, false);
    }
    refreshDrafts(key);
    if (purposeChanged) {
      setSaved(purpose.trim());
      setPurpose(purpose.trim());
    }
    setStarting(!served);
    setState("saved");
  };

  const discard = () => {
    setPurpose(saved ?? "");
    setName(savedName);
    setProblem(null);
  };

  return (
    <section id="about" className="agent-section" aria-labelledby="about-head">
      <h2 id="about-head">About</h2>
      <div className="field-stack">
        <span className="field-label">Picture</span>
        <PictureField
          name={agent.name}
          picture={agent.picture}
          src={src}
          onSet={
            local && desk
              ? async (image) => {
                  setPicture({ agent: agentKey(agent) }, await desk.setAgentPicture(agent.id, image));
                  void refreshRoster();
                }
              : undefined
          }
        />
      </div>
      <label className="field-stack">
        <span className="field-label">Name</span>
        {local ? (
          <input
            value={name}
            maxLength={60}
            disabled={state === "saving"}
            aria-invalid={clash || undefined}
            aria-describedby={clash ? `${key}-name-taken` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setState("idle");
            }}
          />
        ) : (
          <input value={agent.name} readOnly aria-readonly="true" />
        )}
        {clash && (
          <span id={`${key}-name-taken`} className="small state-blocked" role="status">
            {NAME_TAKEN}
          </span>
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
          {!changed && state === "saved" && (
            <span className="small state-done">{starting ? `Saved into their files. ${savedName} is still starting: they’ll be back in a moment.` : "Saved into their files."}</span>
          )}
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
  const config = useAgentConfigs((s) => s.configs[agentKey(agent)]) ?? "";
  const chatName = brain ? modelName(provider, brain.model) : "";

  return (
    <section id="think" className="agent-section" aria-labelledby="think-head">
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
        {brain && desk && (
          <>
            <BackgroundRow agent={agent} work="conversation" config={config} provider={provider} chat={chatName} />
            <BackgroundRow agent={agent} work="light" config={config} provider={provider} chat={chatName} />
            <BackgroundRow agent={agent} work="heavy" config={config} provider={provider} chat={chatName} />
          </>
        )}
        <YourConversations agent={agent} />
        <Failover agent={agent} />
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

/** A model the agent's work runs on beside its own: plain chatting, or a
 *  kind of background work. */
type ModelFor = Work | "conversation";

/** What each kind of work is for, as its row says it. */
const WORK: Record<ModelFor, { name: string; what: string; tier: string | null; byDefault: string | null }> = {
  conversation: {
    name: "Conversation",
    what: "Plain chatting with you; other work stays on the chat model",
    tier: null,
    // Its own model, named as the chat model is.
    byDefault: null,
  },
  light: {
    name: "Light background",
    what: "Session notes, gists, memory and running accounts",
    tier: "cheap",
    byDefault: "cheapest model",
  },
  heavy: {
    name: "Heavy background",
    what: "Check-ins, decisions on sessions, updates and compaction",
    tier: "standard",
    byDefault: "everyday model",
  },
};

/** The default's value in the picker: the setting left unset. */
const DEFAULT = "";

/** One kind of work: what it runs on, beside the chat model. For
 *  background work the default (unset) is the provider's cheap or standard
 *  tier, and a model of the provider or the chat model itself can be picked
 *  instead; for conversation the default is the chat model, and a model of
 *  the provider can be picked (`[llm.model_preferences] conversation`). */
function BackgroundRow({
  agent,
  work,
  config,
  provider,
  chat,
}: {
  agent: Agent;
  work: ModelFor;
  config: string;
  provider: Provider | undefined;
  chat: string;
}) {
  const desk = useDesk((s) => s.hub);
  const putConfig = useAgentConfigs((s) => s.put);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const w = WORK[work];
  const set = work === "conversation" ? conversationOf(config) : backgroundOf(config)[work];
  // A tier the file names is the default when it is the default's tier.
  const value = set === null || set === w.tier ? DEFAULT : set;
  const models = provider?.models ?? [];
  const known = value === DEFAULT || (work !== "conversation" && value === SAME_AS_CHAT) || models.some((m) => m.id === value);
  const id = `${agentKey(agent)}-${work}-model`;

  const choose = async (next: string) => {
    if (!desk || next === value) return;
    setSaving(true);
    setProblem(null);
    try {
      const model = next === DEFAULT ? null : next;
      putConfig(
        agentKey(agent),
        await (work === "conversation" ? setAgentConversation(desk, agent.id, model) : setAgentBackground(desk, agent.id, work, model)),
      );
    } catch (e) {
      setProblem(plainError(e));
      // A file changed elsewhere holds the save: its choice shows above.
      tickFloor();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="think-row think-row-work">
      <label htmlFor={id}>{w.name}</label>
      <span className="think-work">
        <select
          id={id}
          className="ability-select"
          value={value}
          disabled={saving}
          aria-describedby={`${id}-what`}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value={DEFAULT}>Default · {w.byDefault ?? (chat ? `same as chat · ${chat}` : "same as chat")}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          {work !== "conversation" && <option value={SAME_AS_CHAT}>Same as chat{chat ? ` · ${chat}` : ""}</option>}
          {!known && <option value={value}>{value}</option>}
        </select>
        <span id={`${id}-what`} className={problem ? "small state-blocked" : "small faint"} role={problem ? "alert" : undefined}>
          {problem ?? w.what}
        </span>
      </span>
      {value === DEFAULT ? <span className="chip chip-default">Default</span> : <span />}
    </div>
  );
}

/** Whether `need` is the hold on `agent`'s settings file, changed outside
 *  Desk: every save for them waits on it. */
const holdsSettings = (need: Need, agent: Agent): boolean =>
  need.answer.kind === "decide" && need.answer.at.kind === "config" && need.answer.at.agentId === agent.id;

/** A settings file changed outside Desk holds every save for this agent
 *  until the person chooses, so the choice is right here: Use it takes the
 *  file as it is now, Keep saved puts Desk's saved settings back. */
function ChangedElsewhere({ agent }: { agent: Agent }) {
  const desk = useDesk((s) => s.hub);
  const need = useFloor((s) => s.hubs[agent.hubId]?.floor?.needs.find((n) => holdsSettings(n, agent)));
  const key = need ? `${agent.hubId}/${need.id}` : "";
  const deciding = useFloor((s) => (key ? s.deciding[key] : undefined));
  const problem = useFloor((s) => (key ? s.problems[key] : undefined));
  if (!need) return null;
  const decide = (choice: Choice) => () =>
    void useFloor
      .getState()
      .decide(agent.hubId, need, choice)
      .then(() => desk && useAgentConfigs.getState().load(desk, agent));
  return (
    <div className="settings-held" role="region" aria-label="Settings changed outside Desk">
      <span className="dot dot-blocked" aria-hidden="true" />
      <span className="settings-held-text">
        <b>{agent.name}’s settings file was changed outside Desk</b>
        <span className="small">
          Nothing here can be saved until you choose. Use it to run on the file as it is now, or keep the settings Desk saved.
        </span>
        {problem && (
          <span className="small state-blocked" role="alert">
            {problem}
          </span>
        )}
      </span>
      <span className="settings-held-buttons">
        <button type="button" className="btn btn-blocked" disabled={!!deciding} onClick={decide("allow")}>
          {deciding === "allow" ? "Using it…" : "Use it"}
        </button>
        <button type="button" className="btn settings-held-keep" disabled={!!deciding} onClick={decide("deny")}>
          {deciding === "deny" ? "Keeping saved…" : "Keep saved"}
        </button>
      </span>
    </div>
  );
}

/** What your own conversations with `agent` run on, where that is your own
 *  route rather than the provider and model above. */
function YourConversations({ agent }: { agent: Agent }) {
  const mine = yourRoute(agent);
  if (!mine) return null;
  return (
    <div className="think-row">
      <span>Your conversations</span>
      <b>
        {mine.label}{" "}
        <span>{["", mine.model, mine.note].filter((part, at) => at === 0 || part).join(" · ")}</span>
      </b>
      <span />
    </div>
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
        <YourConversations agent={agent} />
      </div>
      <p className="small faint">Set by {hub?.label ?? "their workspace"}, where {agent.name} lives.</p>
      {hub && !hub.machine && <AgentRoute hub={hub} workspace={hub.label} agentId={agent.id} />}
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
    <section id="sound" className="agent-section" aria-labelledby="sound-head">
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

/** How they reply in their DM: always in a thread, on a hub that can start
 *  one on a new message; nothing where it can't. */
function Replying({ agent }: { agent: Agent }) {
  const key = agentKey(agent);
  const features = useChat((s) => s.conversations[key]?.features ?? s.hubFeatures[agent.hubId]);
  const on = useRepliesInThreads(key);
  // A grid's own window saves no settings: it's changed from the main one.
  const detached = useDesk((s) => s.detached);
  if (!canStartThreads(features) || detached) return null;
  return (
    <section id="replying" className="agent-section" aria-labelledby="replying-head">
      <h2 id="replying-head">How they reply</h2>
      <SwitchRow
        label="Always reply in a thread"
        sub={`Each new message you send ${agent.name} starts a thread of its own, and ${agent.name} answers in it, as in Slack. Your chat becomes a list of those conversations.`}
        on={on}
        onChange={(next) => setRepliesInThreads(key, next)}
      />
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
    <section id="tune" className="agent-section" aria-labelledby="tune-head">
      <h2 id="tune-head">Fine-tuning</h2>
      <button type="button" className="setting-card link-card" onClick={onOpen}>
        <span className="card-text">
          <b>Soul, Agents, Identity, Welcome and Heartbeat</b>
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
