import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { HubAccount } from "../chat/types";
import { PairHub } from "../hubs/PairHub";
import { keepPending } from "../hubs/pairing";
import { setDevToken } from "../hub/devTokens";
import { hubAccounts, invoke, openUrl, renameHub } from "../platform";
import { deskState } from "../restore/boot";
import { Hubs } from "./Hubs";

vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  invoke: vi.fn(() => Promise.resolve()),
  statePut: vi.fn(() => Promise.resolve()),
  stateRemove: vi.fn(() => Promise.resolve()),
  hubAccounts: vi.fn(() => Promise.resolve([])),
  removeHub: vi.fn(() => Promise.resolve()),
  renameHub: vi.fn(() => Promise.resolve()),
  openUrl: vi.fn(),
}));

const acme: HubAccount = { id: "hub-example-com", label: "Acme", url: "https://hub.example.com", local: false, revision: "wfp_old" };
const thisComputer: HubAccount = { id: "local", label: "This computer", url: "http://127.0.0.1:4100", local: true, revision: "local-token" };
const PAGE = "https://hub.example.com/pair/K7Q2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The hubs answer by route (and, for `/api/me`, by token). */
const hubsAnswer = (routes: Record<string, () => Response>) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    const answer = routes[`${url.pathname} ${token}`] ?? routes[url.pathname];
    return answer ? answer() : new Response(null, { status: 404 });
  });

/** What Desk sent when it asked for codes. */
const codeRequests = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([input]) => String(input).endsWith("/api/pair/device/request"))
    .map(([, init]) => JSON.parse(init!.body as string) as Record<string, string>);

/** The hubs Desk's native side kept, with their tokens, as pairings were
 *  collected: what `hubs_save` once took from the page. */
const kept: { label: string; url: string; token: string }[] = [];

/** Desk's native side for pairing (src-tauri/src/hub_io.rs), over the
 *  hubs `hubsAnswer` stands in for: it asks them, and keeps an approved
 *  pairing's token itself, telling the page only that it did. */
const nativePairing = () =>
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    if (cmd === "pair_request") {
      const res = await fetch(`${String(a.url)}/api/pair/device/request`, {
        method: "POST",
        body: JSON.stringify({
          device_name: a.deviceName,
          device_kind: "desktop_device",
          ...(a.identityHint ? { identity_hint: a.identityHint } : {}),
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }
    if (cmd === "pair_collect") {
      const res = await fetch(`${String(a.url)}/api/pair/device/status/${String(a.code)}`);
      if (res.status === 404) return { status: "expired" };
      const body = (await res.json()) as { status: string; token?: string; identity?: { display_name?: string; email?: string } };
      if (body.status !== "approved") return { status: body.status };
      if (!body.token) return { status: "used" };
      kept.push({ label: String(a.label), url: String(a.url), token: body.token });
      const id = new URL(String(a.url)).hostname.replace(/\./g, "-");
      setDevToken(id, body.token);
      return { status: "approved", hub: id, identity: { name: body.identity?.display_name ?? null, email: body.identity?.email ?? null } };
    }
    return undefined;
  }) as typeof invoke);

const approved = { status: "approved", token: "wfp_new", identity: { display_name: "Kings", email: "k@example.com" } };

beforeEach(() => {
  deskState.remove("pairing.email");
  deskState.remove("pairing.pending");
  useChat.setState({ hubs: [thisComputer, acme], roster: [], rosterErrors: {}, rosterTrouble: {} });
  setDevToken(acme.id, "wfp_old");
  setDevToken(thisComputer.id, "local-token");
  kept.length = 0;
  nativePairing();
  vi.mocked(openUrl).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Workspaces", () => {
  it("says who Desk is connected as", async () => {
    hubsAnswer({ "/api/me wfp_old": () => json({ display_name: "Kings", email: "k@example.com" }) });
    render(<Hubs />);
    expect(await screen.findByText("Connected as Kings · k@example.com")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns when a working token is nobody's, and offers to connect as you", async () => {
    hubsAnswer({ "/api/me wfp_old": () => new Response(null, { status: 401 }) });
    render(<Hubs />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Connected without your account, so agents shared only with you are hidden.",
    );
    expect(screen.getByRole("button", { name: "Sign in as you" })).toBeTruthy();
  });

  it("offers Sign in again, not just Disconnect, when the workspace no longer takes Desk's sign-in", async () => {
    hubsAnswer({ "/api/me wfp_old": () => new Response(null, { status: 401 }) });
    useChat.setState({ rosterErrors: { [acme.id]: "Acme: not paired any more" }, rosterTrouble: { [acme.id]: "signedOut" } });
    render(<Hubs />);
    expect((await screen.findByRole("alert")).textContent).toBe("Desk’s sign-in to Acme has expired or was revoked. Sign in again to see its agents.");
    expect(screen.getByText("Signed out")).toBeTruthy();
    expect(screen.queryByText("Acme: not paired any more")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(screen.getByText("Connect to Acme as you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("says plainly when a workspace can't be reached, with Try again, its own words under Details", async () => {
    hubsAnswer({ "/api/me wfp_old": () => json({ display_name: "Kings", email: "k@example.com" }) });
    useChat.setState({ rosterErrors: { [acme.id]: "Load failed" }, rosterTrouble: { [acme.id]: "unreachable" } });
    const refresh = vi.spyOn(useChat.getState(), "refreshRoster").mockResolvedValue();
    useChat.setState({ refreshRoster: refresh });
    render(<Hubs />);
    expect(await screen.findByText("Can’t reach hub.example.com: check your internet or VPN.")).toBeTruthy();
    expect(screen.queryByText("Load failed", { selector: ".hub-row > span" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("offers the name the workspace gives itself in place of one typed by hand", async () => {
    hubsAnswer({ "/api/me wfp_old": () => json({ display_name: "Kings", email: "k@example.com", workspace: "Driftwerk" }) });
    useChat.setState({ hubs: [thisComputer, { ...acme, label: "Driftwork" }] });
    render(<Hubs />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename to Driftwerk" }));
    await waitFor(() => expect(renameHub).toHaveBeenCalledWith(acme.id, "Driftwerk"));
    expect(hubAccounts).toHaveBeenCalled();
  });

  it("offers no name when the workspace says its own is the one Desk keeps, or says none", async () => {
    hubsAnswer({ "/api/me wfp_old": () => json({ display_name: "Kings", email: "k@example.com", workspace: "Acme" }) });
    render(<Hubs />);
    await screen.findByText("Connected as Kings · k@example.com");
    expect(screen.queryByRole("button", { name: /^Rename to/ })).toBeNull();
  });

  it("connects as you by signing in to the same workspace, replacing its token in place", async () => {
    hubsAnswer({
      "/api/me wfp_old": () => new Response(null, { status: 401 }),
      "/api/pair/device/request": () => json({ code: "K7Q2", approve_url: PAGE, expires_at: "2026-10-29T10:00:00Z" }),
      "/api/pair/device/status/K7Q2": () => json(approved),
    });
    render(<Hubs />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in as you" }));
    expect(screen.getByText("Connect to Acme as you")).toBeTruthy();
    // An approved code would connect as nobody again: not offered here.
    expect(screen.queryByRole("button", { name: "An admin gave me a code" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(PAGE));
    // Same label and address: the hub keeps its id, and what names its agents.
    await waitFor(() => expect(kept).toEqual([{ label: "Acme", url: "https://hub.example.com", token: "wfp_new" }]));
    expect(await screen.findByText(/Connected to Acme as Kings\./)).toBeTruthy();
    expect(hubAccounts).toHaveBeenCalled();
    expect(codeRequests()).toEqual([{ device_name: "Desk", device_kind: "desktop_device" }]);
  });
});

describe("Connect a workspace", () => {
  it("opens the workspace's approval page and waits, asking no email and no name: the workspace names itself", async () => {
    hubsAnswer({
      "/api/pair/device/request": () => json({ code: "K7Q2", approve_url: PAGE, expires_at: "2026-10-29T10:00:00Z", name: "Acme" }),
      "/api/pair/device/status/K7Q2": () => json({ status: "pending" }),
    });
    render(<PairHub onClose={() => {}} />);
    expect(screen.queryByLabelText(/Your email there/)).toBeNull();
    expect(screen.queryByLabelText("Call it")).toBeNull();
    fireEvent.change(screen.getByLabelText("Workspace address"), { target: { value: "hub.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Sign in to Acme in your browser and approve Desk. Check the code matches.")).toBeTruthy();
    expect(screen.getByText("K7Q2")).toBeTruthy();
    expect(openUrl).toHaveBeenCalledWith(PAGE);
    fireEvent.click(screen.getByRole("button", { name: "Open the page again" }));
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(codeRequests()).toEqual([{ device_name: "Desk", device_kind: "desktop_device" }]);
  });

  it("asks an older workspace for a code by your email, approved in its Pairing page", async () => {
    let asked = 0;
    hubsAnswer({
      "/api/pair/device/request": () => json({ code: ++asked === 1 ? "OLD1" : "OLD2" }),
      "/api/pair/device/status/OLD2": () => json({ status: "pending" }),
    });
    deskState.set("pairing.email", "k@example.com");
    render(<PairHub onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Workspace address"), { target: { value: "hub.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const email = (await screen.findByLabelText(/Your email there/)) as HTMLInputElement;
    expect(screen.getByText(/So the workspace knows it’s you, and shows you the agents shared with you/)).toBeTruthy();
    // The email last used is offered.
    await waitFor(() => expect(email.value).toBe("k@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Get a code" }));
    expect(await screen.findByText("OLD2")).toBeTruthy();
    expect(screen.getByText(/Pairing page/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the page again" })).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
    expect(codeRequests()[1]).toEqual({ device_name: "Desk", device_kind: "desktop_device", identity_hint: "k@example.com" });
  });

  it("needs an email in that fallback", async () => {
    hubsAnswer({ "/api/pair/device/request": () => json({ code: "OLD1" }) });
    useChat.setState({ hubs: [] });
    render(<PairHub onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Workspace address"), { target: { value: "hub.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByLabelText(/Your email there/);
    expect((screen.getByRole("button", { name: "Get a code" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("finishes a sign-in left waiting when Desk reloaded", async () => {
    // A code of its own: another test's may still be collecting.
    hubsAnswer({ "/api/pair/device/status/R3SM": () => json(approved) });
    keepPending(deskState, { url: "https://hub.example.com", label: "Acme", code: "R3SM", approveUrl: "https://hub.example.com/pair/R3SM" });
    render(<PairHub onClose={() => {}} />);
    expect(screen.getByText("R3SM")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open the page again" })).toBeTruthy();
    // Not opened again by itself after the reload.
    expect(openUrl).not.toHaveBeenCalled();
    await waitFor(() => expect(kept).toEqual([{ label: "Acme", url: "https://hub.example.com", token: "wfp_new" }]));
    expect(await screen.findByText(/Connected to Acme as Kings\./)).toBeTruthy();
    expect(deskState.get("pairing.pending")).toBeUndefined();
  });

  it("says an approved code connects without your account, and offers signing in as you once it has", async () => {
    hubsAnswer({ "/api/pair/device/status/ADM1": () => json({ status: "approved", token: "wfp_anon", identity: null }) });
    const asYou = vi.fn();
    render(<PairHub onClose={() => {}} onAsYou={asYou} />);
    fireEvent.click(screen.getByRole("button", { name: "An admin gave me a code" }));
    expect(
      screen.getByText("A code approved for you by an admin connects without your account, so agents shared only with you stay hidden until you sign in."),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Workspace address"), { target: { value: "workforce.driftwerk.xyz" } });
    fireEvent.change(screen.getByLabelText("The code you approved"), { target: { value: "adm1" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
    // Named by its address: the code says nothing of the workspace.
    expect(await screen.findByText(/Connected to Driftwerk, without your account/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in as you" }));
    expect(asYou).toHaveBeenCalledWith({ url: "https://workforce.driftwerk.xyz", label: "Driftwerk" });
  });

  it("says plainly when the address isn't one, never the browser's words", () => {
    hubsAnswer({});
    render(<PairHub onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Workspace address"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByText("That isn’t a workspace address. Type one like workforce.example.com.")).toBeTruthy();
    expect(screen.queryByText(/Invalid URL|expected pattern/)).toBeNull();
  });

  it("says plainly when the workspace can't be reached, with Try again", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "pair_request") throw new Error("Can’t reach workforce.driftwerk.xyz: check the address, your internet or VPN.");
      return undefined;
    }) as typeof invoke);
    render(<PairHub onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Workspace address"), { target: { value: "workforce.driftwerk.xyz" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Can’t reach workforce.driftwerk.xyz: check the address, your internet or VPN.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("asks for a new code by itself when one expires or was already used, keeping the address", async () => {
    let asked = 0;
    hubsAnswer({
      "/api/pair/device/request": () => json({ code: `EXP${++asked}`, approve_url: `https://hub.example.com/pair/EXP${asked}`, name: "Acme" }),
      // The first expires, the second was used, the third goes through.
      "/api/pair/device/status/EXP1": () => new Response(null, { status: 404 }),
      "/api/pair/device/status/EXP2": () => json({ status: "approved" }),
      "/api/pair/device/status/EXP3": () => json(approved),
    });
    render(<PairHub onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Workspace address"), { target: { value: "hub.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Connected to Acme as Kings\./, undefined, { timeout: 8000 })).toBeTruthy();
    expect(asked).toBe(3);
    expect(kept).toEqual([{ label: "Acme", url: "https://hub.example.com", token: "wfp_new" }]);
    // Each new code's page opened, for the person to approve it.
    expect(vi.mocked(openUrl).mock.calls.map((c) => c[0])).toEqual([
      "https://hub.example.com/pair/EXP1",
      "https://hub.example.com/pair/EXP2",
      "https://hub.example.com/pair/EXP3",
    ]);
  }, 15000);

  it("unpairs this computer from a workspace before it forgets it", async () => {
    const asked: string[] = [];
    hubsAnswer({
      "/api/me": () => json({ display_name: "Kings", email: "k@example.com" }),
      "/api/pair/device/revoke-self": () => (asked.push("revoke-self"), json({ revoked: true })),
    });
    const { removeHub } = await import("../platform");
    vi.mocked(removeHub).mockImplementation(async () => void asked.push("removed"));
    render(<Hubs />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(asked).toEqual(["revoke-self", "removed"]));
  });
});
