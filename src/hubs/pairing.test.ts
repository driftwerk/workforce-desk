import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectPairing,
  keepPending,
  lastEmail,
  normaliseHubUrl,
  PairingEnded,
  pairingStatus,
  pendingPairing,
  rememberEmail,
  requestPairing,
  whoAmI,
} from "./pairing";

const respond = (status: number, body?: unknown) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status }));

afterEach(() => vi.restoreAllMocks());

describe("pairing", () => {
  it("normalises what people type as a hub address", () => {
    expect(normaliseHubUrl("workforce.example.com/")).toBe("https://workforce.example.com");
    expect(normaliseHubUrl("https://hub.example.com:8443/app")).toBe("https://hub.example.com:8443");
  });

  it("asks for a code as a desktop device, with the page to approve it on", async () => {
    const f = respond(200, { code: "K7Q2XM", approve_url: "https://hub.example.com/pair/K7Q2XM", expires_at: "2026-10-29T10:00:00Z" });
    expect(await requestPairing("https://hub.example.com", "Desk on Ash")).toEqual({
      code: "K7Q2XM",
      approveUrl: "https://hub.example.com/pair/K7Q2XM",
    });
    const body = JSON.parse(f.mock.calls[0]![1]!.body as string);
    // A kind the hub doesn't look devices up under would pair and then never
    // resolve to the person.
    expect(body).toEqual({ device_name: "Desk on Ash", device_kind: "desktop_device" });
  });

  it("names you by email only to a hub without browser approval", async () => {
    const f = respond(200, { code: "K7Q2XM" });
    expect(await requestPairing("https://hub", "Desk", " k@example.com ")).toEqual({ code: "K7Q2XM", approveUrl: null });
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({
      device_name: "Desk",
      device_kind: "desktop_device",
      identity_hint: "k@example.com",
    });
  });

  it("opens only a web page as the approval page", async () => {
    const page = async (approve_url: string) => {
      respond(200, { code: "C", approve_url });
      return (await requestPairing("http://hub.local:4100", "Desk")).approveUrl;
    };
    expect(await page("/pair/C")).toBe("http://hub.local:4100/pair/C");
    expect(await page("https://login.example.com/pair/C")).toBe("https://login.example.com/pair/C");
    expect(await page("http://elsewhere.example.com/pair")).toBeNull();
    expect(await page("javascript:alert(1)")).toBeNull();
    expect(await page("file:///etc/passwd")).toBeNull();
  });

  it("reads each status, and who approved it", async () => {
    respond(200, { status: "pending" });
    expect(await pairingStatus("https://hub", "C")).toEqual({ status: "pending" });
    respond(200, { status: "approved", token: "wfp_x", identity: { display_name: "Kings", email: "k@example.com" } });
    expect(await pairingStatus("https://hub", "C")).toEqual({
      status: "approved",
      token: "wfp_x",
      identity: { name: "Kings", email: "k@example.com" },
    });
    respond(200, { status: "approved", token: "wfp_x" });
    expect(await pairingStatus("https://hub", "C")).toEqual({ status: "approved", token: "wfp_x", identity: null });
    respond(404);
    expect(await pairingStatus("https://hub", "C")).toEqual({ status: "expired" });
    respond(200, { status: "approved" });
    await expect(pairingStatus("https://hub", "C")).rejects.toThrow(/already/);
  });

  it("says who the hub takes a token to be", async () => {
    const json = { headers: { "content-type": "application/json" } };
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ display_name: "Kings", email: "k@example.com" }), { status: 200, ...json }));
    expect(await whoAmI("https://hub", "wfp_x")).toEqual({ state: "person", name: "Kings", email: "k@example.com" });
    expect(new Headers(f.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer wfp_x");
    f.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await whoAmI("https://hub", "wfp_x")).toEqual({ state: "nobody" });
    f.mockResolvedValueOnce(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await whoAmI("https://hub", "wfp_x")).state).toBe("unknown");
    f.mockRejectedValueOnce(new TypeError("Load failed"));
    expect((await whoAmI("https://hub", "wfp_x")).state).toBe("unknown");
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

  it("keeps the page it's approved on, for after a reload", () => {
    const store = memory();
    keepPending(store, { ...p, approveUrl: "https://hub.example.com/pair/8CA2" });
    expect(pendingPairing(store)).toEqual({ ...p, approveUrl: "https://hub.example.com/pair/8CA2" });
    keepPending(store, { ...p, approveUrl: "javascript:alert(1)" });
    expect(pendingPairing(store)).toEqual(p);
  });

  it("remembers the email it was asked for with", () => {
    const store = memory();
    expect(lastEmail(store)).toBeNull();
    rememberEmail(store, " k@example.com ");
    expect(lastEmail(store)).toBe("k@example.com");
  });

  it("is kept until it's approved, then saved once and forgotten", async () => {
    const store = memory();
    keepPending(store, p);
    expect(pendingPairing(store)).toEqual(p);
    statuses(
      { status: 200, body: { status: "pending" } },
      { status: 200, body: { status: "approved", token: "wfp_x", identity: { display_name: "Kings", email: "k@example.com" } } },
    );
    const save = vi.fn(async () => {});
    const first = collectPairing(store, p, save, 1);
    // A second caller (the dialog, after the resume at launch) shares the one collection.
    expect(collectPairing(store, p, save, 1)).toBe(first);
    expect(await first).toEqual({ label: "Acme", as: { name: "Kings", email: "k@example.com" } });
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
