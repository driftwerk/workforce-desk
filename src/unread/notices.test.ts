import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Notice } from "./notices";

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../restore/boot", () => ({
  deskState: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => void state.set(k, v), remove: (k: string) => void state.delete(k) },
}));
const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("../shell/notify", async (real) => ({ ...(await real<object>()), notify: async (n: unknown) => void sent.push(n) }));

const { useDesk } = await import("../hub/store");
const { useReads } = await import("./reads");
const { interrupts, notifyPlace, resetSent } = await import("./notices");
const { setLevel } = await import("./prefs");

const room = { kind: "room", room: "r1" } as const;
const n = (over: Partial<Notice> = {}): Notice => ({ place: room, urgency: "forYou", id: "x", title: "t", body: "b", ...over });

beforeEach(() => {
  state.clear();
  sent.length = 0;
  resetSent();
  useDesk.setState({ detached: false });
  useReads.setState({ local: {}, dms: {}, loaded: true });
});

describe("what interrupts you", () => {
  it("follows the level, row by row", () => {
    const rows: [string, Notice, boolean, boolean, boolean][] = [
      ["a prompt waits on you", n({ urgency: "needs" }), true, true, false],
      ["an approval delivery", n({ urgency: "forYou" }), true, true, false],
      ["an answer failed", n({ urgency: "needs" }), true, true, false],
      ["an answer to you after a minute", n({ urgency: "forYou", quick: false }), true, true, false],
      ["a quick answer to you", n({ urgency: "forYou", quick: true }), false, true, false],
      ["another answer or a hand-off", n({ urgency: "new" }), false, true, false],
      ["a reminder", n({ urgency: "forYou" }), true, true, false],
      ["a job's, workflow's or check-in's delivery", n({ urgency: "forYou", quiet: true }), false, true, false],
    ];
    for (const [what, notice, mine, all, off] of rows) {
      expect([what, interrupts(notice, "mine"), interrupts(notice, "all"), interrupts(notice, "off")]).toEqual([what, mine, all, off]);
    }
  });
});

describe("sending a notification", () => {
  it("sends each once, at the place's level, and none from a detached window", () => {
    notifyPlace(n({ id: "a" }));
    notifyPlace(n({ id: "a" }));
    setLevel(room, "off");
    notifyPlace(n({ id: "b" }));
    setLevel({ kind: "thread", room: "r1", thread: "t1" }, "all");
    notifyPlace(n({ id: "c", place: { kind: "thread", room: "r1", thread: "t1" }, urgency: "new" }));
    useDesk.setState({ detached: true });
    notifyPlace(n({ id: "d", urgency: "needs" }));
    expect(sent).toHaveLength(2);
  });

  it("sends none for what another Desk of yours read first", () => {
    useReads.setState({ local: { "room:r1": { at: "2026-10-30T10:00:00Z", message: "m9" } }, dms: {}, loaded: true });
    notifyPlace(n({ id: "e", at: "2026-10-30T09:59:00Z" }));
    notifyPlace(n({ id: "f", at: "2026-10-30T10:01:00Z" }));
    expect(sent).toHaveLength(1);
  });
});

describe("sessions", () => {
  it("tell you when one starts needing you, not again for the same state", async () => {
    const { noticesFrom } = await import("./notices");
    const s = (state: string, updatedAt: string) => ({ id: "s1", name: "acme-web", state, live: true, updatedAt, pending: null }) as never;
    noticesFrom({ type: "snapshot", sessions: [s("working", "1")], restore: [], rooms: [] });
    noticesFrom({ type: "session", session: s("blocked", "2") });
    noticesFrom({ type: "session", session: s("blocked", "3") });
    expect(sent).toEqual([{ title: "acme-web needs you", body: "Waiting for an answer" }]);
  });
});
