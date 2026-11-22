import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHubLayout } from "../groups/store";
import { useOverview } from "../overview/store";
import { CARRIED_FRESH_MS, useBossOf, useHomeGrants } from "./chargeStore";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../platform", async (actual) => ({ ...(await actual<object>()), invoke }));

beforeEach(() => {
  vi.useFakeTimers();
  useHomeGrants.setState({ byMachine: {}, readAt: 0 });
  useOverview.setState({ manager: { agentId: "desk", level: "act" } });
  useHubLayout.setState({ layout: { groups: [], ungrouped: { collapsed: false, items: ["session:devbox/s1"] } } });
});

afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
  useHubLayout.setState({ layout: null });
  useOverview.setState({ manager: null });
});

it("reads what each machine holds while shown, and again once that goes stale", async () => {
  invoke.mockResolvedValueOnce({}).mockResolvedValueOnce({ devbox: { ungrouped: "desk" } });
  const { result, rerender } = renderHook(() => useBossOf({ id: "s1", machine: "devbox" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(invoke).toHaveBeenCalledWith("local_boss_grants");
  expect(result.current, "devbox holds no grant for it yet").toBeNull();
  await vi.advanceTimersByTimeAsync(CARRIED_FRESH_MS);
  rerender();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(result.current).toMatchObject({ id: "home/desk", served: true });
});
