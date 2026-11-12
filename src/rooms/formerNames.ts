import { onRenamed } from "../chat/store";
import { agentKey } from "../chat/types";
import { useSettings } from "../settings/store";
import { handle, setFormerly } from "./mentions";

/** How many names before a rename an agent still answers to. */
const KEPT = 5;

/** `formerNames` with `was` as the name before `now` for agent `key`:
 *  newest first, once each, never the name it has now. */
export const withFormerName = (formerNames: Readonly<Record<string, string[]>>, key: string, was: string, now: string): Record<string, string[]> => {
  const kept = [was, ...(formerNames[key] ?? [])].filter((n, i, all) => handle(n) !== handle(now) && all.findIndex((o) => handle(o) === handle(n)) === i);
  return { ...formerNames, [key]: kept.slice(0, KEPT) };
};

/** Keeps the names agents had before a rename, so an `@` by one of them in
 *  a room still reaches them (a name another agent has now goes to that
 *  agent). Desk notes a rename however it was made: in an agent's
 *  settings, by asking an agent, or elsewhere. */
export const rememberFormerNames = (): void => {
  onRenamed((key, was, now) => {
    const { formerNames, set } = useSettings.getState();
    set({ formerNames: withFormerName(formerNames, key, was, now) });
  });
  setFormerly((a) => useSettings.getState().formerNames[agentKey(a)] ?? []);
};
