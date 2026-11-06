import { expect, it } from "vitest";
import { summaryLine } from "./summary";
import { machine } from "./testing";
import { clock, freeText, inTime, offlineWhy, rowLines, sshTail } from "./words";

const at = (s: string) => new Date(s).getTime();

it("says times as a row does: today's by the clock, others with their day", () => {
  const now = at("2026-11-06T09:41:30");
  expect(clock(at("2026-11-06T08:55:00"), now)).toBe("08:55");
  expect(clock(at("2026-11-05T10:00:00"), now)).toBe("5 Nov 10:00");
  expect(inTime(now + 40_000, now)).toBe("in 40 s");
  expect(inTime(now + 300_000, now)).toBe("in 5 min");
  expect(inTime(now - 1, now)).toBe("now");
  expect(freeText(1_700_000_000)).toBe("1.7 TB");
  expect(freeText(180_000)).toBe("180 MB");
});

it("says why a machine is offline in Desk's words, then ssh's", () => {
  expect(sshTail("ssh: connect to host 10.0.3.14 port 22: Connection timed out")).toBe("Connection timed out after 15 s.");
  expect(sshTail("ssh: Could not resolve hostname gone-box: Name or service not known")).toBe("Could not resolve hostname gone-box: Name or service not known.");
  const m = machine({
    id: "buildbox",
    state: { kind: "unreachable" },
    reason: "SSH couldn't reach buildbox: “ssh: connect to host 10.0.3.14 port 22: Connection timed out”",
    said: "ssh: connect to host 10.0.3.14 port 22: Connection timed out",
    reach: { user: null, hostname: null, port: null, via: "bastion", entry: null, file: null },
  });
  expect(offlineWhy(m)).toBe("SSH couldn’t reach buildbox through bastion. Connection timed out after 15 s.");
  expect(offlineWhy(machine({ id: "x", state: { kind: "unreachable" } }))).toBe("SSH couldn’t reach x.");
  const lines = rowLines({ ...m, nextTry: at("2026-11-06T09:42:10") }, { desk: "0.2.1", sessions: 1, now: at("2026-11-06T09:41:30") });
  expect(lines).toEqual({ first: "Offline: SSH couldn’t reach buildbox through bastion. Connection timed out after 15 s.", tone: "blocked", second: "its 1 session keeps running there · next try in 40 s" });
});

it("says a connected machine that can't start sessions needs a sign-in", () => {
  const lines = rowLines(machine({ id: "devbox", version: "0.2.1" }), { desk: "0.2.1", sessions: 0, claudeIn: false });
  expect(lines.first).toBe("Needs sign-in: Claude isn’t signed in there yet, so sessions can’t start.");
  expect(lines.tone).toBe("blocked");
});

it("says who each engine is signed in as", () => {
  const e = (engine: string, signIn: object) => ({ engine, title: engine, program: engine, installed: true, version: "1", views: ["terminal"], caps: {}, signIn }) as never;
  expect(summaryLine([e("claude", { state: "in", via: "plan", who: "kings@starmoire.dev" }), e("codex", { state: "in", via: "plan", who: null })], 0)).toBe(
    "Claude signed in as kings@starmoire.dev · Codex signed in",
  );
  expect(summaryLine([e("claude", { state: "out" }), e("codex", { state: "out" })], 2)).toBe("Claude on 2 accounts");
  expect(summaryLine([e("claude", { state: "out" })], 0)).toBeNull();
});
