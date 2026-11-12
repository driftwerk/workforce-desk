import { useEffect, useId, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { workspaces } from "../chat/types";
import { hubAccounts, openUrl } from "../platform";
import { deskState } from "../restore/boot";
import {
  collectPairing,
  dropPending,
  keepPending,
  lastEmail,
  capName,
  nameOfHost,
  normaliseHubUrl,
  PairingEnded,
  pendingPairing,
  rememberEmail,
  requestPairing,
  whoAmI,
  type Paired,
  type PendingPairing,
} from "./pairing";
import { ProblemNote } from "../ui/ProblemNote";
import { explain, type Problem } from "../ui/problem";

/** How many times in a row Desk asks for a new code by itself, when one
 *  expires, before it leaves it to the person. A used code it never
 *  replaces by itself: someone else may have used it. */
export const AUTO_RESTARTS = 3;

/** A pairing failure in Desk's one shape: Desk's own pairing words are the
 *  headline as they are; anything else goes through `explain`. */
const pairProblem = (e: unknown, retry: () => void): Problem => {
  const raw = e instanceof Error ? e.message : String(e);
  const ours = raw.length <= 200 && !raw.includes("\n") && !/error sending request|invalid url|did not match the expected pattern/i.test(raw);
  // A code that ended asks for a new one; anything else, the same again.
  const label = e instanceof PairingEnded && e.reason !== "rejected" ? "New code" : "Try again";
  return ours ? { plain: raw, fix: { label, run: retry }, what: "connecting a workspace" } : explain(e, { what: "connecting a workspace", retry });
};

type Step =
  | { kind: "form" }
  | { kind: "code" }
  /** A hub without browser approval: a code asked for by your email. */
  | { kind: "email"; url: string; label: string }
  | { kind: "waiting"; pairing: PendingPairing }
  | { kind: "done"; paired: Paired };

const host = (url: string) => url.replace(/^https?:\/\//, "");

/** Shows a hub just paired (kept, with its token, by Desk's native side)
 *  and its agents. */
export const savePairedHub = async (): Promise<void> => {
  useChat.getState().setHubs(await hubAccounts());
};

/** Finishes a pairing left waiting when Desk last closed or reloaded. */
export const resumePairing = (): void => {
  const p = pendingPairing(deskState);
  if (p) collectPairing(deskState, p, savePairedHub).catch(() => {});
};

/** An email to offer: the last one Desk asked for a code with, else yours
 *  on any hub Desk knows (this computer's first). */
const knownEmail = async (): Promise<string | null> => {
  const remembered = lastEmail(deskState);
  if (remembered) return remembered;
  const hubs = [...workspaces(useChat.getState().hubs)].sort((a, b) => Number(b.local) - Number(a.local));
  for (const hub of hubs) {
    const who = await whoAmI(hub);
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
export function PairHub({
  onClose,
  again,
  onAsYou,
}: {
  onClose: () => void;
  again?: { url: string; label: string };
  /** A pairing connected without the person's account: sign in as them. */
  onAsYou?: (hub: { url: string; label: string }) => void;
}) {
  const [address, setAddress] = useState(again?.url ?? "");
  // Named from the workspace: what it calls itself, else its address's name.
  const label = again?.label ?? "";
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>(() => {
    const p = pendingPairing(deskState);
    return p ? { kind: "waiting", pairing: p } : { kind: "form" };
  });
  const [problem, setProblem] = useState<Problem | null>(null);
  /** What Desk did by itself, said once (a new code asked for). */
  const [note, setNote] = useState<string | null>(null);
  const restarts = useRef(0);
  /** Whether this pairing's approval page was opened: once, not again on
   *  each new code Desk asks for by itself. */
  const opened = useRef(false);
  const addressId = useId();
  const [busy, setBusy] = useState(false);
  const setError = (e: unknown, retry: () => void) => setProblem(e === null ? null : pairProblem(e, retry));

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
    const pairing = step.pairing;
    collectPairing(deskState, pairing, savePairedHub).then(
      (paired) => live && setStep({ kind: "done", paired }),
      (e: unknown) => {
        if (!live) return;
        // An expired code: a new one, at the same address and for the same
        // email, by itself.
        if (e instanceof PairingEnded && e.reason === "expired" && restarts.current < AUTO_RESTARTS) {
          restarts.current += 1;
          setNote(
            pairing.approveUrl || opened.current
              ? "The code expired, so Desk asked for a new one. Approve the new code on the page."
              : "The code expired, so Desk asked for a new one.",
          );
          void requestPairing(pairing.url, "Desk", pairing.email).then(
            (asked) =>
              live &&
              wait({
                url: pairing.url,
                label: pairing.label || asked.name || "",
                code: asked.code,
                ...(asked.approveUrl ? { approveUrl: asked.approveUrl } : {}),
                ...(pairing.email ? { email: pairing.email } : {}),
              }),
            (err: unknown) => {
              if (!live) return;
              setError(err, () => void restart(pairing.url, pairing.email));
              setStep({ kind: "form" });
            },
          );
          return;
        }
        setError(e, () => void restart(pairing.url, pairing.email));
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
    if (pairing.approveUrl && !opened.current) {
      opened.current = true;
      openUrl(pairing.approveUrl);
    }
  };

  /** Asks `url` for a new code and waits for it, as Connect does; an older
   *  hub's by `email` again when it was asked for by one. */
  const restart = async (url: string, email?: string) => {
    // Asked for by the person: its page opens again.
    opened.current = false;
    setProblem(null);
    setNote(null);
    setBusy(true);
    try {
      const asked = await requestPairing(url, "Desk", email);
      const named = capName(label) ?? asked.name ?? nameOfHost(url);
      if (asked.approveUrl) wait({ url, label: named, code: asked.code, approveUrl: asked.approveUrl });
      else if (email) wait({ url, label: named, code: asked.code, email });
      else setStep({ kind: "email", url, label: named });
    } catch (err) {
      setError(err, () => void restart(url, email));
    } finally {
      setBusy(false);
    }
  };

  /** Stops waiting and forgets the code. */
  const cancel = () => {
    if (step.kind === "waiting") dropPending(deskState, step.pairing.code);
    onClose();
  };

  const start = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setProblem(null);
    setNote(null);
    restarts.current = 0;
    opened.current = false;
    if (step.kind === "email") {
      setBusy(true);
      try {
        const { code, name } = await requestPairing(step.url, "Desk", email);
        rememberEmail(deskState, email);
        return wait({ url: step.url, label: step.label || name || "", code, email: email.trim() });
      } catch (err) {
        setError(err, () => void start());
      } finally {
        setBusy(false);
      }
      return;
    }
    let url: string;
    try {
      url = normaliseHubUrl(address);
    } catch (err) {
      return setError(err, () => void start());
    }
    if (step.kind === "code") return wait({ url, label: label || nameOfHost(url), code: code.trim().toUpperCase() });
    await restart(url);
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
                <div className="field">
                  <label htmlFor={addressId}>Workspace address</label>
                  <input
                    id={addressId}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="workforce.example.com"
                    aria-describedby={`${addressId}-hint`}
                    required
                    autoFocus
                  />
                  <span id={`${addressId}-hint`} className="small muted">
                    Desk names it as the workspace names itself.
                  </span>
                </div>
              </>
            )}
            {step.kind === "code" && (
              <>
                <label className="field">
                  <span>The code you approved</span>
                  <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="8CA2…" required />
                </label>
                <p className="small muted">
                  A code approved for you by an admin connects without your account, so agents shared only with you stay hidden until you sign in.
                </p>
              </>
            )}
            {problem && <ProblemNote problem={problem} />}
            <footer className="sheet-foot">
              {!again && (
                <button
                  type="button"
                  className="link small"
                  onClick={() => {
                    setProblem(null);
                    setStep(step.kind === "code" ? { kind: "form" } : { kind: "code" });
                  }}
                >
                  {step.kind === "code" ? "Sign in instead" : "An admin gave me a code"}
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-signal"
                disabled={busy || !address.trim() || (step.kind === "code" && !code.trim())}
                title={!address.trim() ? "Type the workspace address" : undefined}
              >
                {busy ? "Connecting…" : step.kind === "code" ? "Finish connecting" : again ? "Sign in" : "Connect"}
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
            {problem && <ProblemNote problem={problem} />}
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
            {step.pairing.approveUrl && (
              <p className="faint small">
                If no page opened, go to <span className="mono selectable">{step.pairing.approveUrl}</span>
              </p>
            )}
            {note && <p className="small muted" role="status">{note}</p>}
            <p className="faint small">Waiting for approval… You can close this; Desk finishes connecting once it’s approved, even after a restart.</p>
            {problem && <ProblemNote problem={problem} />}
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
        {step.kind === "done" && <DoneStep paired={step.paired} onClose={onClose} onAsYou={onAsYou} />}
      </form>
    </div>
  );
}

/** Connected: as whom, and when as nobody, signing in as you. */
function DoneStep({ paired, onClose, onAsYou }: { paired: Paired; onClose: () => void; onAsYou?: (hub: { url: string; label: string }) => void }) {
  const who = paired.as && (paired.as.name ?? paired.as.email);
  return (
    <>
      <p className="muted">
        {who
          ? `Connected to ${paired.label} as ${who}.`
          : `Connected to ${paired.label}, without your account: agents shared only with you are hidden until you sign in.`}{" "}
        Its agents are in your Crew now.
      </p>
      <footer className="sheet-foot">
        <span style={{ flex: 1 }} />
        {!who && onAsYou && (
          <button type="button" className="btn" onClick={() => onAsYou({ url: paired.url, label: paired.label })}>
            Sign in as you
          </button>
        )}
        <button type="button" className="btn btn-signal" onClick={onClose}>
          Done
        </button>
      </footer>
    </>
  );
}
