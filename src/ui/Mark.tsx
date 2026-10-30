import { useState } from "react";
import type { SessionState } from "../hub/types";
import { useAgentImage, useYou } from "../pictures/who";
import { markFor } from "../theme/tokens";

const RING: Partial<Record<SessionState, string>> = {
  working: "ring-working",
  starting: "ring-working",
  blocked: "ring-blocked",
  done: "ring-done",
};

export const initialsFor = (name: string, engine?: string): string =>
  engine === "claude" ? "cc" : engine === "codex" ? "cx" : (name[0] ?? "?").toUpperCase();

export type MarkSize = "xs" | "sm" | "md" | "lg" | "xl";

/** Who or what something is at a glance: their picture where they have one,
 *  else their letter, in the ring that says what they're doing. Agents and
 *  sessions are rounded squares; people are round. */
export function Mark({
  name,
  engine,
  state,
  size = "md",
  src,
  person = false,
}: {
  name: string;
  engine?: string;
  state?: SessionState;
  size?: MarkSize;
  /** Their picture; the letter shows without one, or if it won't load. */
  src?: string | null;
  person?: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const picture = src && src !== broken ? src : null;
  return (
    <span className={`mark mark-${size} ${person ? "mark-person" : ""} ${state ? (RING[state] ?? "") : ""}`}>
      <span className="mark-face" style={picture ? undefined : { background: engine ? "#E8DDB5" : markFor(name) }}>
        {picture ? <img src={picture} alt="" draggable={false} onError={() => setBroken(picture)} /> : initialsFor(name, engine)}
      </span>
    </span>
  );
}

/** Agent `agent`'s (`hub/agent`) mark, with their picture. */
export function AgentMark({ agent, ...mark }: { agent: string; name: string; state?: SessionState; size?: MarkSize }) {
  return <Mark {...mark} src={useAgentImage(agent)} />;
}

/** Your mark as `hub`'s places show you (null: Desk's own places). */
export function YouMark({ hub, size }: { hub: string | null; size?: MarkSize }) {
  const you = useYou(hub);
  return <Mark name={you.name ?? "You"} size={size} src={you.src} person />;
}
