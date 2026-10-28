import { useState } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { VoiceSpec } from "../platform";
import { BrainDialog } from "../providers/BrainDialog";
import { useProviderList } from "../providers/store";
import { useSettings } from "../settings/store";
import { Dialog } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { BrainCard } from "./BrainCard";
import { newAgentBrain, type Brain } from "./brain";
import { createLocalAgent, setAgentVoice } from "./local";
import { VoiceCard, VoiceDialog } from "./VoiceDialog";

/** A new agent on this Mac: a name and what they're for, with how they
 *  think and sound starting on Desk's defaults. */
export function NewCrew({ onClose }: { onClose: () => void }) {
  const { hub, fail, openRoom } = useDesk();
  const { roster, refreshRoster, openDm } = useChat();
  const { newAgent, defaultVoice, agentVoices, set } = useSettings();
  const { providers, loaded } = useProviderList();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [chosenBrain, setChosenBrain] = useState<Brain | null>(null);
  const [voice, setVoice] = useState<VoiceSpec | null>(null);
  const [editing, setEditing] = useState<"brain" | "voice" | null>(null);
  const [busy, setBusy] = useState(false);

  const who = name.trim();
  const brain = chosenBrain ?? (loaded ? newAgentBrain(newAgent, providers) : null);
  const provider = brain ? providers.find((p) => p.id === brain.provider) : undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hub || !who || !purpose.trim()) return;
    setBusy(true);
    try {
      const taken = roster.filter((a) => a.hubId === "local").map((a) => a.id);
      const id = await createLocalAgent(hub, who, purpose, brain ?? newAgentBrain(newAgent, []), taken);
      if (voice) set({ agentVoices: { ...agentVoices, [`local/${id}`]: voice } });
      await setAgentVoice(hub, id, voice ?? defaultVoice);
      await refreshRoster();
      await openRoom(null);
      openDm(`local/${id}`);
      onClose();
    } catch (err) {
      fail(plainError(err));
    } finally {
      setBusy(false);
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
              <p>A name and a job is all they need. The rest starts on sensible defaults — change any of it now or later.</p>
            </span>
          </header>
        )}
      >
        <form className="dialog-form" onSubmit={submit}>
          <div className="dialog-scroll">
            <label className="field-stack">
              <span className="field-label">Name</span>
              <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Scout" required />
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
            </div>
            <div className="field-stack">
              <span className="field-label">How they sound</span>
              <VoiceCard who={who || "your new crew member"} spec={voice ?? defaultVoice} isDefault={!voice} onChange={() => setEditing("voice")} />
            </div>
            <p className="small faint">
              Desk writes their Soul, Agents, Identity and Welcome files from the description above. Fine-tune them any time in their
              Settings → Files.
            </p>
          </div>
          <footer className="dialog-foot">
            <span className="dialog-foot-note faint">Runs on This Mac</span>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-signal" disabled={busy || !who || !purpose.trim()}>
              {busy ? "Creating…" : who ? `Create ${who}` : "Create"}
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
