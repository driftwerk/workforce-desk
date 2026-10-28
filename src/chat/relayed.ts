/** A turn in a DM that the overseer sent on: the hub delivers it as the
 *  person's own message, worded "<name> asks: …" or "<name> has a task for
 *  you: …", where the name is the overseer's, or "You" for a suggestion of
 *  its that you said yes to. */
export interface Relayed {
  /** Who it's from: the overseer itself, or you (by saying yes). */
  by: "overseer" | "you";
  /** The overseer it came through, by name. */
  overseer: string;
  task: boolean;
  /** What it says, without the wording around it. */
  text: string;
}

const ASKS = " asks: ";
const TASK = " has a task for you: ";

/** The relayed turn `content` is, if it is one. `crew` names everyone on
 *  the hub who could have been overseeing when it was sent (names and ids:
 *  the hub falls back to the id); `overseer` is who oversees now, for a
 *  suggestion you said yes to. */
export const relayedTurn = (content: string, crew: readonly string[], overseer: string | null): Relayed | null => {
  const names = [...new Set(crew.filter((n) => n.trim()))].sort((a, b) => b.length - a.length);
  for (const name of ["You", ...names]) {
    for (const [said, task] of [
      [ASKS, false],
      [TASK, true],
    ] as const) {
      const prefix = `${name}${said}`;
      if (!content.startsWith(prefix)) continue;
      const text = content.slice(prefix.length);
      if (!text.trim()) continue;
      if (name === "You") return { by: "you", overseer: overseer ?? "the overseer", task, text };
      return { by: "overseer", overseer: name, task, text };
    }
  }
  return null;
};
