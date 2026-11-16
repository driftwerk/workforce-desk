// Whether the Updates card shows beside a boss's chat, per agent. Hidden
// unless the person showed it. Kept in Desk's own store (`ui.updatesCard`),
// so every window and the hub have it, never in the page's storage.

import { useSyncExternalStore, type RefObject } from "react";
import { agentKey, type Agent } from "../chat/types";
import { deskState } from "../restore/boot";
import type { DeskStateStore } from "../restore/store";
import { UpdatesCard } from "./Updates";

export const UPDATES_CARD_KEY = "ui.updatesCard";

interface UpdatesCardUi {
  /** The agents (by agent key) whose card is shown. */
  shown: Record<string, true>;
}

const EMPTY: UpdatesCardUi = { shown: {} };

/** What was kept, as far as it can be read: anything else is dropped. */
export const sanitize = (raw: unknown): UpdatesCardUi => {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>).shown : null;
  if (!s || typeof s !== "object") return EMPTY;
  const shown: Record<string, true> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) if (v === true) shown[k] = true;
  return { shown };
};

let cached: { raw: unknown; value: UpdatesCardUi } = { raw: undefined, value: EMPTY };

const read = (store: DeskStateStore): UpdatesCardUi => {
  const raw = store.get(UPDATES_CARD_KEY);
  if (raw !== cached.raw) cached = { raw, value: sanitize(raw) };
  return cached.value;
};

/** Is the Updates card shown beside this agent's chat? */
export const useUpdatesShown = (agent: string, store: DeskStateStore = deskState): boolean =>
  useSyncExternalStore(
    (on) => store.subscribe(UPDATES_CARD_KEY, on),
    () => read(store).shown[agent] === true,
  );

export const setUpdatesShown = (agent: string, show: boolean, store: DeskStateStore = deskState) => {
  const shown = { ...read(store).shown };
  if (show) shown[agent] = true;
  else delete shown[agent];
  store.set(UPDATES_CARD_KEY, { shown });
};

/** Which control takes focus next: the one that takes the place of the one
 *  pressed (the card's once it's there: it waits for the boss's config). */
export type UpdatesFocus = "card" | "head" | null;

const focusIfAsked = (focus: RefObject<UpdatesFocus>, to: "card" | "head") => (el: HTMLButtonElement | null) => {
  if (el && focus.current === to) {
    focus.current = null;
    el.focus();
  }
};

/** The header's way to show the card again, while it's hidden. */
export function ShowUpdates({ agent, focus }: { agent: string; focus: RefObject<UpdatesFocus> }) {
  if (useUpdatesShown(agent)) return null;
  return (
    <button
      ref={focusIfAsked(focus, "head")}
      type="button"
      className="btn btn-ghost btn-sm room-head-updates"
      title="Show how you hear from it, beside the chat"
      onClick={() => {
        focus.current = "card";
        setUpdatesShown(agent, true);
      }}
    >
      Updates
    </button>
  );
}

/** The card beside the boss's chat, while it's shown. */
export function UpdatesBeside({ agent, focus }: { agent: Agent; focus: RefObject<UpdatesFocus> }) {
  const key = agentKey(agent);
  if (!useUpdatesShown(key)) return null;
  return (
    <UpdatesCard
      agent={agent}
      hideRef={focusIfAsked(focus, "card")}
      onHide={() => {
        focus.current = "head";
        setUpdatesShown(key, false);
      }}
    />
  );
}
