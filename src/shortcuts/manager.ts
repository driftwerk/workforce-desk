import { register, unregister, type ShortcutEvent } from "@tauri-apps/plugin-global-shortcut";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { inApp } from "../platform";
import { shortcutLabel, type ShortcutId } from "./keys";

export type ShortcutStatus = { state: "off" } | { state: "ready" } | { state: "taken"; message: string };

interface ShortcutStore {
  status: Record<ShortcutId, ShortcutStatus>;
  /** A shortcut is being recorded: Desk's own step aside so its keys reach
   *  the recorder. */
  recording: boolean;
}

export const useShortcuts = create<ShortcutStore>(() => ({
  status: { pushToTalk: { state: "off" }, ask: { state: "off" } },
  recording: false,
}));

const setStatus = (id: ShortcutId, s: ShortcutStatus) =>
  useShortcuts.setState((store) => ({ status: { ...store.status, [id]: s } }));

/** What the person reads when macOS or another app has the keys. */
export const takenMessage = (accel: string): string => `${shortcutLabel(accel)} is taken by another app — choose another`;

/** Every register and unregister, one after another: an old shortcut is gone
 *  before its replacement asks for the keys, and a remount's register never
 *  races the unmount's unregister into a false "taken". */
let queue: Promise<void> = Promise.resolve();
const enqueue = (step: () => Promise<void>): Promise<void> => (queue = queue.then(step));

/** Holds `accel` as global shortcut `id` while it's non-null (and Desk isn't
 *  recording one), re-registering when it changes; whether it got the keys is
 *  in `useShortcuts`. */
export function useGlobalShortcut(id: ShortcutId, accel: string | null, onEvent: (e: ShortcutEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const recording = useShortcuts((s) => s.recording);
  const wanted = inApp && !recording ? accel : null;

  useEffect(() => {
    if (!wanted) return;
    let held = false;
    void enqueue(async () => {
      try {
        await register(wanted, (e) => handler.current(e));
        held = true;
        setStatus(id, { state: "ready" });
      } catch (e) {
        console.warn(`global shortcut ${wanted}: ${e instanceof Error ? e.message : String(e)}`);
        setStatus(id, { state: "taken", message: takenMessage(wanted) });
      }
    });
    return () =>
      void enqueue(async () => {
        if (held) await unregister(wanted).catch((e) => console.warn(`global shortcut ${wanted}: ${String(e)}`));
        setStatus(id, { state: "off" });
      });
  }, [id, wanted]);
}

/** Waits for every queued register and unregister (tests). */
export const settled = (): Promise<void> => queue;
