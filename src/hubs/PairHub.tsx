import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { hubAccounts, saveHub } from "../platform";
import { deskState } from "../restore/boot";
import {
  collectPairing,
  dropPending,
  keepPending,
  normaliseHubUrl,
  PairingEnded,
  pendingPairing,
  requestPairing,
  type PendingPairing,
} from "./pairing";

type Step = { kind: "form" } | { kind: "code" } | { kind: "waiting"; pairing: PendingPairing } | { kind: "done"; label: string };

/** Saves a paired hub and shows its agents. */
export const savePairedHub = async (label: string, url: string, token: string): Promise<void> => {
  await saveHub(label, url, token);
  useChat.getState().setHubs(await hubAccounts());
};

/** Finishes a pairing left waiting when Desk last closed or reloaded. */
export const resumePairing = (): void => {
  const p = pendingPairing(deskState);
  if (p) collectPairing(deskState, p, savePairedHub).catch(() => {});
};

export function PairHub({ onClose }: { onClose: () => void }) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>(() => {
    const p = pendingPairing(deskState);
    return p ? { kind: "waiting", pairing: p } : { kind: "form" };
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step.kind !== "waiting") return;
    let live = true;
    collectPairing(deskState, step.pairing, savePairedHub).then(
      (done) => live && setStep({ kind: "done", label: done }),
      (e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        if (e instanceof PairingEnded) setStep({ kind: "form" });
      },
    );
    return () => {
      live = false;
    };
  }, [step]);

  const wait = (pairing: PendingPairing) => {
    keepPending(deskState, pairing);
    setStep({ kind: "waiting", pairing });
  };

  /** Stops waiting and forgets the code. */
  const cancel = () => {
    if (step.kind === "waiting") dropPending(deskState, step.pairing.code);
    onClose();
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const url = normaliseHubUrl(address);
      if (step.kind === "code") return wait({ url, label: label.trim(), code: code.trim().toUpperCase() });
      wait({ url, label: label.trim(), code: await requestPairing(url, "Desk", email.trim()) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" onSubmit={start} aria-label="Connect a workspace">
        <h2 className="display-md">Connect a workspace</h2>
        {(step.kind === "form" || step.kind === "code") && (
          <>
            <label className="field">
              <span>Workspace address</span>
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="workforce.example.com" required />
            </label>
            <label className="field">
              <span>Call it</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Driftwerk" />
            </label>
            {step.kind === "code" ? (
              <label className="field">
                <span>The code you approved</span>
                <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="8CA2…" required />
              </label>
            ) : (
              <label className="field">
                <span>Your email there</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </label>
            )}
            {error && <p className="state-blocked small">{error}</p>}
            <footer className="sheet-foot">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setError(null);
                  setStep(step.kind === "code" ? { kind: "form" } : { kind: "code" });
                }}
              >
                {step.kind === "code" ? "Get a new code instead" : "I already have an approved code"}
              </button>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-signal" disabled={!address.trim() || (step.kind === "code" && !code.trim())}>
                {step.kind === "code" ? "Finish connecting" : "Get a code"}
              </button>
            </footer>
          </>
        )}
        {step.kind === "waiting" && (
          <>
            <p className="muted">
              Approve this code in {step.pairing.url.replace(/^https?:\/\//, "")} — its pairing requests, the same place you
              approved your phone — or ask its admin:
            </p>
            <p className="pair-code mono">{step.pairing.code}</p>
            <p className="faint small">Waiting for approval… You can close this; Desk finishes connecting once it’s approved, even after a restart.</p>
            {error && <p className="state-blocked small">{error}</p>}
            <footer className="sheet-foot">
              <button type="button" className="btn btn-ghost" onClick={cancel}>
                Stop waiting
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </footer>
          </>
        )}
        {step.kind === "done" && (
          <>
            <p className="muted">Connected to {step.label}. Its agents are in your Crew now.</p>
            <footer className="sheet-foot">
              <button type="button" className="btn btn-signal" onClick={onClose}>
                Done
              </button>
            </footer>
          </>
        )}
      </form>
    </div>
  );
}
