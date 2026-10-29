import { useSettings } from "../settings/store";

/** A session's name as Desk shows it: the one you gave it, else the hub's. */
export const sessionName = (id: string, hubName: string): string => useSettings.getState().sessionNames[id] ?? hubName;

/** The same, kept current in a component. */
export const useSessionName = (id: string | null | undefined, hubName: string): string =>
  useSettings((s) => (id ? s.sessionNames[id] : undefined)) ?? hubName;

/** Every name you've given, for lists that show many sessions. */
export const useSessionNames = (): Record<string, string> => useSettings((s) => s.sessionNames);
