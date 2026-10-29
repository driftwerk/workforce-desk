import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { hubAccounts, openUrl, saveHub } from "../platform";
import { deskState } from "../restore/boot";
import {
  collectPairing,
  dropPending,
  keepPending,
  lastEmail,
  normaliseHubUrl,
  PairingEnded,
  pendingPairing,
  rememberEmail,
  requestPairing,
  whoAmI,
  type Paired,
  type PendingPairing,
} from "./pairing";

type Step =
  | { kind: "form" }
  | { kind: "code" }
  /** A hub without browser approval: a code asked for by your email. */
  | { kind: "email"; url: string; label: string }
  | { kind: "waiting"; pairing: PendingPairing }
  | { kind: "done"; paired: Paired };

const host = (url: string) => url.replace(/^https?:\/\//, "");

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

/** An email to offer: the last one Desk asked for a code with, else yours
 *  on any hub Desk knows (this Mac's first). */
const knownEmail = async (): Promise<string | null> => {
  const remembered = lastEmail(deskState);
  if (remembered) return remembered;
  const hubs = [...useChat.getState().hubs].sort((a, b) => Number(b.local) - Number(a.local));
  for (const hub of hubs) {
    const who = await whoAmI(hub.url, hub.token);
    if (who.state === "person" && who.email?.includes("@")) return who.email;
  }
  return null;
};

/** Connecting a workspace: Desk asks it for a code and opens its approval
 *  page, where you sign in and approve Desk — which links Desk to you. A hub
 *  without that page takes your email and is approved in its Pairing page;
 *  a code approved elsewhere connects as nobody. With `again`, that
 *  workspace is paired anew as you, keeping its address and name — and so
 *  its id, and everything that names its agents. */
export function PairHub({ onClose, again }: { onClose: () => void; again?: { url: string; label: string } }) {
  const [address, setAddress] = useState(again?.url ?? "");
  const [label, setLabel] = useState(again?.label ?? "");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>(() => {
    const p = pendingPairing(deskState);
    return p ? { kind: "waiting", pairing: p } : { kind: "form" };
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (step.kind !== "email") return;
    let live = true;
    void knownEmail().then((known) => {
      if (live && known) setEmail((typed) => typed || known);
    });
    return () => {
      live = false;
    };
  }, [step.kind]);

  useEffect(() => {
    if (step.kind !== "waiting") return;
    let live = true;
    collectPairing(deskState, step.pairing, savePairedHub).then(
      (paired) => live && setStep({ kind: "done", paired }),
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
    if (pairing.approveUrl) openUrl(pairing.approveUrl);
  };

  /** Stops waiting and forgets the code. */
  const cancel = () => {
    if (step.kind === "waiting") dropPending(deskState, step.pairing.code);
    onClose();
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (step.kind === "email") {
        const { code } = await requestPairing(step.url, "Desk", email);
        rememberEmail(deskState, email);
        return wait({ url: step.url, label: step.label, code });
      }
      const url = normaliseHubUrl(address);
      if (step.kind === "code") return wait({ url, label: label.trim(), code: code.trim().toUpperCase() });
      const asked = await requestPairing(url, "Desk");
      if (asked.approveUrl) wait({ url, label: label.trim(), code: asked.code, approveUrl: asked.approveUrl });
      else setStep({ kind: "email", url, label: label.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const name = (url: string, given: string) => given || host(url);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" onSubmit={start} aria-label="Connect a workspace">
        <h2 className="display-md">{again ? `Connect to ${again.label} as you` : "Connect a workspace"}</h2>
        {(step.kind === "form" || step.kind === "code") && (
          <>
            {again ? (
              <p className="muted">
                Desk opens {host(again.url)} in your browser, where you sign in and approve it. Desk then uses the new connection in
                place of the one it has, and everything you’ve set up with its agents stays as it is.
              </p>
            ) : (
              <>
                <label className="field">
                  <span>Workspace address</span>
                  <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="workforce.example.com" required />
                </label>
                <label className="field">
                  <span>Call it</span>
                  <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Driftwerk" />
                </label>
              </>
            )}
            {step.kind === "code" && (
              <>
                <label className="field">
                  <span>The code you approved</span>
                  <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="8CA2…" required />
                </label>
                <p className="small muted">
                  This connects without linking your account. Afterwards, use Connect as you in Workspaces to sign in and see agents shared only with you.
                </p>
              </>
            )}
            {error && <p className="state-blocked small">{error}</p>}
            <footer className="sheet-foot">
              {!again && (
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
              )}
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-signal" disabled={busy || !address.trim() || (step.kind === "code" && !code.trim())}>
                {step.kind === "code" ? "Finish connecting" : again ? "Sign in" : "Connect"}
              </button>
            </footer>
          </>
        )}
        {step.kind === "email" && (
          <>
            <p className="muted">
              {name(step.url, step.label)} approves new devices in its Pairing page, and knows it’s you by your email there.
            </p>
            <label className="field">
              <span>Your email there</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoFocus />
              <span className="small muted">So the workspace knows it’s you, and shows you the agents shared with you.</span>
            </label>
            {error && <p className="state-blocked small">{error}</p>}
            <footer className="sheet-foot">
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-signal" disabled={busy || !email.trim().includes("@")}>
                Get a code
              </button>
            </footer>
          </>
        )}
        {step.kind === "waiting" && (
          <>
            {step.pairing.approveUrl ? (
              <p className="muted">
                Sign in to {name(step.pairing.url, step.pairing.label)} in your browser and approve Desk. Check the code matches.
              </p>
            ) : (
              <p className="muted">
                Approve the request with this code in {host(step.pairing.url)}’s Pairing page — the same place you approved your
                phone — or ask its admin:
              </p>
            )}
            <p className="pair-code mono">{step.pairing.code}</p>
            <p className="faint small">Waiting for approval… You can close this; Desk finishes connecting once it’s approved, even after a restart.</p>
            {error && <p className="state-blocked small">{error}</p>}
            <footer className="sheet-foot">
              <button type="button" className="btn btn-ghost" onClick={cancel}>
                Stop waiting
              </button>
              <span style={{ flex: 1 }} />
              {step.pairing.approveUrl && (
                <button type="button" className="btn" onClick={() => openUrl(step.pairing.approveUrl!)}>
                  Open the page again
                </button>
              )}
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </footer>
          </>
        )}
        {step.kind === "done" && (
          <>
            <p className="muted">
              {step.paired.as
                ? `Connected as ${step.paired.as.name ?? step.paired.as.email}.`
                : `Connected to ${step.paired.label}.`}{" "}
              Its agents are in your Crew now.
            </p>
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
