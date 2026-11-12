import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import type { Provider } from "../hub/providers";
import { useDesk } from "../hub/store";
import { ConnectForm } from "./ConnectForm";
import { useProviders } from "./store";

const region = { name: "region", label: "Region", secret: false, required: false, placeholder: "us-east-1" };
const keys = [
  { name: "access_key_id", label: "Access key ID", secret: true, required: true },
  { name: "secret_access_key", label: "Secret access key", secret: true, required: true },
  region,
];

/** Bedrock as the hub lists it: keys first, or an AWS profile. */
const bedrock: Provider = {
  id: "bedrock",
  name: "Amazon Bedrock",
  group: "key",
  description: "Claude and open models on your AWS account",
  connected: false,
  connect: {
    kind: "fields",
    fields: keys,
    hint: "An IAM user's access key",
    ways: [
      { id: "keys", label: "Keys", fields: keys, hint: "An IAM user's access key" },
      {
        id: "profile",
        label: "AWS profile",
        fields: [{ name: "profile", label: "Profile", secret: false, required: true, placeholder: "default", initial: "default" }, region],
        hint: "A profile in ~/.aws/config on this computer",
      },
    ],
  },
  models: [],
  efforts: [],
};

let sent: Record<string, string>[] = [];

afterEach(cleanup);

beforeEach(() => {
  sent = [];
  const connect = vi.fn(async (_hub: DeskHub, _id: string, fields: Record<string, string>) => {
    sent.push(fields);
    return { ...bedrock, connected: true };
  });
  act(() => {
    useDesk.setState({ hub: {} as DeskHub });
    useProviders.setState({ connect } as never);
  });
});

it("connects Bedrock with keys as before", async () => {
  render(<ConnectForm provider={bedrock} submitLabel="Connect" />);
  expect(screen.getByRole("radio", { name: "Keys" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.change(screen.getByLabelText("Access key ID"), { target: { value: " AKIA " } });
  fireEvent.change(screen.getByLabelText("Secret access key"), { target: { value: "s3cr3t" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(sent).toEqual([{ access_key_id: "AKIA", secret_access_key: "s3cr3t" }]));
});

it("connects Bedrock on an AWS profile, starting at default, and sends only the profile's fields", async () => {
  render(<ConnectForm provider={bedrock} submitLabel="Connect" />);
  // Keys typed first are not sent with the profile.
  fireEvent.change(screen.getByLabelText("Access key ID"), { target: { value: "AKIA" } });
  fireEvent.click(screen.getByRole("radio", { name: "AWS profile" }));
  expect(screen.queryByLabelText("Access key ID")).toBeNull();
  expect(screen.getByText("A profile in ~/.aws/config on this computer")).toBeTruthy();
  const profile = screen.getByLabelText("Profile") as HTMLInputElement;
  expect(profile.value).toBe("default");
  expect(profile.type).toBe("text");
  fireEvent.change(profile, { target: { value: "work-sso" } });
  fireEvent.change(screen.getByLabelText("Region"), { target: { value: "eu-west-2" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(sent).toEqual([{ profile: "work-sso", region: "eu-west-2" }]));
});

it("can't connect a profile left empty", () => {
  render(<ConnectForm provider={bedrock} submitLabel="Connect" />);
  fireEvent.click(screen.getByRole("radio", { name: "AWS profile" }));
  fireEvent.change(screen.getByLabelText("Profile"), { target: { value: " " } });
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
});

it("shows no choice for a provider with one way", () => {
  render(<ConnectForm provider={{ ...bedrock, connect: { kind: "fields", fields: keys } }} submitLabel="Connect" />);
  expect(screen.queryByRole("radiogroup")).toBeNull();
  expect(screen.getByLabelText("Access key ID")).toBeTruthy();
});

it("checks the keys before Connected, and gives the provider's reason in place when they're refused", async () => {
  let refuse: (e: Error) => void = () => {};
  const connect = vi.fn(() => new Promise<Provider>((_, reject) => (refuse = reject)));
  act(() => useProviders.setState({ connect } as never));
  const connected = vi.fn();
  render(<ConnectForm provider={bedrock} submitLabel="Connect" onConnected={connected} />);
  fireEvent.change(screen.getByLabelText("Access key ID"), { target: { value: "AKIA" } });
  fireEvent.change(screen.getByLabelText("Secret access key"), { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("button", { name: "Checking…" })).toBeTruthy();
  await act(async () =>
    refuse(new Error("AWS didn't accept those keys. Check the access key ID and the secret access key were both copied whole.")),
  );
  expect(screen.getByRole("alert").querySelector(".problem-plain")!.textContent).toMatch(/^AWS didn't accept those keys/);
  expect(connected).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
});
