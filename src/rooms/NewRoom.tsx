import { useEffect, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import { idsNow, mayHaveHappened, reconcile } from "../ui/reconcile";
import { MemberPicker } from "./MemberPicker";

export function NewRoom({ onClose }: { onClose: () => void }) {
  const { hub, fail, openRoom } = useDesk();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [lead, setLead] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  // What a second go reads: the form as it is then, not as it was when it failed.
  const latest = useRef({ name, picked, lead, hub });
  latest.current = { name, picked, lead, hub };
  const working = useRef(false);
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const { name, picked, lead, hub } = latest.current;
    if (!hub || working.current) return;
    working.current = true;
    setBusy(true);
    const before = await idsNow(() => hub.rooms());
    try {
      const members = picked.map((k) => {
        const [h, ...rest] = k.split("/");
        return { hub: h!, agent: rest.join("/") };
      });
      const room = await hub.createRoom(name, members, lead && picked.includes(lead) ? lead : undefined);
      await openRoom(room.id);
      onClose();
    } catch (err) {
      // A create whose answer never came may have been made: look before offering it again.
      const seen = mayHaveHappened(err) ? await reconcile(() => hub.rooms(), before, (r) => r.name === name) : null;
      if (seen?.kind === "made") {
        await openRoom(seen.made.id).catch(() => undefined);
        onClose();
      } else {
        const again = !seen || seen.kind === "absent";
        fail(err, { what: "making a room", ...(again ? { retry: () => here.current && void submit() } : {}) });
      }
    } finally {
      working.current = false;
      if (here.current) setBusy(false);
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
          <button type="submit" className="btn btn-signal" disabled={!name.trim() || busy}>
            Create
          </button>
        </footer>
      </form>
    </div>
  );
}
