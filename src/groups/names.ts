import { useMemo } from "react";
import { LOCAL, sessionKey, splitKey } from "../hub/machines";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { useSettings } from "../settings/store";
import { onHub, useHubLayout } from "./hubLayout";

// A session's name as Desk shows it: the one you gave it, else the hub's.
// The name you gave is the hub's `displayName` when the hub keeps names,
// else Desk's settings'.

const given = (s: Pick<Session, "displayName"> | undefined): string | undefined => s?.displayName?.trim() || undefined;

/** The name you gave session `id` (or `session`, the latest of it). */
export const sessionName = (id: string, hubName: string, session?: Pick<Session, "displayName">): string => {
  if (!onHub()) return useSettings.getState().sessionNames[id] ?? hubName;
  const { sessions, restore } = useDesk.getState();
  return given(session ?? sessions[id] ?? restore.find((r) => r.id === id)) ?? hubName;
};

/** The same, kept current in a component. */
export const useSessionName = (id: string | null | undefined, hubName: string): string => {
  const hub = useHubLayout((s) => s.layout !== null);
  const local = useSettings((s) => (id ? s.sessionNames[id] : undefined));
  const theirs = useDesk((s) => (id ? given(s.sessions[id] ?? s.restore.find((r) => r.id === id)) : undefined));
  return (hub ? theirs : local) ?? hubName;
};

/** Every name you've given, by session id, for lists that show many. */
export const useSessionNames = (): Record<string, string> => {
  const hub = useHubLayout((s) => s.layout !== null);
  const local = useSettings((s) => s.sessionNames);
  // The names given, as one key: a session's every other change (its state,
  // its last reply) leaves every list that names sessions as it is.
  const given_ = useDesk((s) =>
    JSON.stringify(
      [...s.restore, ...Object.values(s.sessions)].flatMap((x) => {
        const name = given(x);
        return name ? [[sessionKey(x), name]] : [];
      }),
    ),
  );
  const theirs = useMemo(() => Object.fromEntries(JSON.parse(given_) as [string, string][]), [given_]);
  // A machine's engine keeps the names given its sessions whichever this
  // computer's hub is.
  const machines = useMemo(() => Object.fromEntries(Object.entries(theirs).filter(([k]) => splitKey(k).machine !== LOCAL)), [theirs]);
  return useMemo(() => (hub ? theirs : { ...machines, ...local }), [hub, theirs, machines, local]);
};
