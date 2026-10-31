import { register, unregister, type ShortcutEvent } from "@tauri-apps/plugin-global-shortcut";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { inTerminal as inTerminalAt } from "../panels/Stage";
import { inApp } from "../platform";
import { useSettings } from "../settings/store";
import { matches, pluginKeys, shortcutLabel, SHORTCUTS, terminalKeys, type GlobalShortcutId, type ShortcutId } from "./keys";

export type ShortcutStatus = { state: "off" } | { state: "ready" } | { state: "taken"; message: string };

interface ShortcutStore {
  status: Record<GlobalShortcutId, ShortcutStatus>;
  /** A shortcut is being recorded: Desk's own step aside so its keys reach
   *  the recorder. */
  recording: boolean;
}

export const useShortcuts = create<ShortcutStore>(() => ({
  status: { pushToTalk: { state: "off" }, ask: { state: "off" } },
  recording: false,
}));

const setStatus = (id: GlobalShortcutId, s: ShortcutStatus) =>
  useShortcuts.setState((store) => ({ status: { ...store.status, [id]: s } }));

/** What the person reads when the system or another app has the keys: which
 *  shortcut it is, and the keys it couldn't get. */
export const takenMessage = (id: GlobalShortcutId, accel: string): string => {
  const name = SHORTCUTS.find((s) => s.id === id)?.name ?? "A shortcut";
  return `${name} can’t use ${shortcutLabel(accel)}: another app already has it — choose other keys`;
};

/** Every register and unregister, one after another: an old shortcut is gone
 *  before its replacement asks for the keys, and a remount's register never
 *  races the unmount's unregister into a false "taken". */
let queue: Promise<void> = Promise.resolve();
const enqueue = (step: () => Promise<void>): Promise<void> => (queue = queue.then(step));

/** Holds `accel` as global shortcut `id` while it's non-null (and Desk isn't
 *  recording one), re-registering when it changes; whether it got the keys is
 *  in `useShortcuts`. */
export function useGlobalShortcut(id: GlobalShortcutId, accel: string | null, onEvent: (e: ShortcutEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const recording = useShortcuts((s) => s.recording);
  const wanted = inApp && !recording ? accel : null;

  useEffect(() => {
    if (!wanted) return;
    let held = false;
    void enqueue(async () => {
      try {
        await register(pluginKeys(wanted), (e) => handler.current(e));
        held = true;
        setStatus(id, { state: "ready" });
      } catch (e) {
        console.warn(`global shortcut ${wanted}: ${e instanceof Error ? e.message : String(e)}`);
        setStatus(id, { state: "taken", message: takenMessage(id, wanted) });
      }
    });
    return () =>
      void enqueue(async () => {
        if (held) await unregister(pluginKeys(wanted)).catch((e) => console.warn(`global shortcut ${wanted}: ${String(e)}`));
        setStatus(id, { state: "off" });
      });
  }, [id, wanted]);
}

/** Whether a key press was made in a terminal pane (Terminal marks its
 *  host `data-terminal`): a shell reads keys there first. */
const inTerminal = (target: EventTarget | null): boolean =>
  (target instanceof Element && target.closest("[data-terminal]") !== null) || inTerminalAt(target);

const isField = (target: Element): boolean =>
  !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

/** Whether a room shortcut may act on a key pressed at `target`: never in a
 *  terminal; in a field only when it is a room composer. */
export const allowedFrom = (target: EventTarget | null): boolean =>
  !inTerminal(target) && (!(target instanceof Element) || !isField(target) || target.closest("[data-composer]") !== null);

/** Runs `onPress` when shortcut `id`'s keys are pressed while Desk is in
 *  front — in a terminal pane, the keys it takes there — unless `enabled`
 *  is false or a shortcut is being recorded. With
 *  `fromFields: false`, keys pressed in a terminal or a field other than a
 *  room composer are left to it. */
export function useAppShortcut(id: ShortcutId, onPress: () => void, enabled = true, opts?: { fromFields: false }) {
  const handler = useRef(onPress);
  handler.current = onPress;
  const keys = useSettings((s) => s.keys[id]);
  const recording = useShortcuts((s) => s.recording);
  const guarded = opts?.fromFields === false;
  useEffect(() => {
    if (!enabled || recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !matches(e, inTerminal(e.target) ? terminalKeys(keys) : keys) || (guarded && !allowedFrom(e.target))) return;
      e.preventDefault();
      handler.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, enabled, recording, guarded]);
}

/** Waits for every queued register and unregister (tests). */
export const settled = (): Promise<void> => queue;
