/** Pairing Desk with a remote hub, the way the iPhone pairs: ask for a code,
 *  the person approves it on that hub, Desk collects a device token once. */

export type PairStatus =
  | { status: "pending" }
  | { status: "approved"; token: string }
  | { status: "rejected" }
  | { status: "expired" };

export const normaliseHubUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  return `${u.protocol}//${u.host}`;
};

export const requestPairing = async (url: string, deviceName: string, email: string): Promise<string> => {
  const res = await fetch(`${url}/api/pair/device/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_name: deviceName, identity_hint: email || undefined, device_kind: "desk" }),
  });
  if (res.status === 404) throw new Error("That hub doesn't accept device pairing.");
  if (res.status === 429) throw new Error("Too many pairing attempts — wait a minute and try again.");
  if (!res.ok) throw new Error(`The hub refused the pairing request (${res.status}).`);
  return ((await res.json()) as { code: string }).code;
};

export const pairingStatus = async (url: string, code: string): Promise<PairStatus> => {
  const res = await fetch(`${url}/api/pair/device/status/${encodeURIComponent(code)}`);
  if (res.status === 404) return { status: "expired" };
  if (!res.ok) throw new Error(`The hub could not report the pairing (${res.status}).`);
  const body = (await res.json()) as { status: string; token?: string };
  if (body.status === "approved") {
    if (!body.token) throw new Error("Approved, but the hub already handed this token out. Pair again.");
    return { status: "approved", token: body.token };
  }
  return body.status === "rejected" ? { status: "rejected" } : { status: "pending" };
};
