import { expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat/types";
import { turnOf } from "./Rooms";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

const msg = (m: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "at">): ChatMessage => ({
  content: "",
  status: "complete",
  tools: [],
  ...m,
});

const asked = msg({ id: "u1", role: "user", at: "2026-11-11T11:04:00Z", clientId: "c1" });
// A delivery that came while the turn ran.
const update = msg({ id: "d1", role: "assistant", at: "2026-11-11T11:10:00Z", delivery: "update" });
const answer = msg({
  id: "a1",
  role: "assistant",
  at: "2026-11-11T11:30:00Z",
  replyTo: "c1",
  steps: [{ tool: "connections.setup", ok: true, ms: 900 }],
});
const next = msg({ id: "u2", role: "user", at: "2026-11-11T11:31:00Z" });

it("finds a setup's turn from the message it answers, past a delivery that came mid-turn, to the next message", () => {
  const shown = [asked, update, answer, next];
  expect(turnOf(shown, answer, 2)).toEqual({ turnSince: "2026-11-11T11:04:00Z", turnUntil: "2026-11-11T11:31:00Z" });
  // Not said what it answers: your last message before it.
  const unsaid = { ...answer, replyTo: undefined };
  expect(turnOf([asked, update, unsaid], unsaid, 2)).toEqual({ turnSince: "2026-11-11T11:04:00Z", turnUntil: undefined });
});

it("gives a message that set nothing up no turn, so it isn't rendered again as others come", () => {
  expect(turnOf([asked, update, next], update, 1)).toEqual({});
});

it("starts a second answer's setups after the first's, in a turn that set up two", () => {
  const first = { ...answer, id: "a0", at: "2026-11-11T11:20:00Z" };
  const second = { ...answer, id: "a1", at: "2026-11-11T11:40:00Z" };
  const shown = [asked, first, update, second, next];
  // The delivery between them came mid-turn: no bound.
  expect(turnOf(shown, first, 1)).toEqual({ turnSince: "2026-11-11T11:04:00Z", turnUntil: "2026-11-11T11:40:00Z" });
  expect(turnOf(shown, second, 3)).toEqual({ turnSince: "2026-11-11T11:20:00Z", turnUntil: "2026-11-11T11:31:00Z" });
});
