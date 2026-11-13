import { useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { idsNow, mayHaveHappened, reconcile } from "../ui/reconcile";
import { MemberPicker } from "./MemberPicker";
import { NotShared, savingShared } from "./share";
import { nameClash } from "./clash";

export function NewRoom({ onClose }: { onClose: () => void }) {
  const { hub, fail, openRoom } = useDesk();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [lead, setLead] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const crew = useChat((s) => s.roster.length);
  const toggle = (k: string) => setPicked((was) => (was.includes(k) ? was.filter((x) => x !== k) : [...was, k]));
  // Someone answers what @-mentions no one from the start: the first picked,
  // until you choose another (and again when that one is unpicked).
  useEffect(() => setLead((lead) => (lead && picked.includes(lead) ? lead : (picked[0] ?? null))), [picked]);
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
      const room = await savingShared(name, (shareWith) => hub.createRoom(name, members, lead && picked.includes(lead) ? lead : undefined, shareWith));
      await openRoom(room.id);
      onClose();
    } catch (err) {
      // You said no to sharing it: nothing was made, and nothing to say.
      if (err instanceof NotShared) return;
      // Its name is another room's: that one can be opened instead.
      const other = nameClash(err, name);
      if (other) {
        useDesk.setState({
          error: {
            plain: `There’s already a room called ${other.name}.`,
            fix: { label: `Open ${other.name}`, run: () => void openRoom(other.id).then(onClose) },
            what: "making a room",
          },
        });
        return;
      }
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
        <h2 className="display-lg">New room</h2>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="release" required />
        </label>
        <div className="field">
          <span>Who’s in it</span>
          <MemberPicker picked={picked} onToggle={toggle} lead={{ key: lead, onPick: setLead }} />
          {crew > 0 && <span className="faint small">The round button picks who answers messages that don’t @-mention anyone.</span>}
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
