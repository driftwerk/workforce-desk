import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { EngineInfo } from "../hub/types";
import { Engines } from "./Engines";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

afterEach(cleanup);

const info = (e: Partial<EngineInfo> & Pick<EngineInfo, "engine" | "title">): EngineInfo => ({
  program: e.engine,
  installed: true,
  version: null,
  signIn: { state: "unknown" },
  views: [],
  caps: {},
  ...e,
});

it("lists each engine's version, sign-in and what Desk does with it, the plan's name as the engine says it", async () => {
  const engines = vi.fn(async () => [
    info({
      engine: "claude",
      title: "Claude Code",
      version: "2.1.300",
      signIn: {
        state: "in",
        via: "plan",
        who: "allan@example.com",
        plan: "ultra",
      },
      views: ["terminal"],
    }),
    info({
      engine: "codex",
      title: "Codex",
      version: "0.164.0",
      signIn: { state: "in", via: "key", who: null, plan: null },
      views: ["terminal"],
    }),
    info({ engine: "gemini", title: "Gemini CLI", installed: false }),
    info({
      engine: "custom",
      title: "Custom command",
      program: null,
      installed: null,
    }),
  ]);
  useDesk.setState({ hub: { engines } as unknown as DeskHub });
  render(<Engines />);
  await act(async () => {});
  expect(screen.getByText("Version 2.1.300")).toBeTruthy();
  expect(screen.getByText("Signed in as allan@example.com, on ultra plan")).toBeTruthy();
  expect(screen.getByText("Signed in, on an API key")).toBeTruthy();
  expect(screen.getByText("Not installed")).toBeTruthy();
  expect(screen.getByText("Desk can't start Gemini CLI sessions yet.")).toBeTruthy();
  expect(screen.getAllByText("Desk starts it in a terminal.")).toHaveLength(2);
  expect(screen.getByText("Not checked yet")).toBeTruthy();
});

it("says when the hub couldn't be asked", async () => {
  useDesk.setState({
    hub: {
      engines: vi.fn(async () => Promise.reject(new Error("down"))),
    } as unknown as DeskHub,
  });
  render(<Engines />);
  await act(async () => {});
  expect(screen.getByText("Couldn’t ask the hub about its engines just now.")).toBeTruthy();
});
