import { create } from "zustand";
import { deskState } from "../restore/boot";
import { placeKey, type Place } from "./places";

// How much each place may interrupt you, kept per viewer as
// `notify.<place>`: everything, only what's for you (the default), or
// nothing. A thread follows its room; Activity and the update follow the app.

export type NotifyLevel = "all" | "mine" | "off";

export const NOTIFY_LEVELS: { id: NotifyLevel; label: string }[] = [
  { id: "all", label: "All answers" },
  { id: "mine", label: "Only things for me" },
  { id: "off", label: "Off" },
];

/** The key a place's level is kept under. */
export const prefKey = (place: Place): string => {
  if (place.kind === "thread") return `notify.room:${place.room}`;
  if (place.kind === "activity" || place.kind === "update") return "notify.app";
  return `notify.${placeKey(place)}`;
};

const isLevel = (v: unknown): v is NotifyLevel => v === "all" || v === "mine" || v === "off";

/** Levels set in this window, over what was kept. */
const usePrefs = create<Record<string, NotifyLevel | null>>(() => ({}));

/** A place's level; absent is "mine". */
export const levelOf = (place: Place): NotifyLevel => {
  const key = prefKey(place);
  const set = usePrefs.getState()[key];
  if (set !== undefined) return set ?? "mine";
  const kept = deskState.get(key);
  return isLevel(kept) ? kept : "mine";
};

export const setLevel = (place: Place, level: NotifyLevel): void => {
  const key = prefKey(place);
  if (level === "mine") deskState.remove(key);
  else deskState.set(key, level);
  usePrefs.setState({ [key]: level });
};

/** A room's level goes with it. */
export const forgetRoomLevel = (room: string): void => {
  const key = `notify.room:${room}`;
  deskState.remove(key);
  usePrefs.setState({ [key]: null });
};

/** `levelOf(place)`, kept current. */
export const useLevel = (place: Place): NotifyLevel => {
  usePrefs((s) => s[prefKey(place)]);
  return levelOf(place);
};
