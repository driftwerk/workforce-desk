import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubAccount } from "../chat/types";
import type { Connection, Connector } from "../hub/connections";
import { offerOf, sources, type CopyNative, type CopyRecord, type RemoteConnection } from "../hub/keyCopies";
import { CopyOffers } from "./CopyOffers";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const hub = (h: Partial<HubAccount> = {}): HubAccount => ({
  id: "patchwork",
  label: "Patchwork",
  url: "https://pw.example",
  local: false,
  revision: "r",
  ...h,
});

const remote = (r: Partial<RemoteConnection> & Pick<RemoteConnection, "connector" | "service">): RemoteConnection => ({
  key: "default",
  name: r.service,
  site: null,
  account: null,
  updatedAt: "2026-11-01T00:00:00Z",
  ...r,
});

const conn = (c: Partial<Connection> = {}): Connection => ({
  id: "all~~default",
  name: "Acme",
  site: null,
  level: "all",
  agent: null,
  agentName: null,
  account: null,
  status: "connected",
  detail: null,
  connectedAt: null,
  checkedAt: null,
  source: "global_per_user",
  usedBy: [],
  ...c,
});

const service = (id: string, name: string, connections: Connection[] = []): Connector => ({
  id,
  name,
  about: "",
  signIn: "fields",
  fields: [],
  signInReady: true,
  several: true,
  nameHint: "",
  connections,
  usedBy: [],
});

const JIRA = remote({
  connector: "jira",
  service: "Jira",
  site: "acme.atlassian.net",
  account: "ann@acme.example",
});
const GITHUB = remote({
  connector: "github",
  service: "GitHub",
  key: "acme",
  name: "Acme",
});
const DATADOG = remote({
  connector: "datadog",
  service: "Datadog",
  site: "us5",
});
const METABASE = remote({
  connector: "metabase",
  service: "Metabase",
  site: "https://metabase.acme.example",
});
const LOCAL = [service("jira", "Jira"), service("github", "GitHub"), service("datadog", "Datadog"), service("metabase", "Metabase")];

describe("what a paired hub offers", () => {
  it("comes only from another hub, never this computer's or a machine's", () => {
    expect(sources([hub(), hub({ id: "local", local: true }), hub({ id: "machine:devbox", machine: "devbox" })]).map((h) => h.id)).toEqual([
      "patchwork",
    ]);
  });

  it("is each connection not here yet, and none this hub doesn't connect", () => {
    const offer = offerOf("patchwork", [JIRA, GITHUB, remote({ connector: "notion", service: "Notion" })], [], LOCAL);
    expect(offer.map((i) => [i.connector, i.state])).toEqual([
      ["jira", "new"],
      ["github", "new"],
    ]);
  });

  it("leaves out one the person connected here by hand, by its site or account", () => {
    const local = [
      service("jira", "Jira", [conn({ site: "https://acme.atlassian.net/" })]),
      service("metabase", "Metabase", [conn({ site: "metabase.acme.example" })]),
      service("github", "GitHub", [conn({ account: "ann" })]),
      service("datadog", "Datadog", [conn({ site: "us1" })]),
    ];
    const offer = offerOf("patchwork", [JIRA, METABASE, GITHUB, DATADOG], [], local);
    expect(offer.map((i) => i.connector)).toEqual(["datadog"]);
  });

  it("offers a copy again only when the key there is newer, and over the connection it went into", () => {
    const record: CopyRecord = {
      hub: "patchwork",
      connector: "jira",
      remoteKey: "default",
      connection: "all~~acme",
      updatedAt: "2026-11-01T00:00:00Z",
      connectedAt: "2026-11-01T00:00:05Z",
    };
    const local = [
      service("jira", "Jira", [conn({ id: "all~~acme", name: "Acme", site: "acme.atlassian.net", connectedAt: "2026-11-01T00:00:05Z" })]),
    ];
    expect(offerOf("patchwork", [JIRA], [record], local)).toEqual([]);
    const changed = { ...JIRA, updatedAt: "2026-11-10T00:00:00Z" };
    expect(offerOf("patchwork", [changed], [record], local)).toEqual([{ ...changed, state: "newer", into: "all~~acme", localName: "Acme" }]);
    // Another hub's copy isn't this one's.
    expect(offerOf("driftwerk", [changed], [record], local)).toEqual([]);
    // The copy removed here: offered anew, unless one by hand stands in for it.
    expect(offerOf("patchwork", [changed], [record], [service("jira", "Jira")]).map((i) => i.state)).toEqual(["new"]);
    // Kept again here by hand since, under the same id: no longer the copy,
    // and never written over.
    const byHand = [service("jira", "Jira", [conn({ id: "all~~acme", site: "acme.atlassian.net", connectedAt: "2026-11-12T00:00:00Z" })])];
    expect(offerOf("patchwork", [changed], [record], byHand)).toEqual([]);
  });
});

const fakeNative = (over: Partial<CopyNative> = {}): CopyNative & { take: ReturnType<typeof vi.fn> } =>
  ({
    kept: vi.fn(async () => []),
    take: vi.fn(async () => ({ kind: "done" as const, results: [] })),
    ...over,
  }) as CopyNative & { take: ReturnType<typeof vi.fn> };

describe("Settings → Connections' offer", () => {
  it("says what the hub has, takes the ticked ones with one press, and says how each went", async () => {
    const copier = fakeNative({
      take: vi.fn(async () => ({
        kind: "done" as const,
        results: [
          {
            kind: "saved" as const,
            connector: "jira",
            key: "default",
            connection: "all~~default",
            name: "Acme",
            account: "ann@acme.example",
          },
          {
            kind: "failed" as const,
            connector: "datadog",
            key: "default",
            error: "Datadog said the application key is wrong",
          },
        ],
      })),
    });
    const reload = vi.fn(async () => {});
    await act(async () => {
      render(<CopyOffers local={LOCAL} reload={reload} hubs={[hub()]} copier={copier} list={async () => [JIRA, GITHUB, DATADOG, METABASE]} />);
    });
    expect(
      screen.getByRole("heading", {
        name: "Patchwork has 4 of your connections",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Jira, GitHub, Datadog and Metabase/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /GitHub/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Metabase/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Set up 2 here" }));
    });
    expect(copier.take).toHaveBeenCalledWith("patchwork", [
      { connector: "jira", key: "default" },
      { connector: "datadog", key: "default" },
    ]);
    expect(screen.getByText("Saved · signed in as ann@acme.example")).toBeTruthy();
    expect(screen.getByText("Datadog said the application key is wrong. Nothing was saved.")).toBeTruthy();
    expect(reload).toHaveBeenCalled();
  });

  it("offers a newer key as its own line, and never takes it unasked", async () => {
    const record: CopyRecord = {
      hub: "patchwork",
      connector: "jira",
      remoteKey: "default",
      connection: "all~~acme",
      updatedAt: "2026-10-01T00:00:00Z",
      connectedAt: "2026-10-01T00:00:05Z",
    };
    const copier = fakeNative({ kept: vi.fn(async () => [record]) });
    const local = [service("jira", "Jira", [conn({ id: "all~~acme", name: "Acme", connectedAt: "2026-10-01T00:00:05Z" })])];
    await act(async () => {
      render(<CopyOffers local={local} reload={async () => {}} hubs={[hub()]} copier={copier} list={async () => [JIRA]} />);
    });
    expect(screen.getByText("Patchwork has a newer Jira key")).toBeTruthy();
    expect(copier.take).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    });
    expect(copier.take).toHaveBeenCalledWith("patchwork", [{ connector: "jira", key: "default", into: "all~~acme" }]);
  });

  it("shows nothing when the hub offers nothing, and Not now puts an offer away", async () => {
    await act(async () => {
      render(<CopyOffers local={LOCAL} reload={async () => {}} hubs={[hub()]} copier={fakeNative()} list={async () => null} />);
    });
    expect(screen.queryByRole("region")).toBeNull();
    cleanup();
    await act(async () => {
      render(<CopyOffers local={LOCAL} reload={async () => {}} hubs={[hub()]} copier={fakeNative()} list={async () => [JIRA]} />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/Patchwork has/)).toBeNull();
    cleanup();
    await act(async () => {
      render(<CopyOffers local={LOCAL} reload={async () => {}} hubs={[hub()]} copier={fakeNative()} list={async () => [JIRA]} />);
    });
    expect(screen.queryByText(/Patchwork has/)).toBeNull();
  });

  it("says the hub's words when it refuses", async () => {
    const copier = fakeNative({
      take: vi.fn(async () => ({
        kind: "notAllowed" as const,
        status: 403,
        error: "This hub's admin has turned off copying your keys to Desk",
      })),
    });
    await act(async () => {
      render(<CopyOffers local={LOCAL} reload={async () => {}} hubs={[hub()]} copier={copier} list={async () => [JIRA]} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Set it up here" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("turned off copying");
  });
});
