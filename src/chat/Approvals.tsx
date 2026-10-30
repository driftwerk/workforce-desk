import { useState } from "react";
import { decideApproval, type Decided } from "../hubs/surface";
import { plainError } from "../ui/plainError";
import type { Prompt } from "./conversation";
import { useChat } from "./store";
import type { PermissionChoice } from "./types";

/** A tool call the agent is waiting on you for: what it would do, and
 *  the choices the hub offers. "Always allow" saves the choice for that
 *  destination, so it isn't asked again. */
export function PromptCard({ prompt, onAnswer }: { prompt: Prompt; onAnswer: (choice: PermissionChoice) => boolean }) {
  const [problem, setProblem] = useState<string | null>(null);
  const answer = (choice: PermissionChoice) => {
    if (!onAnswer(choice)) setProblem("Desk isn’t connected to this agent right now. Try again once it is.");
  };
  const { options } = prompt;
  return (
    <div className="dm-action dm-approval" role="group" aria-label="Asks you first">
      <span className="dm-action-text">
        <span>{prompt.content || `Use ${prompt.tool}`}</span>
        <span className="small muted">Waiting for you{prompt.tool ? ` · ${prompt.tool}` : ""}</span>
        {problem && <span className="small state-blocked">{problem}</span>}
      </span>
      <span className="dm-action-buttons">
        {options.allow_once && (
          <button type="button" className="btn btn-signal" onClick={() => answer("allow_once")}>
            Allow once
          </button>
        )}
        {options.allow_always && (
          <button type="button" className="btn" onClick={() => answer("allow_always")}>
            Always allow
          </button>
        )}
        {(options.deny_once || !options.allow_once) && (
          <button type="button" className="btn btn-ghost" onClick={() => answer("deny_once")}>
            Deny
          </button>
        )}
      </span>
    </div>
  );
}

const DECIDED: Record<Decided, string> = {
  approved: "You approved this.",
  denied: "You denied this.",
  already_resolved: "Already answered.",
};

/** An approval a scheduled run or workflow is waiting on, delivered to the
 *  conversation it was set up in: decided here on its hub. */
export function RoutedApproval({ hubId, requestId }: { hubId: string; requestId: string }) {
  const hub = useChat((s) => s.hubs.find((h) => h.id === hubId));
  const [decided, setDecided] = useState<Decided | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = async (choice: PermissionChoice) => {
    if (!hub) return;
    setBusy(true);
    setProblem(null);
    try {
      setDecided(await decideApproval(hub, requestId, choice));
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  return (
    <div className="dm-action dm-approval" role="group" aria-label="Approval">
      <span className="dm-action-text">
        {decided ? (
          <span className={decided === "approved" ? "small state-done" : "small faint"} role="status">
            {DECIDED[decided]}
          </span>
        ) : (
          <span className="small muted">{hub ? "Waiting for your answer" : "Its workspace isn’t connected to Desk any more."}</span>
        )}
        {problem && <span className="small state-blocked">{problem}</span>}
      </span>
      {!decided && hub && (
        <span className="dm-action-buttons">
          <button type="button" className="btn btn-signal" disabled={busy} onClick={() => void decide("allow_once")}>
            Approve
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void decide("deny_once")}>
            Deny
          </button>
        </span>
      )}
    </div>
  );
}
