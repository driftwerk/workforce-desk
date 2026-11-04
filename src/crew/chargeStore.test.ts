import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { deskListeners, useDesk } from "../hub/store";
import type { ChargeView, DeskEvent, LineMessage } from "../hub/types";
import { useLine } from "../line/store";
import { DESK, S1, msg } from "../line/testing";
import { badgeOf, called, chargeChoices } from "./charge";
import { useCharges } from "./chargeStore";
import { lined } from "../line/testing";

const charge = (more: Partial<ChargeView> = {}): ChargeView => ({
  session: "s1",
  group: null,
  boss: "sarah",
  bossName: "Sarah",
  how: "handed",
  wheel: "boss",
  wheelSince: null,
  since: "2026-11-03T10:00:00Z",
  releasedAt: null,
  ...more,
});

/** A promise the test settles. */
const later = <T,>() => {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((r) => (settle = r));
  return { promise, settle };
};

const say = (e: DeskEvent) => deskListeners.forEach((f) => f(e));

beforeEach(() => {
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }], roster: [] });
  useLine.setState({ threads: {}, problems: {} });
});
afterEach(() => {
  useDesk.setState({ hub: null });
  useCharges.setState({ bySession: {}, supported: null });
});

describe("the charges Desk keeps", () => {
  it("never lays a read that began before a charge was heard over it", async () => {
    const read = later<ChargeView[]>();
    useDesk.setState({ hub: { charges: () => read.promise } as never });
    useCharges.setState({ bySession: {}, supported: null });
    const loading = useCharges.getState().load();
    useCharges.getState().heard(charge({ wheel: "person" }));
    read.settle([charge()]);
    await loading;
    expect(useCharges.getState().bySession.s1?.wheel).toBe("person");
    // A read with nothing heard meanwhile stands.
    useDesk.setState({ hub: { charges: () => Promise.resolve([charge({ wheel: "person_pinned" })]) } as never });
    await useCharges.getState().load();
    expect(useCharges.getState().bySession.s1?.wheel).toBe("person_pinned");
  });

  it("forgets another hub's charges, and reads them again on every snapshot, even from a hub that had none", async () => {
    const charges = vi.fn(() => Promise.resolve(null as ChargeView[] | null));
    useDesk.setState({ hub: { charges } as never });
    useCharges.setState({ bySession: { s1: charge() }, supported: true });
    useDesk.setState({ hub: { charges } as never });
    expect(useCharges.getState()).toMatchObject({ bySession: {}, supported: null });
    say({ type: "snapshot", sessions: [], restore: [], rooms: [] });
    await vi.waitFor(() => expect(useCharges.getState().supported).toBe(false));
    // Updated meanwhile: the next snapshot finds its charges.
    charges.mockResolvedValue([charge()]);
    say({ type: "snapshot", sessions: [], restore: [], rooms: [] });
    await vi.waitFor(() => expect(useCharges.getState().bySession.s1).toBeTruthy());
    expect(useCharges.getState().supported).toBe(true);
  });

  it("names a boss the hub only knows by id as your overseer, and by its name once the roster has it", () => {
    useCharges.getState().heard(charge({ bossName: "sarah" }));
    const shown = () => useCharges.getState().bySession.s1!;
    expect(badgeOf(shown())?.text).toBe("Your overseer has it");
    expect(chargeChoices(lined(), undefined, { id: "sarah", name: "", level: "act" })[0]?.label).toBe("Hand to your overseer");
    useChat.setState({ roster: [{ hubId: "local", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: true }] });
    expect(badgeOf(shown())?.text).toBe("Sarah has it");
    expect(called("")).toBe("your overseer");
    expect(called("", true)).toBe("Your overseer");
    expect(called("Mia", true)).toBe("Mia");
  });

  it("reads a session's thread again when its wheel changes hands, for why the boss's tells wait", async () => {
    const tell = msg({ from: DESK, to: S1, kind: "tell", asked: null, delivery: "queued", deliveredAt: null, waiting: "working" });
    const lineThread = vi.fn((): Promise<LineMessage[]> => Promise.resolve([{ ...tell, waiting: "person_driving" }]));
    useDesk.setState({ hub: { lineThread } as never });
    useLine.setState({ threads: { s1: [tell] } });
    useCharges.getState().heard(charge());
    useCharges.getState().heard(charge({ wheel: "person" }));
    await vi.waitFor(() => expect(useLine.getState().threads.s1?.[0]?.waiting).toBe("person_driving"));
    expect(lineThread).toHaveBeenCalled();
  });
});

describe("a session's thread, read", () => {
  it("is read again when a message was heard while it was being read", async () => {
    const first = later<LineMessage[]>();
    const old = msg({ from: DESK, to: S1, kind: "tell", asked: null, delivery: "queued", deliveredAt: null });
    const reads = [first.promise, Promise.resolve([{ ...old, delivery: "delivered" as const }])];
    const lineThread = vi.fn(() => reads.shift()!);
    useDesk.setState({ hub: { lineThread } as never });
    useLine.setState({ threads: { s1: [old] } });
    const loading = useLine.getState().load("s1");
    useLine.getState().heard({ ...old, delivery: "delivered" });
    first.settle([old]);
    await loading;
    expect(lineThread).toHaveBeenCalledTimes(2);
    expect(useLine.getState().threads.s1?.[0]?.delivery).toBe("delivered");
  });
});
