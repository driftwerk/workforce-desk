import { expect, it } from "vitest";
import type { EngineInfo } from "../hub/types";
import { ENGINES, ENGINE_TITLE, answersInDesk, signInText, startable } from "./engines";

const info = (engine: EngineInfo["engine"], views: EngineInfo["views"], installed: boolean | null = true): EngineInfo => ({
  engine,
  title: ENGINE_TITLE[engine],
  program: engine,
  installed,
  version: null,
  signIn: { state: "unknown" },
  views,
  caps: {},
});

it("names every engine", () => {
  expect(ENGINES.every((e) => ENGINE_TITLE[e].length > 0)).toBe(true);
});

it("offers what the hub starts and is installed, and Claude Code and Codex from a hub that doesn't say", () => {
  expect(startable(null)).toEqual(["claude", "codex"]);
  expect(
    startable([info("claude", ["terminal"]), info("codex", ["terminal"], false), info("gemini", []), info("devin", ["desk"], null)]),
  ).toEqual(["claude", "devin"]);
});

it("answers approvals in Desk as the caps say, else only for Claude Code", () => {
  const caps = {
    state: "server",
    approvals: "terminal",
    resume: "byId",
    interrupt: "keys",
    plan: "codex",
    notes: [],
  } as const;
  expect(answersInDesk("codex", { ...caps, notes: [] })).toBe(false);
  expect(answersInDesk("claude", undefined)).toBe(true);
  expect(answersInDesk("codex", undefined)).toBe(false);
});

it("says a sign-in in words, the plan's name as the engine says it", () => {
  expect(signInText({ state: "in", via: "plan", who: null, plan: "ultra" })).toBe("Signed in, on ultra plan");
  expect(signInText({ state: "in", via: "vendor", who: null, plan: null })).toBe("Signed in, on its own account");
  expect(signInText({ state: "out" })).toBe("Not signed in");
});
