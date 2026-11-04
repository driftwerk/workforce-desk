// Sessions a boss runs (its "charge"): what their badge says, who has the
// wheel in plain words, and what the person can do about it (Hand to,
// Release, I'll drive, Hand back). Pure: the store (./chargeStore.ts) keeps
// the charges, and the card, the pane and the sidebar draw these.

import { ENGINE_TITLE } from "../engines/engines";
import type { ChargeView, OversightLevel, Session } from "../hub/types";

/** The boss there is to hand sessions to: the overseer, by name. */
export interface Boss {
  id: string;
  name: string;
  level: OversightLevel | null;
}

/** How long the person's wheel lasts with no input from them and the
 *  session idle, as the hub counts it. */
export const QUIET_MINUTES = 10;

/** Whether the person has the wheel. */
export const driving = (c: ChargeView): boolean => c.wheel !== "boss";

/** The badge on a session a boss runs: "Sarah has it", or "You're
 *  driving" while the person has the wheel; `short` where space is tight
 *  (the sidebar): "Sarah's" or "Yours". */
export const badgeOf = (c: ChargeView | null | undefined, short = false): { text: string; look: "boss" | "you" } | null => {
  if (!c || c.releasedAt) return null;
  if (driving(c)) return { text: short ? "Yours" : "You’re driving", look: "you" };
  return { text: short ? `${c.bossName}’s` : `${c.bossName} has it`, look: "boss" };
};

/** Who has the wheel, and what that means, in a sentence. */
export const wheelText = (c: ChargeView): string => {
  switch (c.wheel) {
    case "boss":
      return `${c.bossName} runs this session. Typing in it, prompting it or writing to it makes you the driver.`;
    case "person":
      return `${c.bossName}’s messages to it wait while you drive. ${c.bossName} has it back after ${QUIET_MINUTES} quiet minutes.`;
    case "person_pinned":
      return `${c.bossName}’s messages to it wait until you hand it back.`;
  }
};

/** How the boss came to run it, for the badge's title. */
export const howText = (c: ChargeView): string => {
  switch (c.how) {
    case "started":
      return `${c.bossName} started it`;
    case "handed":
      return `You handed it to ${c.bossName}`;
    case "taken":
      return `${c.bossName} takes on every session`;
  }
};

/** Whether a boss can run `s`, as the hub decides it, and why not in the
 *  hub's own words: it needs Desk's line. */
export const chargeable = (s: Session): { ok: true } | { ok: false; why: string } => {
  if (s.origin === "external") return { ok: false, why: "It runs in another terminal. Continue it in Desk first." };
  if (s.state === "closed") return { ok: false, why: "It has ended." };
  if (s.engine === "custom") return { ok: false, why: "A custom command has no line for a boss to talk on." };
  if (!s.caps?.line || s.caps.line === "none") return { ok: false, why: s.caps?.notes[0] ?? `${ENGINE_TITLE[s.engine]} sessions have no line from Desk yet.` };
  return { ok: true };
};

/** What the person can do about who runs `s`. */
export type ChargeVerb = "hand" | "release" | "drive" | "handBack";

export interface ChargeChoice {
  verb: ChargeVerb;
  label: string;
}

/** Hand to Sarah on a session she could run but doesn't (when she does
 *  more than watch); on one she runs, I'll drive or Hand back, and
 *  Release. */
export const chargeChoices = (s: Session, c: ChargeView | null | undefined, boss: Boss | null): ChargeChoice[] => {
  if (c && !c.releasedAt) {
    return [
      driving(c) ? { verb: "handBack", label: "Hand back" } : { verb: "drive", label: "I’ll drive" },
      { verb: "release", label: "Release" },
    ];
  }
  if (!boss || !boss.level || boss.level === "watch" || !chargeable(s).ok) return [];
  return [{ verb: "hand", label: `Hand to ${boss.name}` }];
};
