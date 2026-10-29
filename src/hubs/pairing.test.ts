import { afterEach, describe, expect, it, vi } from "vitest";
import { collectPairing, keepPending, normaliseHubUrl, PairingEnded, pairingStatus, pendingPairing, requestPairing } from "./pairing";

const respond = (status: number, body?: unknown) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status }));

afterEach(() => vi.restoreAllMocks());

describe("pairing", () => {
  it("normalises what people type as a hub address", () => {
    expect(normaliseHubUrl("workforce.example.com/")).toBe("https://workforce.example.com");
    expect(normaliseHubUrl("https://hub.example.com:8443/app")).toBe("https://hub.example.com:8443");
  });

  it("asks for a code as a desk device", async () => {
    const f = respond(200, { code: "K7Q2XM" });
    expect(await requestPairing("https://hub", "Desk on Ash", "k@example.com")).toBe("K7Q2XM");
    const body = JSON.parse(f.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ device_name: "Desk on Ash", identity_hint: "k@example.com", device_kind: "desk" });
  });

  it("reads each status", async () => {
    respond(200, { status: "pending" });
    expect(await pairingStatus("https://hub", "C")).toEqual({ status: "pending" });
    respond(200, { status: "approved", token: "wfp_x" });
    expect(await pairingStatus("https://hub", "C")).toEqual({ status: "approved", token: "wfp_x" });
    respond(404);
    expect(await pairingStatus("https://hub", "C")).toEqual({ status: "expired" });
    respond(200, { status: "approved" });
    await expect(pairingStatus("https://hub", "C")).rejects.toThrow(/already/);
  });
});

describe("a pairing waiting for approval", () => {
  const memory = () => {
    const m = new Map<string, unknown>();
    return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => void m.set(k, v), remove: (k: string) => void m.delete(k) };
  };
  const statuses = (...bodies: { status: number; body?: unknown }[]) => {
    const f = vi.spyOn(globalThis, "fetch");
    for (const b of bodies) f.mockResolvedValueOnce(new Response(b.body === undefined ? null : JSON.stringify(b.body), { status: b.status }));
    return f;
  };
  const p = { url: "https://hub.example.com", label: "Acme", code: "8CA2" };

  it("is kept until it's approved, then saved once and forgotten", async () => {
    const store = memory();
    keepPending(store, p);
    expect(pendingPairing(store)).toEqual(p);
    statuses({ status: 200, body: { status: "pending" } }, { status: 200, body: { status: "approved", token: "wfp_x" } });
    const save = vi.fn(async () => {});
    const first = collectPairing(store, p, save, 1);
    // A second caller (the dialog, after the resume at launch) shares the one collection.
    expect(collectPairing(store, p, save, 1)).toBe(first);
    expect(await first).toBe("Acme");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("Acme", "https://hub.example.com", "wfp_x");
    expect(pendingPairing(store)).toBeNull();
  });

  it("is forgotten when turned down, and kept when the hub can't be reached", async () => {
    const store = memory();
    keepPending(store, p);
    statuses({ status: 200, body: { status: "rejected" } });
    await expect(collectPairing(store, p, vi.fn(), 1)).rejects.toBeInstanceOf(PairingEnded);
    expect(pendingPairing(store)).toBeNull();

    keepPending(store, p);
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Load failed"));
    await expect(collectPairing(store, p, vi.fn(), 1)).rejects.toThrow("Load failed");
    expect(pendingPairing(store)).toEqual(p);
  });
});
