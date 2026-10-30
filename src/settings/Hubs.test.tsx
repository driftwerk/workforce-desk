import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { HubAccount } from "../chat/types";
import { PairHub } from "../hubs/PairHub";
import { keepPending } from "../hubs/pairing";
import { hubAccounts, openUrl, saveHub } from "../platform";
import { deskState } from "../restore/boot";
import { Hubs } from "./Hubs";

vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  invoke: vi.fn(() => Promise.resolve()),
  statePut: vi.fn(() => Promise.resolve()),
  stateRemove: vi.fn(() => Promise.resolve()),
  saveHub: vi.fn(() => Promise.resolve({ id: "hub-example-com" })),
  hubAccounts: vi.fn(() => Promise.resolve([])),
  removeHub: vi.fn(() => Promise.resolve()),
  openUrl: vi.fn(),
}));

const acme: HubAccount = { id: "hub-example-com", label: "Acme", url: "https://hub.example.com", local: false, token: "wfp_old" };
const thisMac: HubAccount = { id: "local", label: "This Mac", url: "http://127.0.0.1:4100", local: true, token: "local-token" };
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

const approved = { status: "approved", token: "wfp_new", identity: { display_name: "Kings", email: "k@example.com" } };

beforeEach(() => {
  deskState.remove("pairing.email");
  deskState.remove("pairing.pending");
  useChat.setState({ hubs: [thisMac, acme], roster: [], rosterErrors: {} });
  vi.mocked(saveHub).mockClear();
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
    expect(screen.getByRole("button", { name: "Connect as you" })).toBeTruthy();
  });

  it("doesn't warn about a token the workspace no longer takes at all", async () => {
    hubsAnswer({ "/api/me wfp_old": () => new Response(null, { status: 401 }) });
    useChat.setState({ rosterErrors: { [acme.id]: "Acme: not paired any more" } });
    render(<Hubs />);
    await waitFor(() => expect(screen.getByText("Acme: not paired any more")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect as you" })).toBeNull();
  });

  it("connects as you by signing in to the same workspace, replacing its token in place", async () => {
    hubsAnswer({
      "/api/me wfp_old": () => new Response(null, { status: 401 }),
      "/api/pair/device/request": () => json({ code: "K7Q2", approve_url: PAGE, expires_at: "2026-10-29T10:00:00Z" }),
      "/api/pair/device/status/K7Q2": () => json(approved),
    });
    render(<Hubs />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect as you" }));
    expect(screen.getByText("Connect to Acme as you")).toBeTruthy();
    // An approved code would connect as nobody again: not offered here.
    expect(screen.queryByRole("button", { name: "I already have an approved code" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(PAGE));
    // Same label and address: the hub keeps its id, and what names its agents.
    await waitFor(() => expect(saveHub).toHaveBeenCalledWith("Acme", "https://hub.example.com", "wfp_new"));
    expect(await screen.findByText(/Connected as Kings\./)).toBeTruthy();
    expect(hubAccounts).toHaveBeenCalled();
    expect(codeRequests()).toEqual([{ device_name: "Desk", device_kind: "desktop_device" }]);
  });
});

describe("Connect a workspace", () => {
  it("opens the workspace's approval page and waits, asking no email", async () => {
    hubsAnswer({
      "/api/pair/device/request": () => json({ code: "K7Q2", approve_url: PAGE, expires_at: "2026-10-29T10:00:00Z" }),
      "/api/pair/device/status/K7Q2": () => json({ status: "pending" }),
    });
    render(<PairHub onClose={() => {}} />);
    expect(screen.queryByLabelText(/Your email there/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Workspace address"), { target: { value: "hub.example.com" } });
    fireEvent.change(screen.getByLabelText("Call it"), { target: { value: "Acme" } });
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
    await waitFor(() => expect(saveHub).toHaveBeenCalledWith("Acme", "https://hub.example.com", "wfp_new"));
    expect(await screen.findByText(/Connected as Kings\./)).toBeTruthy();
    expect(deskState.get("pairing.pending")).toBeUndefined();
  });

  it("says an approved code connects without your account", () => {
    hubsAnswer({});
    render(<PairHub onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "I already have an approved code" }));
    expect(
      screen.getByText(
        "This connects without linking your account. Afterwards, use Connect as you in Workspaces to sign in and see agents shared only with you.",
      ),
    ).toBeTruthy();
  });

  it("unpairs this Mac from a workspace before it forgets it", async () => {
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
