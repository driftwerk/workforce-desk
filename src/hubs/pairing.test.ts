import { afterEach, describe, expect, it, vi } from "vitest";
import { normaliseHubUrl, pairingStatus, requestPairing } from "./pairing";

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
