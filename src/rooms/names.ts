import { useCallback } from "react";
import { useChat } from "../chat/store";
import type { Agent, HubAccount } from "../chat/types";
import { memberOf } from "./routing";

/** Who an author key names (`you`, `desk` or `hub/agent`), and where they live. */
export const authorOf = (key: string, roster: readonly Agent[], hubs: readonly HubAccount[]): { name: string; home: string } => {
  if (key === "you") return { name: "You", home: "" };
  if (key === "desk") return { name: "Desk", home: "" };
  const m = memberOf(key);
  return {
    name: roster.find((a) => a.hubId === m?.hub && a.id === m.agent)?.name ?? m?.agent ?? key,
    home: hubs.find((h) => h.id === m?.hub)?.label ?? m?.hub ?? key,
  };
};

/** `authorOf` over the roster and hubs Desk has now. */
export function useAuthor(): (key: string) => { name: string; home: string } {
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  return useCallback((key: string) => authorOf(key, roster, hubs), [roster, hubs]);
}
