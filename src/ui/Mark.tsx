import { useState } from "react";
import type { Look } from "../floor/background";
import { useAgentImage, useYou } from "../pictures/who";
import { ENGINE_MARK, markFor, SERIES_MARK_TOKENS, tokenVar } from "../theme/tokens";
import { firstGrapheme } from "./graphemes";

const RING: Partial<Record<Look, string>> = {
  working: "ring-working",
  starting: "ring-working",
  background: "ring-background",
  blocked: "ring-blocked",
  done: "ring-done",
};

/** An engine's own initials, on its mark. */
const ENGINE_INITIALS: Partial<Record<string, string>> = { claude: "cc", codex: "cx", devin: "dv" };

export const initialsFor = (name: string, engine?: string): string =>
  (engine && ENGINE_INITIALS[engine]) ?? (firstGrapheme(name.trim()) ?? "?").toUpperCase();

/** The board's initials: a person's first and last (`RL` for Richard
 *  Lucas), a session's word starts in small letters (`bo` for brisk-otter). */
export const markText = (name: string, agent: boolean): string => {
  const words = name.trim().split(agent ? /[\s\-_]+/ : /\s+/).filter(Boolean);
  const first = (w: string | undefined) => (w && firstGrapheme(w)) ?? "";
  const two = (words.length > 1 ? first(words[0]) + first(words.at(-1)) : first(words[0])) || "?";
  return agent ? two.toLowerCase() : two.toUpperCase();
};

export type MarkSize = "xs" | "sm" | "md" | "lg" | "xl";

/** What a mark is filled with: Desk's pastel marks, or (a person on the
 *  board) a chart series colour, read with `onSeriesMark`. */
export type MarkTone = "mark" | "series";

/** Who or what something is at a glance: their picture where they have one,
 *  else their letter, in the ring that says what they're doing. Agents and
 *  sessions are rounded squares; people are round, but on the board, where
 *  a person's mark is filled in a series colour (`tone="series"`), a rounded
 *  square as the board's design draws them, with the board's initials (a
 *  picture stays round). */
export function Mark({
  name,
  engine,
  state,
  size = "md",
  src,
  person = false,
  tone = "mark",
  you = false,
}: {
  name: string;
  engine?: string;
  state?: Look;
  size?: MarkSize;
  /** Their picture; the letter shows without one, or if it won't load. */
  src?: string | null;
  person?: boolean;
  tone?: MarkTone;
  /** It stands for the person themselves: on the board, their first
   *  initial only, as their own comments show it (its colour still by
   *  their whole name). */
  you?: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const picture = src && src !== broken ? src : null;
  const series = tone === "series" && !engine;
  // A person on the board: a series colour, by name, and the ink that reads on it.
  const face = series
    ? { background: tokenVar(markFor(name, SERIES_MARK_TOKENS)), color: tokenVar("onSeriesMark") }
    : { background: tokenVar(engine ? ENGINE_MARK : markFor(name)) };
  return (
    <span className={`mark mark-${size} ${person && (!series || picture) ? "mark-person" : ""} ${state ? (RING[state] ?? "") : ""}`}>
      <span className="mark-face" style={picture ? undefined : face}>
        {picture ? <img src={picture} alt="" draggable={false} onError={() => setBroken(picture)} /> : series ? markText(you ? (name.trim().split(/\s+/)[0] ?? name) : name, false) : initialsFor(name, engine)}
      </span>
    </span>
  );
}

/** Agent `agent`'s (`hub/agent`) mark, with their picture. */
export function AgentMark({ agent, ...mark }: { agent: string; name: string; state?: Look; size?: MarkSize }) {
  return <Mark {...mark} src={useAgentImage(agent)} />;
}

/** Your mark as `hub`'s places show you (null: Desk's own places). */
export function YouMark({ hub, size }: { hub: string | null; size?: MarkSize }) {
  const you = useYou(hub);
  return <Mark name={you.name ?? "You"} size={size} src={you.src} person />;
}
