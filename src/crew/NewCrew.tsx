import { useState } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { useSettings } from "../settings/store";
import { createLocalAgent, pickPlan, type Plan } from "./local";

/** A new agent on this Mac: a name and what they're for. Everything else is
 *  chosen for them and can be changed later. */
export function NewCrew({ onClose }: { onClose: () => void }) {
  const { hub, fail, openRoom } = useDesk();
  const { roster, refreshRoster, openDm } = useChat();
  const chosen = useSettings((s) => s.plan) as Plan | null;
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hub) return;
    setBusy(true);
    try {
      const plan = pickPlan(chosen, await hub.vaultPaths());
      const taken = roster.filter((a) => a.hubId === "local").map((a) => a.id);
      const id = await createLocalAgent(hub, name, purpose, plan, taken);
      await refreshRoster();
      await openRoom(null);
      openDm(`local/${id}`);
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" onSubmit={submit} aria-label="New crew member">
        <h2 className="display-md">New crew member</h2>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Scout" required />
        </label>
        <label className="field">
          <span>What should they do?</span>
          <textarea
            className="field-text"
            rows={4}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="Keep an eye on CI for the workforce repos and tell me when something breaks, with the likely cause."
            required
          />
        </label>
        <p className="faint small">They run on your plan with memory and charts turned on. You can change any of it later.</p>
        <footer className="sheet-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-signal" disabled={busy || !name.trim() || !purpose.trim()}>
            {busy ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}
