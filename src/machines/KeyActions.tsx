// What Desk does itself for a machine added already, where it used to hand
// the person a line to run in a terminal: forgetting a reinstalled
// machine's old host key (after a native yes showing both fingerprints),
// and turning linger on with the machine's password, typed into Desk's own
// window. The line stays, folded, for whoever would rather run it.

import { useState } from "react";
import { CopyButton } from "../settings/EngineBlocks";
import { plainError } from "../ui/plainError";
import type { Machine } from "./engines";
import type { MachineNative } from "./native";

function Fold({ summary, line }: { summary: string; line: string }) {
  return (
    <details className="problem-details">
      <summary className="small faint">{summary}</summary>
      <span className="machine-line">
        <code className="mono small">{line}</code>
        <CopyButton text={line} />
      </span>
    </details>
  );
}

/** "Forget the old key and trust the new one", then Reconnect. */
export function ForgetOldKey({ machine, native, line }: { machine: Machine; native: MachineNative; line: string | null }) {
  const [state, setState] = useState<{ kind: "idle" | "asking" } | { kind: "failed"; problem: string }>({ kind: "idle" });
  const shown = machine.shownKey?.fingerprint;
  const forget = () => {
    if (!shown || !machine.target) return;
    setState({ kind: "asking" });
    native
      .forgetKey(machine.target, shown)
      .then((yes) => {
        setState({ kind: "idle" });
        if (yes) void native.reconnect(machine.id).catch(() => undefined);
      })
      .catch((e: unknown) => setState({ kind: "failed", problem: plainError(e) }));
  };
  return (
    <span className="machine-actions">
      {shown && (
        <button type="button" className="btn btn-sm btn-signal" disabled={state.kind === "asking"} onClick={forget}>
          {state.kind === "asking" ? "Waiting for your yes…" : "Forget the old key and trust the new one"}
        </button>
      )}
      {state.kind === "failed" && (
        <span className="small state-blocked" role="alert">
          {state.problem}
        </span>
      )}
      {line && <Fold summary="Or remove it yourself" line={line} />}
    </span>
  );
}

/** "Turn it on with {name}'s password": sudo turns linger on there. */
export function LingerWithPassword({ machine, native, line }: { machine: Machine; native: MachineNative; line: string | null }) {
  const [state, setState] = useState<{ kind: "idle" | "asking" | "done" } | { kind: "failed"; problem: string }>({ kind: "idle" });
  const turnOn = () => {
    setState({ kind: "asking" });
    native
      .lingerWithPassword(machine.id)
      .then((r) => setState({ kind: r.kind === "done" ? "done" : "idle" }))
      .catch((e: unknown) => setState({ kind: "failed", problem: plainError(e) }));
  };
  if (state.kind === "done") return <span className="small state-done">On: Desk starts when {machine.name} boots.</span>;
  return (
    <span className="machine-actions">
      <button type="button" className="btn btn-sm btn-signal" disabled={state.kind === "asking"} onClick={turnOn}>
        {state.kind === "asking" ? "Waiting for the password…" : `Turn it on with ${machine.name}’s password`}
      </button>
      {state.kind === "failed" && (
        <span className="small state-blocked" role="alert">
          {state.problem}
        </span>
      )}
      {line && <Fold summary="Or an administrator runs this there" line={line} />}
    </span>
  );
}
