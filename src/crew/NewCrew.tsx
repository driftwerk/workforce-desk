import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { VoiceSpec } from "../platform";
import { BrainDialog } from "../providers/BrainDialog";
import { useProviderList } from "../providers/store";
import { useSettings } from "../settings/store";
import { Dialog } from "../ui/Dialog";
import { BrainCard } from "./BrainCard";
import { brainReady, newAgentBrain, type Brain } from "./brain";
import { PLAN_OF, type Provider } from "../hub/providers";
import { CopyInstall, PlanLoginAction, ReopenLink, usePlanLogin } from "../settings/PlanLogin";
import { accountsOf, freeName, useAccounts } from "../engines/accounts";
import { useProviders } from "../providers/store";
import { useUi } from "../shell/ui";
import { createLocalAgent, NAME_TAKEN, nameTaken, NotSetUp } from "./local";
import { VoiceCard, VoiceDialog } from "./VoiceDialog";
import { NEW_CREW_LINE } from "../shell/newLines";

/** A new agent on this computer: a name and what they're for, with how they
 *  think and sound starting on Desk's defaults. */
export function NewCrew({ onClose }: { onClose: () => void }) {
  const { hub, fail, openRoom } = useDesk();
  const { roster, refreshRoster, openDm } = useChat();
  const { newAgent, defaultVoice, agentVoices, set } = useSettings();
  const { providers, loaded } = useProviderList({ fresh: true });
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [chosenBrain, setChosenBrain] = useState<Brain | null>(null);
  const [voice, setVoice] = useState<VoiceSpec | null>(null);
  const [editing, setEditing] = useState<"brain" | "voice" | null>(null);
  const [busy, setBusy] = useState(false);

  const who = name.trim();
  const clash = nameTaken(who, roster, "local");
  const brain = chosenBrain ?? (loaded ? newAgentBrain(newAgent, providers) : null);
  const provider = brain ? providers.find((p) => p.id === brain.provider) : undefined;
  // Checked before they're made: on a provider that isn't connected, their
  // first message would fail.
  const ready = !loaded || !brain || brainReady(brain, providers);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hub || !who || !purpose.trim() || clash) return;
    setBusy(true);
    let id: string;
    try {
      // The ids taken as the hub has them now, not as the roster last read.
      await refreshRoster().catch(() => undefined);
      const taken = useChat
        .getState()
        .roster.filter((a) => a.hubId === "local")
        .map((a) => a.id);
      // A name taken since the roster was last read is taken all the same.
      if (nameTaken(who, useChat.getState().roster, "local")) {
        setBusy(false);
        return;
      }
      // All of them in one go, or none of them: see `createLocalAgent`.
      id = await createLocalAgent(hub, who, purpose, brain ?? newAgentBrain(newAgent, []), taken, voice ?? defaultVoice);
      if (voice) set({ agentVoices: { ...agentVoices, [`local/${id}`]: voice } });
    } catch (err) {
      setBusy(false);
      if (err instanceof NotSetUp) {
        // Said as it is, with the step that failed under Details; Retry only
        // where nothing was left behind.
        const cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
        useDesk.setState({
          error: { plain: err.message, ...(err.left ? {} : { fix: { label: "Retry", run: () => void submit(e) } }), details: cause, what: `making ${who} a crew member` },
        });
      } else fail(err, { what: `making ${who} a crew member`, retry: () => void submit(e) });
      return;
    }
    // Made whole: opening their chat is no part of making them, and never
    // offers to make them again.
    onClose();
    try {
      await refreshRoster();
      await openRoom(null);
      openDm(`local/${id}`);
    } catch (err) {
      fail(err, { what: `opening ${who}’s chat` });
    }
  };

  return (
    <>
      <Dialog
        onClose={onClose}
        title={(id) => (
          <header className="dialog-head">
            <span className="dialog-title">
              <h1 id={id} className="display-lg">
                New crew member
              </h1>
              <p>{NEW_CREW_LINE}</p>
              <p>A name and a job is all they need. The rest starts on sensible defaults — change any of it now or later.</p>
            </span>
          </header>
        )}
      >
        <form className="dialog-form" onSubmit={submit}>
          <div className="dialog-scroll">
            <label className="field-stack">
              <span className="field-label">Name</span>
              <input
                data-autofocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Scout"
                required
                aria-invalid={clash || undefined}
                aria-describedby={clash ? "new-crew-name-taken" : undefined}
              />
              {clash && (
                <span id="new-crew-name-taken" className="small state-blocked" role="status">
                  {NAME_TAKEN}
                </span>
              )}
            </label>
            <label className="field-stack">
              <span className="field-label">What they’re for</span>
              <textarea
                rows={2}
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="Keep an eye on CI for the workforce repos and tell me when something breaks, with the likely cause."
                required
              />
            </label>
            <div className="field-stack">
              <span className="field-label">How they think</span>
              <BrainCard brain={brain} provider={provider} onChange={() => setEditing("brain")} />
              {!ready && provider && <ConnectFirst provider={provider} who={who || "your new crew member"} />}
            </div>
            <div className="field-stack">
              <span className="field-label">How they sound</span>
              <VoiceCard who={who || "your new crew member"} spec={voice ?? defaultVoice} isDefault={!voice} onChange={() => setEditing("voice")} />
            </div>
            <p className="small faint">
              Desk shapes who they are and how they greet you from what they’re for. Change any of it later in their Settings.
            </p>
          </div>
          <footer className="dialog-foot">
            <span className="dialog-foot-note faint">Runs on this computer</span>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-signal" disabled={busy || !who || !purpose.trim() || !ready || clash} title={ready ? undefined : `Connect ${provider?.name ?? "their provider"} first`}>
              {busy ? `Setting up ${who}…` : who ? `Create ${who}` : "Create"}
            </button>
          </footer>
        </form>
      </Dialog>
      {editing === "brain" && brain && (
        <BrainDialog
          title={who ? `How ${who} thinks` : "How they think"}
          who={who || "They"}
          initial={brain}
          onUse={setChosenBrain}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === "voice" && (
        <VoiceDialog
          title={who ? `How ${who} sounds` : "How they sound"}
          who={who || "They"}
          current={voice}
          defaultVoice={defaultVoice}
          onUse={setVoice}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** The provider a new crew member would think with isn't connected: a plan
 *  signs in here (one Claude sign-in serving coding sessions too, while
 *  there's no account yet); anything else is connected in Providers. */
function ConnectFirst({ provider, who }: { provider: Provider; who: string }) {
  const hub = useDesk((s) => s.hub);
  const plan = provider.connect.kind === "login" ? PLAN_OF[provider.id] : undefined;
  const claudeAccounts = accountsOf(useAccounts((s) => s.accounts), "claude");
  const keepsAccounts = useAccounts((s) => s.supported !== false && s.store !== null);
  useEffect(() => {
    if (hub && plan === "claude") void useAccounts.getState().load();
  }, [hub, plan]);
  const login = usePlanLogin(
    plan,
    (account) => {
      if (hub) void useProviders.getState().load(hub);
      if (account) void useAccounts.getState().load();
    },
    () => ({ agents: true, account: keepsAccounts && claudeAccounts.length === 0 ? { name: freeName(claudeAccounts), makeDefault: true } : null }),
  );
  return (
    <div className="new-fix" role="group" aria-label={`${provider.name} isn’t connected`}>
      <p className="small state-blocked">
        {login.status ?? `${provider.name} isn’t connected, so ${who} couldn’t answer yet.`}
        {plan && <ReopenLink login={login} />}
        {plan && <CopyInstall login={login} />}
      </p>
      <span>
        {plan ? (
          <PlanLoginAction login={login} label={`Sign in to ${provider.name.replace(/ plan$/, "")}`} />
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => useUi.getState().openSettings("providers")}>
            Connect it in Providers
          </button>
        )}
      </span>
    </div>
  );
}
