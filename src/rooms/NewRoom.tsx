import { useState } from "react";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { useDesk } from "../hub/store";
import { Mark } from "../ui/Mark";

export function NewRoom({ onClose }: { onClose: () => void }) {
  const { roster, hubs } = useChat();
  const { hub, fail, openRoom } = useDesk();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [lead, setLead] = useState<string | null>(null);
  const toggle = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hub) return;
    try {
      const members = picked.map((k) => {
        const [h, ...rest] = k.split("/");
        return { hub: h!, agent: rest.join("/") };
      });
      const room = await hub.createRoom(name, members, lead && picked.includes(lead) ? lead : undefined);
      await openRoom(room.id);
      onClose();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" onSubmit={submit} aria-label="New room">
        <h2 className="display-md">New room</h2>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="release" required />
        </label>
        <div className="field">
          <span>Who’s in it</span>
          <div className="quick-list">
            {roster.map((a) => {
              const k = agentKey(a);
              return (
                <label key={k} className="side-row">
                  <input type="checkbox" checked={picked.includes(k)} onChange={() => toggle(k)} />
                  <Mark name={a.name} size="sm" />
                  <span className="display crew-name">{a.name}</span>
                  <span className="faint small">{hubs.find((h) => h.id === a.hubId)?.label}</span>
                  <input
                    type="radio"
                    name="lead"
                    aria-label={`Unaddressed messages go to ${a.name}`}
                    title="Unaddressed messages go to this member"
                    disabled={!picked.includes(k)}
                    checked={lead === k}
                    onChange={() => setLead(k)}
                  />
                </label>
              );
            })}
          </div>
          <span className="faint small">The round button picks who answers messages that don’t @-mention anyone.</span>
        </div>
        <footer className="sheet-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-signal" disabled={!name.trim()}>
            Create
          </button>
        </footer>
      </form>
    </div>
  );
}
