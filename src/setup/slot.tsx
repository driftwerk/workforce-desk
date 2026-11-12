import type { ComponentType } from "react";
import { create } from "zustand";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import { useSettings } from "../settings/store";

/** The setup's views, put here by the main window: only it runs the setup
 *  (starting Desk's helper, pairing, adding machines are its alone), so a
 *  grid's window, which imports this and not them, shows none of it. */
export const useSetupViews = create<{
  inDm: ComponentType<{ agent: Agent }> | null;
  onFloor: ComponentType | null;
}>(() => ({ inDm: null, onFloor: null }));

/** Desk's own agent: this computer's hub's default one, else its first. */
export const useDeskAgent = (): Agent | undefined => {
  const local = useChat((s) => s.hubs.find((h) => h.local)?.id ?? null);
  return useChat((s) => s.roster.find((a) => a.hubId === local && a.isDefault) ?? s.roster.find((a) => a.hubId === local));
};

/** The setup shows: offered, and not closed. */
export const useSetupOpen = (): boolean => useSettings((s) => s.loaded && !!s.setup?.started && !s.setup.closed);

/** The setup said in Desk's agent's DM, where the main window shows it. */
export function SetupInDm({ agent }: { agent: Agent }) {
  const View = useSetupViews((s) => s.inDm);
  const desk = useDeskAgent();
  const open = useSetupOpen();
  return View && open && desk === agent ? <View agent={agent} /> : null;
}

/** The setup on the Floor, where the main window shows it. */
export function SetupFloor() {
  const View = useSetupViews((s) => s.onFloor);
  return View ? <View /> : null;
}
