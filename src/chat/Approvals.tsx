import { useEffect, useRef, useState } from "react";
import { decideApproval, type Decided } from "../hubs/surface";
import { plainError } from "../ui/plainError";
import "../styles/computer.css";
import type { Prompt } from "./conversation";
import { useChat } from "./store";
import type { ComputerFacts, PermissionChoice } from "./types";

/** What a call on this computer would do, as the card's title says it. */
const DOING: Record<string, string> = {
  read: "Wants to read",
  write: "Wants to change files",
  delete: "Wants to delete",
  exec: "Wants to run a command",
  session: "Wants to start a session",
  connector: "Wants to change something in a connected service",
};

/** The folder's own name, as "Always allow in acme-web" says it. */
const folderName = (folder: string) => folder.replace(/\/+$/, "").split("/").pop() || folder;

/** The hub's facts about a call on this computer: the command and where it
 *  runs, or the paths, and why it asks. */
function Facts({ facts }: { facts: ComputerFacts }) {
  return (
    <>
      {facts.command && <code className="computer-command">{facts.command}</code>}
      {facts.cwd && <span className="small">in {facts.cwd}</span>}
      {facts.paths && facts.paths.length > 0 && (
        <ul className="computer-paths">
          {facts.paths.map((p) => (
            <li key={p} className="mono small">
              {p}
            </li>
          ))}
        </ul>
      )}
      {facts.connector && <span className="small">{facts.connector}</span>}
      <span className="small muted">{facts.why}</span>
    </>
  );
}

/** A tool call the agent is waiting on you for: what it would do, and
 *  the choices the hub offers. "Always allow" saves the choice for that tool
 *  and destination, so it isn't asked again. A call on this computer shows
 *  the hub's own facts under "Desk asks", and may offer "for this session"
 *  and "always in this folder". No button is focused for you, and Enter
 *  never answers: every answer is a click. */
export function PromptCard({ prompt, onAnswer }: { prompt: Prompt; onAnswer: (choice: PermissionChoice) => boolean }) {
  const [problem, setProblem] = useState<string | null>(null);
  const answer = (choice: PermissionChoice) => {
    if (!onAnswer(choice)) setProblem("Desk isn’t connected to this agent right now. Try again once it is.");
  };
  const { options } = prompt;
  const facts = options.facts ?? null;
  const folder = options.allow_in_folder ?? null;
  const connector = facts?.effect === "connector";
  // What can't be undone isn't the easy answer: no answer is primary.
  const irreversible = facts?.why === "Can't be undone" || facts?.why === "Can't tell what this command runs";
  return (
    <div
      className={`dm-action dm-approval${facts ? " computer-ask" : ""}`}
      role="group"
      aria-label={facts ? "Desk asks" : "Asks you first"}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
    >
      <span className="dm-action-text">
        {facts ? (
          <>
            <span className="computer-asks small">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <rect x="3" y="7" width="10" height="7" rx="1.5" />
                <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
              </svg>
              Desk asks
            </span>
            <b>{DOING[facts.effect] ?? `Use ${prompt.tool}`}</b>
            <Facts facts={facts} />
          </>
        ) : (
          <>
            <span>{prompt.content || `Use ${prompt.tool}`}</span>
            <span className="small muted">Waiting for you{prompt.tool ? ` · ${prompt.tool}` : ""}</span>
          </>
        )}
        {problem && (
          <span className="small state-blocked" role="alert">
            {problem}
          </span>
        )}
      </span>
      <span className="dm-action-buttons">
        {options.allow_once && (
          <button type="button" className={irreversible ? "btn" : "btn btn-signal"} onClick={() => answer("allow_once")}>
            Allow once
          </button>
        )}
        {options.allow_session && (
          <button type="button" className="btn" onClick={() => answer("allow_session")}>
            Allow for this session
          </button>
        )}
        {folder && (
          <button type="button" className="btn" onClick={() => answer("allow_in_folder")}>
            {connector
              ? `Always allow writes to ${folder}`
              : irreversible
                ? `Always allow deleting in ${folderName(folder)}`
                : `Always allow in ${folderName(folder)}`}
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
 *  conversation it was set up in: decided here on its hub. Decided from
 *  its buttons, focus moves to what became of it. */
export function RoutedApproval({ hubId, requestId }: { hubId: string; requestId: string }) {
  const hub = useChat((s) => s.hubs.find((h) => h.id === hubId));
  const [decided, setDecided] = useState<Decided | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLSpanElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (decided && refocus.current) result.current?.focus();
  }, [decided]);
  const decide = async (choice: PermissionChoice) => {
    if (!hub) return;
    refocus.current = !!group.current?.contains(document.activeElement);
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
    <div ref={group} className="dm-action dm-approval" role="group" aria-label="Approval">
      <span className="dm-action-text">
        <span ref={result} tabIndex={-1} className={`small ${decided === "approved" ? "state-done" : decided ? "faint" : "muted"}`} role="status">
          {decided ? DECIDED[decided] : hub ? "Waiting for your answer" : "Its workspace isn’t connected to Desk any more."}
        </span>
        {problem && (
          <span className="small state-blocked" role="alert">
            {problem}
          </span>
        )}
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
