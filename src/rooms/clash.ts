import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import type { Room } from "../hub/types";

/** The room other than `id` already called `name`, as the hub compares
 *  names (case and spacing aside). */
export const sameName = (name: string, id: string | null = null): Room | null => {
  const fold = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ");
  const want = fold(name);
  return Object.values(useDesk.getState().rooms).find((r) => r.id !== id && fold(r.name) === want) ?? null;
};

/** The room a save was refused for having the name of, when that's why:
 *  every other 409 (a workspace to ask about, a room changed meanwhile)
 *  is something else. */
export const nameClash = (e: unknown, name: string, id: string | null = null): Room | null =>
  e instanceof HubError && e.status === 409 && !e.hubs?.length ? sameName(name, id) : null;
