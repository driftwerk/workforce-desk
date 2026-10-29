import { create } from "zustand";
import type { Layout } from "./model";

/** The sidebar's groups as the hub keeps them; null while Desk's settings
 *  hold them (a hub without the routes, or before it has been handed them).
 *  On its own, so what reads it doesn't import the rest of groups/store. */
export const useHubLayout = create<{ layout: Layout | null }>(() => ({ layout: null }));

/** Whether the hub keeps the groups and the names given sessions. */
export const onHub = (): boolean => useHubLayout.getState().layout !== null;
