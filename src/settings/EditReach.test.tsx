// "Change how Desk reaches devbox", against a fake native side: another SSH
// config entry or a typed address, the same machine by its host key or
// refused, a name of its own, and every failure said in place.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeNative, machine } from "../machines/testing";
import { DEFAULT_HOST, useHost } from "../shell/host";
import { EditReach } from "./EditReach";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({ machinesList: vi.fn(async () => []), onMachinesChanged: vi.fn(async () => () => {}), machinePluginDir: vi.fn(async () => null), inApp: false, openUrl: vi.fn() }));

beforeEach(() => useHost.setState(DEFAULT_HOST));
afterEach(cleanup);

const devbox = machine({
  id: "devbox",
  target: "devbox",
  reach: { user: "dev", hostname: "2.29.244.189", port: "22", via: null, entry: "devbox", file: "~/.ssh/config" },
});

const HOSTS = [
  { host: "devbox-new", hostname: "2.29.244.190", user: "dev", port: null, jump: null, file: "~/.ssh/config" },
  { host: "devbox", hostname: "2.29.244.189", user: "dev", port: null, jump: null, file: "~/.ssh/config" },
  { host: "buildbox", hostname: "10.0.3.14", user: "ubuntu", port: null, jump: "bastion", file: "~/.ssh/config" },
  { host: "hel", hostname: "hel-1.example.net", user: "james", port: "2222", jump: null, file: "~/.ssh/conf.d/hel" },
];

const open = async (over: Parameters<typeof fakeNative>[0] = {}) => {
  const n = fakeNative(over);
  n.fake.sshHosts.mockResolvedValue(HOSTS);
  const onClose = vi.fn();
  const onAddNew = vi.fn();
  render(<EditReach machine={devbox} native={n.native} onClose={onClose} onAddNew={onAddNew} />);
  await act(async () => {});
  return { ...n, onClose, onAddNew };
};

it("lists the SSH config's entries, the one in use marked, and switches to another once its key is checked", async () => {
  const { fake, onClose } = await open();
  const list = screen.getByRole("radiogroup", { name: "SSH config entries" });
  expect(within(list).getAllByRole("radio").map((r) => r.textContent)).toEqual([
    "devbox-newdev@2.29.244.190",
    "devboxdev@2.29.244.189in use now",
    "buildboxubuntu@10.0.3.14via bastion",
    "heljames@hel-1.example.net:2222",
  ]);
  expect(within(list).getAllByRole("radio")[1]!.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(list).getByRole("radio", { name: /devbox-new/ }));
  const grid = screen.getByRole("group", { name: "From your SSH config" });
  expect(grid.textContent).toContain("HostName2.29.244.190UserdevPort22Jump hostnone");
  expect(screen.getByText(/Switching asks you once, in a macOS dialog/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check and switch to devbox-new" })));
  expect(fake.edit).toHaveBeenCalledWith("devbox", { target: "devbox-new" });
  expect(onClose).toHaveBeenCalled();
});

it("refuses an address that shows another key, with both keys, and offers it as a new machine", async () => {
  const { fake, onAddNew, onClose } = await open();
  fake.edit.mockResolvedValueOnce({
    kind: "differentKey",
    shown: { kind: "ED25519", fingerprint: "SHA256:Zp4wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa1Qe" },
    known: { kind: "ED25519", fingerprint: "SHA256:k3VqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9fXc" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "An address" }));
  fireEvent.change(screen.getByLabelText("Address"), { target: { value: "2.29.244.201" } });
  fireEvent.change(screen.getByLabelText("User"), { target: { value: "dev" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check and switch" })));
  expect(fake.edit).toHaveBeenCalledWith("devbox", { target: "dev@2.29.244.201" });
  const refused = screen.getByRole("alert", { name: "Not the same machine" });
  expect(refused.textContent).toContain("dev@2.29.244.201 shows a different host key from devbox’s.");
  expect(refused.textContent).toContain("This addressED25519 SHA256:Zp4w…a1Qe");
  expect(refused.textContent).toContain("devboxED25519 SHA256:k3Vq…9fXc");
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(within(refused).getByRole("button", { name: "Add dev@2.29.244.201 as a new machine…" }));
  expect(onAddNew).toHaveBeenCalledWith("dev@2.29.244.201");
  fireEvent.click(within(refused).getByRole("button", { name: "Back" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("changes nothing when the person says no, and says a failure in place", async () => {
  const { fake, onClose } = await open();
  fake.edit.mockResolvedValueOnce({ kind: "cancelled" });
  fireEvent.click(screen.getByRole("radio", { name: /devbox-new/ }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check and switch to devbox-new" })));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  fake.edit.mockRejectedValueOnce(new Error("Your known_hosts has another key for devbox-new. Desk won't change it."));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check and switch to devbox-new" })));
  expect(screen.getByRole("alert").textContent).toContain("Your known_hosts has another key for devbox-new");
});

it("asks for a Host entry for a port other than 22, and renames alone without checking anything", async () => {
  const { fake, onClose } = await open();
  fireEvent.click(screen.getByRole("radio", { name: "An address" }));
  fireEvent.change(screen.getByLabelText("Address"), { target: { value: "2.29.244.189" } });
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "2222" } });
  expect(screen.getByText(/A port other than 22 needs a Host entry in your SSH config/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Check and switch" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(screen.getByRole("radio", { name: "From your SSH config" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "devbox (dev)" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
  expect(fake.edit).toHaveBeenCalledWith("devbox", { name: "devbox (dev)" });
  expect(onClose).toHaveBeenCalled();
});

it("says when the SSH config has nothing to pick, and reads it again", async () => {
  const n = fakeNative();
  n.fake.sshHosts.mockResolvedValueOnce([]).mockResolvedValueOnce(HOSTS);
  render(<EditReach machine={machine({ id: "box", target: "dev@203.0.113.7", reach: { user: "dev", hostname: "203.0.113.7", port: "22", via: null, entry: null, file: null } })} native={n.native} onClose={() => {}} />);
  await act(async () => {});
  // A typed address is how it's reached now: that tab first.
  expect(screen.getByRole("radio", { name: "An address" }).getAttribute("aria-checked")).toBe("true");
  expect((screen.getByLabelText("User") as HTMLInputElement).value).toBe("dev");
  expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("203.0.113.7");
  fireEvent.click(screen.getByRole("radio", { name: "From your SSH config" }));
  expect(screen.getByText(/has no Host entries Desk can list/)).toBeTruthy();
});
