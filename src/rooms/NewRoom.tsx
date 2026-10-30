import { useState } from "react";
import { useDesk } from "../hub/store";
import { MemberPicker } from "./MemberPicker";

export function NewRoom({ onClose }: { onClose: () => void }) {
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
          <MemberPicker picked={picked} onToggle={toggle} lead={{ key: lead, onPick: setLead }} />
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
