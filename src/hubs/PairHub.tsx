import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { hubAccounts, saveHub } from "../platform";
import { normaliseHubUrl, pairingStatus, requestPairing } from "./pairing";

type Step = { kind: "form" } | { kind: "waiting"; url: string; code: string } | { kind: "done"; label: string };

export function PairHub({ onClose }: { onClose: () => void }) {
  const setHubs = useChat((s) => s.setHubs);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step.kind !== "waiting") return;
    let stopped = false;
    const poll = async () => {
      try {
        const s = await pairingStatus(step.url, step.code);
        if (stopped) return;
        if (s.status === "approved") {
          await saveHub(label || new URL(step.url).hostname, step.url, s.token);
          setHubs(await hubAccounts());
          setStep({ kind: "done", label: label || step.url });
        } else if (s.status === "pending") {
          setTimeout(poll, 2000);
        } else {
          setError(s.status === "rejected" ? "The hub turned the pairing down." : "The code expired. Ask for a new one.");
          setStep({ kind: "form" });
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [step, label, setHubs]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const url = normaliseHubUrl(address);
      const code = await requestPairing(url, "Desk", email.trim());
      setStep({ kind: "waiting", url, code });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" onSubmit={start} aria-label="Pair a hub">
        <h2 className="display-md">Pair a hub</h2>
        {step.kind === "form" && (
          <>
            <label className="field">
              <span>Hub address</span>
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="workforce.example.com" required />
            </label>
            <label className="field">
              <span>Call it</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Driftwerk" />
            </label>
            <label className="field">
              <span>Your email on that hub</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            {error && <p className="state-blocked small">{error}</p>}
            <footer className="sheet-foot">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-signal" disabled={!address.trim()}>
                Get a code
              </button>
            </footer>
          </>
        )}
        {step.kind === "waiting" && (
          <>
            <p className="muted">Approve this code on {step.url.replace(/^https?:\/\//, "")} (its web app’s pairing requests, or ask its admin):</p>
            <p className="pair-code mono">{step.code}</p>
            <p className="faint small">Waiting for approval…</p>
            {error && <p className="state-blocked small">{error}</p>}
            <footer className="sheet-foot">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
            </footer>
          </>
        )}
        {step.kind === "done" && (
          <>
            <p className="muted">Paired with {step.label}. Its agents are in Crew now.</p>
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
