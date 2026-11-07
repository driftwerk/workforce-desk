import { expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { LOCAL, type MachineId } from "../hub/machines";
import { useDesk } from "../hub/store";
import type { AccountStanding, EngineAccount } from "../hub/types";
import { newerFor, passStanding } from "./standing";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

const standing = (hitAt: string | null, readAt: string | null = null): AccountStanding => ({
  windows: readAt ? [{ usedPercent: 100, resetsAt: "2026-11-12T09:00:00Z", minutes: 10_080 }] : [],
  readAt,
  hitAt,
  hitUntil: hitAt ? "2026-11-12T09:00:00Z" : null,
  hitWindow: hitAt ? 10_080 : null,
});

const account = (id: string, name: string, s: AccountStanding | null = null): EngineAccount => ({
  id,
  engine: "claude",
  name,
  isDefault: false,
  signedIn: true,
  sessions: [],
  createdAt: "2026-11-01T00:00:00Z",
  standing: s,
});

it("passes only what the other computer doesn't know yet, by account name", () => {
  const mine = [account("w", "Kingsley Starmoire", standing("2026-11-06T22:00:00Z")), account("p", "Kingsley Gmail")];
  const theirs = [account("m-w", "kingsley starmoire"), account("m-p", "Kingsley Gmail")];
  expect(newerFor(mine, theirs)).toEqual([{ engine: "claude", name: "Kingsley Starmoire", standing: mine[0]!.standing }]);
  // Known there already, or newer there: nothing to pass.
  const known = [account("m-w", "Kingsley Starmoire", standing("2026-11-06T22:00:00Z"))];
  expect(newerFor(mine, known)).toEqual([]);
  // An account the machine hasn't got: never passed.
  expect(newerFor(mine, [account("m-x", "Other")])).toEqual([]);
});

it("tells a machine what this Mac knows, and this Mac what the machine read", async () => {
  const machine = "devbox" as MachineId;
  const mac = { learnStanding: vi.fn(async () => undefined) };
  const box = { learnStanding: vi.fn(async () => undefined) };
  useDesk.setState({ hub: mac as unknown as DeskHub, engines: { [machine]: { hub: box } } as never });
  const full = standing("2026-11-06T22:00:00Z");
  const read = standing(null, "2026-11-07T08:00:00Z");
  const accounts: Record<string, EngineAccount[]> = {
    [LOCAL]: [account("w", "Work", full), account("p", "Personal")],
    [machine]: [account("m-w", "Work"), account("m-p", "Personal", read)],
  };
  await passStanding((m) => accounts[m] ?? [], [LOCAL, machine]);
  expect(box.learnStanding).toHaveBeenCalledWith([{ engine: "claude", name: "Work", standing: full }]);
  expect(mac.learnStanding).toHaveBeenCalledWith([{ engine: "claude", name: "Personal", standing: read }]);
});
