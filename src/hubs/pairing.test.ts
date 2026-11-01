import { afterEach, describe, expect, it, vi } from "vitest";

// The native side, as pairing reaches it: what each command was asked, and
// what it answers.
const native = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  answers: [] as (unknown | Error)[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    native.calls.push({ cmd, args });
    const a = native.answers.shift();
    if (a instanceof Error) throw a;
    return a;
  }),
  Channel: class {},
  convertFileSrc: (p: string) => p,
}));

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

/** The next answers of the native side, in order. */
const answer = (...a: (unknown | Error)[]) => void native.answers.push(...a);

afterEach(() => {
  vi.restoreAllMocks();
  native.calls.length = 0;
  native.answers.length = 0;
});

describe("pairing", () => {
  it("normalises what people type as a hub address", () => {
    expect(normaliseHubUrl("workforce.example.com/")).toBe("https://workforce.example.com");
    expect(normaliseHubUrl("https://hub.example.com:8443/app")).toBe("https://hub.example.com:8443");
  });

  it("asks the native side for a code, with the page to approve it on", async () => {
    answer({ status: 200, body: { code: "K7Q2XM", approve_url: "https://hub.example.com/pair/K7Q2XM", expires_at: "2026-10-29T10:00:00Z" } });
    expect(await requestPairing("https://hub.example.com", "Desk on Ash")).toEqual({
      code: "K7Q2XM",
      approveUrl: "https://hub.example.com/pair/K7Q2XM",
    });
    expect(native.calls).toEqual([{ cmd: "pair_request", args: { url: "https://hub.example.com", deviceName: "Desk on Ash", identityHint: null } }]);
  });

  it("names you by email only to a hub without browser approval", async () => {
    answer({ status: 200, body: { code: "K7Q2XM" } });
    expect(await requestPairing("https://hub", "Desk", " k@example.com ")).toEqual({ code: "K7Q2XM", approveUrl: null });
    expect(native.calls[0]!.args.identityHint).toBe("k@example.com");
  });

  it("says why a hub wouldn't give a code", async () => {
    answer({ status: 404, body: null }, { status: 429, body: null }, { status: 500, body: null }, { status: 200, body: {} });
    await expect(requestPairing("https://hub", "Desk")).rejects.toThrow(/doesn't accept/);
    await expect(requestPairing("https://hub", "Desk")).rejects.toThrow(/Too many/);
    await expect(requestPairing("https://hub", "Desk")).rejects.toThrow(/500/);
    await expect(requestPairing("https://hub", "Desk")).rejects.toThrow(/no code/);
  });

  it("opens only a web page as the approval page", async () => {
    const page = async (approve_url: string) => {
      answer({ status: 200, body: { code: "C", approve_url } });
      return (await requestPairing("http://hub.local:4100", "Desk")).approveUrl;
    };
    expect(await page("/pair/C")).toBe("http://hub.local:4100/pair/C");
    expect(await page("https://login.example.com/pair/C")).toBe("https://login.example.com/pair/C");
    expect(await page("http://elsewhere.example.com/pair")).toBeNull();
    expect(await page("javascript:alert(1)")).toBeNull();
    expect(await page("file:///etc/passwd")).toBeNull();
  });

  it("asks how a code stands, naming the label an approved one is kept as", async () => {
    answer({ status: "approved", hub: "hub", identity: { name: "Kings", email: "k@example.com" } });
    expect(await pairingStatus("https://hub", "C", "Acme")).toEqual({
      status: "approved",
      hub: "hub",
      identity: { name: "Kings", email: "k@example.com" },
    });
    expect(native.calls).toEqual([{ cmd: "pair_collect", args: { url: "https://hub", code: "C", label: "Acme" } }]);
  });

  it("says who the hub takes Desk to be", async () => {
    const json = { headers: { "content-type": "application/json" } };
    const hub = { id: "hub", url: "https://hub" };
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ display_name: "Kings", email: "k@example.com" }), { status: 200, ...json }));
    expect(await whoAmI(hub)).toEqual({ state: "person", name: "Kings", email: "k@example.com" });
    expect(String(f.mock.calls[0]![0])).toBe("https://hub/api/me");
    f.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await whoAmI(hub)).toEqual({ state: "nobody" });
    f.mockResolvedValueOnce(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await whoAmI(hub)).state).toBe("unknown");
    f.mockRejectedValueOnce(new TypeError("Load failed"));
    expect((await whoAmI(hub)).state).toBe("unknown");
  });
});

describe("a pairing waiting for approval", () => {
  const memory = () => {
    const m = new Map<string, unknown>();
    return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => void m.set(k, v), remove: (k: string) => void m.delete(k) };
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

  it("is kept until the native side has kept the hub, then forgotten; the page never sees a token", async () => {
    const store = memory();
    keepPending(store, p);
    expect(pendingPairing(store)).toEqual(p);
    answer({ status: "pending" }, { status: "approved", hub: "hub-example-com", identity: { name: "Kings", email: "k@example.com" } });
    const saved = vi.fn(async () => {});
    const first = collectPairing(store, p, saved, 1);
    // A second caller (the dialog, after the resume at launch) shares the one collection.
    expect(collectPairing(store, p, saved, 1)).toBe(first);
    expect(await first).toEqual({ label: "Acme", as: { name: "Kings", email: "k@example.com" } });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenCalledWith("hub-example-com");
    expect(pendingPairing(store)).toBeNull();
    expect(native.calls.map((c) => c.cmd)).toEqual(["pair_collect", "pair_collect"]);
  });

  it("says a code already collected was, and keeps it for a fresh try", async () => {
    const store = memory();
    keepPending(store, p);
    answer({ status: "used" });
    await expect(collectPairing(store, p, vi.fn(), 1)).rejects.toThrow(/already/);
    expect(pendingPairing(store)).toEqual(p);
  });

  it("is forgotten when turned down, and kept when the hub can't be reached", async () => {
    const store = memory();
    keepPending(store, p);
    answer({ status: "rejected" });
    await expect(collectPairing(store, p, vi.fn(), 1)).rejects.toBeInstanceOf(PairingEnded);
    expect(pendingPairing(store)).toBeNull();

    keepPending(store, p);
    answer(new Error("Couldn't reach the workspace"));
    await expect(collectPairing(store, p, vi.fn(), 1)).rejects.toThrow("Couldn't reach");
    expect(pendingPairing(store)).toEqual(p);
  });
});
