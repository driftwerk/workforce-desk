import { deskCall } from "./client";
import type { HubRef } from "./net";
import type { DecideRef, FloorView, UsageView } from "./types";

export type Choice = "allow" | "deny";

/** A hub's floor: what's waiting on the person, what's running, today's
 *  lanes, and the plans' usage, all as the person; and answering a need. */
export const floorOf = (hub: HubRef) => ({
  /** `day`: the start of the person's day, in their own time. */
  floor: (day: Date): Promise<FloorView> => deskCall(hub, "GET", `/api/desk/floor?${new URLSearchParams({ day: localIso(day) })}`),
  usage: (): Promise<UsageView> => deskCall(hub, "GET", "/api/desk/usage"),
  decide: (at: DecideRef, choice: Choice): Promise<void> => deskCall(hub, "POST", "/api/desk/needs/decide", { at, choice }),
});

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, "0");

/** `d` as RFC 3339 in this computer's time, with its offset: `2026-10-29T00:00:00+01:00`. */
export const localIso = (d: Date): string => {
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
};
