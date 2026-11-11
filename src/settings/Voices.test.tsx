import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubError, type DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { VOICE_ENGINES } from "../voice/engines";
import { Voices } from "./Voices";

vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  invoke: vi.fn(() => Promise.resolve([])),
}));

let paths: string[] = [];
let gemini = false;
const saveVoiceKey = vi.fn();
const saveVault = vi.fn();

beforeEach(() => {
  paths = [];
  gemini = false;
  saveVoiceKey.mockReset().mockImplementation(async (provider: string) => void paths.push(`speech/${provider}/api_key`));
  saveVault.mockReset();
  const hub = {
    vaultPaths: async () => [...paths],
    providers: async () => [{ id: "gemini", connected: gemini }],
    saveVoiceKey,
    saveVault,
  } as unknown as DeskHub;
  useDesk.setState({ hub });
});
afterEach(cleanup);

const open = async (name: string) => {
  render(<Voices />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  await act(async () => {});
};

const paste = async (provider: string, key: string) => {
  fireEvent.change(screen.getByLabelText(`${provider} API key`), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await act(async () => {});
};

it("says Connected only once the provider took the key, through the route that tries it", async () => {
  await open("ElevenLabs");
  await paste("ElevenLabs", "  el-right ");
  expect(saveVoiceKey).toHaveBeenCalledWith("elevenlabs", "el-right");
  expect(saveVault).not.toHaveBeenCalled();
  expect(screen.getByText("· connected")).toBeTruthy();
  expect((screen.getByLabelText("ElevenLabs API key") as HTMLInputElement).value).toBe("");
});

it("gives the provider's reason in place when it refused the key, and keeps what was typed", async () => {
  saveVoiceKey.mockRejectedValue(
    new HubError(400, "ElevenLabs didn't accept that key. Check it was copied whole, or make a new one: create a key at elevenlabs.io."),
  );
  await open("ElevenLabs");
  await paste("ElevenLabs", "el-wrong");
  expect(screen.getByRole("alert").textContent).toMatch(/^ElevenLabs didn't accept that key/);
  expect(screen.queryByText("· connected")).toBeNull();
  expect((screen.getByLabelText("ElevenLabs API key") as HTMLInputElement).value).toBe("el-wrong");
  expect(useDesk.getState().error).toBeNull();
});

it("shows Checking… while the provider is asked", async () => {
  let answer: () => void = () => {};
  saveVoiceKey.mockImplementation(() => new Promise<void>((resolve) => (answer = resolve)));
  await open("OpenAI");
  fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-x" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await act(async () => {});
  expect((screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => answer());
});

it("uses the Gemini key from Providers for Gemini Live instead of asking again", async () => {
  gemini = true;
  await open("Gemini Live");
  expect(screen.getByText("· connected with your Gemini key from Providers")).toBeTruthy();
  expect((screen.getByLabelText("Gemini Live API key") as HTMLInputElement).placeholder).toBe("Or paste another key");
});

it("points the live engines at sections that exist", () => {
  for (const e of VOICE_ENGINES) expect(e.privacy).not.toMatch(/under Plans/);
});
