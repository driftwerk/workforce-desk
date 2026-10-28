import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HubError, type DeskHub } from "../hub/client";
import type { Provider } from "../hub/providers";
import { useDesk } from "../hub/store";
import { useProviderList, useProviders } from "./store";

const listed: Provider = {
  id: "anthropic",
  name: "Anthropic API",
  group: "key",
  description: "",
  connected: false,
  connect: { kind: "fields", fields: [] },
  models: [],
  efforts: [],
};

const hubThat = (providers: () => Promise<Provider[]>) =>
  ({ providers: vi.fn(providers), vaultPaths: vi.fn(async () => []) }) as unknown as DeskHub;

beforeEach(() => useProviders.setState({ providers: [], fallback: false, loaded: false, loading: false, problem: null }));

describe("the provider list", () => {
  it("asks again when a screen showing it opens, so a hub that has since learned the route is heard", async () => {
    let ready = false;
    const hub = hubThat(async () => {
      if (!ready) throw new HubError(404, "not yet");
      return [listed];
    });
    act(() => useDesk.setState({ hub }));
    const first = renderHook(() => useProviderList({ fresh: true }));
    await waitFor(() => expect(useProviders.getState().fallback).toBe(true));
    first.unmount();

    ready = true;
    renderHook(() => useProviderList({ fresh: true }));
    await waitFor(() => expect(useProviders.getState().providers.map((p) => p.id)).toEqual(["anthropic"]));
    expect(useProviders.getState().fallback).toBe(false);
  });

  it("loads once for screens that only read it", async () => {
    const hub = hubThat(async () => [listed]);
    act(() => useDesk.setState({ hub }));
    renderHook(() => useProviderList()).unmount();
    await waitFor(() => expect(useProviders.getState().loaded).toBe(true));
    renderHook(() => useProviderList());
    expect(hub.providers).toHaveBeenCalledTimes(1);
  });
});
