import { useEffect, useRef, useState } from "react";
import { CloseButton, Dialog } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import type { MachineId } from "./engines";
import { homeWithin, listIn, onMachine, shownPath } from "./folders";
import { FolderPicker } from "./FolderPicker";
import { native as realNative, type MachineNative } from "./native";
import { openTerminalOn } from "./watch";
import { machineHome } from "../platform";

/** "Open a terminal on devbox": a folder there, browsed or typed, then the
 *  terminal opens in it. Home always works; a folder that isn't there is
 *  said before anything opens. */
export function OpenTerminal({
  machine,
  name,
  native = realNative,
  onClose,
  onOpened = openTerminalOn,
}: {
  machine: MachineId;
  name: string;
  native?: MachineNative;
  onClose: () => void;
  /** Opens it (the grid's new terminal; tests', their own). */
  onOpened?: (machine: MachineId, cwd: string) => void;
}) {
  const [value, setValue] = useState("~");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = value.trim().replace(/\/+$/, "") || "~";
  // Cancelled (or closed) while it asked the machine: nothing opens later.
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
    },
    [],
  );
  const cancel = () => {
    gone.current = true;
    onClose();
  };
  const go = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const home = await homeWithin(() => machineHome(machine), name);
      if (gone.current) return;
      // A folder that isn't there is said here, not in a terminal that won't start.
      if (shown !== "~") {
        const looked = await listIn(native.transport(machine), shown);
        if (gone.current) return;
        if (looked.kind === "missing") {
          setProblem(`${name} has no folder ${shownPath(shown)}.`);
          return;
        }
      }
      onOpened(machine, onMachine(shown, home));
      onClose();
    } catch (e) {
      if (!gone.current) setProblem(plainError(e));
    } finally {
      if (!gone.current) setBusy(false);
    }
  };
  return (
    <Dialog
      onClose={cancel}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h2 id={id} className="display-lg">
              Open a terminal on {name}
            </h2>
            <p>Pick a folder on {name}, or type one.</p>
          </span>
          <CloseButton onClose={cancel} />
        </header>
      )}
    >
      <div className="dialog-scroll">
        <FolderPicker machine={machine} name={name} native={native} value={value} onChange={setValue} autoFocus />
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
      </div>
      <footer className="dialog-foot">
        <span className="small muted dialog-foot-note">Folders only. › opens one; any typed path works too.</span>
        <button type="button" className="btn btn-ghost" onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-signal" disabled={busy} onClick={() => void go()}>
          Open in {shownPath(shown)}
        </button>
      </footer>
    </Dialog>
  );
}
