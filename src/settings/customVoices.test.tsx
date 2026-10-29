import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withVoice } from "../crew/voice";
import { VoiceDialog } from "../crew/VoiceDialog";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { invoke, loadSettings, saveSettings, type Settings } from "../platform";
import { AddVoiceById } from "./AddVoiceById";
import { addCustomVoice, removeCustomVoice, repairVoice, useSettings } from "./store";
import { providerById, withCustom, type VoiceLookup } from "./voiceCatalog";

vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  invoke: vi.fn(() => Promise.resolve()),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(() => Promise.resolve()),
}));

/** A cloned ElevenLabs voice: not one of Desk's recommendations. */
const CLONE = "Xb7hH8MSUJpSbSDYk0k2";
const elevenlabs = providerById("elevenlabs")!;
const fish = providerById("fish_audio")!;

/** `voice_lookup` answers `said`; every other command succeeds. */
const providerSays = (said: VoiceLookup) =>
  vi.mocked(invoke).mockImplementation((cmd: string) => Promise.resolve(cmd === "voice_lookup" ? said : undefined) as never);

const lookUp = (id: string) => {
  fireEvent.change(screen.getByLabelText("Voice ID"), { target: { value: id } });
  fireEvent.click(screen.getByRole("button", { name: "Look it up" }));
};

beforeEach(async () => {
  vi.mocked(invoke).mockReset();
  vi.mocked(saveSettings).mockClear();
  vi.mocked(loadSettings).mockResolvedValue({
    theme: "system",
    tuple: false,
    newAgent: null,
    defaultVoice: { provider: "fish_audio", voice: "802e3bc2b27e49c2995d23ef70e6ac89" },
    agentVoices: {},
    customVoices: {},
    voice: false,
    voiceEngine: "cascade",
    shortcuts: {},
  } as Partial<Settings> as Settings);
  useSettings.setState({ loaded: false });
  await useSettings.getState().load();
});

afterEach(cleanup);

describe("Use a voice ID", () => {
  it("names a voice the provider has, plays it, and adds it under that name", async () => {
    providerSays({ state: "found", name: "My clone", description: "female, british" });
    const onAdd = vi.fn();
    render(<AddVoiceById provider={elevenlabs} model="eleven_multilingual_v2" onAdd={onAdd} onCancel={() => {}} />);
    lookUp(` ${CLONE} `);
    expect(await screen.findByText("My clone")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("voice_lookup", { provider: "elevenlabs", voice: CLONE });

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("voice_try", {
        voice: { provider: "elevenlabs", model: "eleven_multilingual_v2", voice: CLONE },
        text: "Hi, I’m My clone. This is how I sound.",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add voice" }));
    expect(onAdd).toHaveBeenCalledWith({ id: CLONE, name: "My clone", description: "female, british" });
  });

  it("keeps the name given in place of the provider's", async () => {
    providerSays({ state: "found", name: "Narrator" });
    const onAdd = vi.fn();
    render(<AddVoiceById provider={fish} model="s1" onAdd={onAdd} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Ledger's voice" } });
    lookUp("0123456789abcdef0123456789abcdef");
    fireEvent.click(await screen.findByRole("button", { name: "Add voice" }));
    expect(onAdd).toHaveBeenCalledWith({ id: "0123456789abcdef0123456789abcdef", name: "Ledger's voice" });
  });

  it("says plainly when the id isn't found, and adds nothing", async () => {
    providerSays({ state: "not-found" });
    render(<AddVoiceById provider={fish} model="s1" onAdd={vi.fn()} onCancel={() => {}} />);
    lookUp("nope");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Fish Audio has no voice with that id/);
    expect(screen.queryByRole("button", { name: /^Add/ })).toBeNull();
  });

  it("says a key is needed when Desk keeps none", async () => {
    providerSays({ state: "no-key" });
    render(<AddVoiceById provider={elevenlabs} model={undefined} onAdd={vi.fn()} onCancel={() => {}} />);
    lookUp(CLONE);
    expect((await screen.findByRole("alert")).textContent).toBe("Add your ElevenLabs key first: Desk uses it to find the voice.");
    expect(screen.queryByRole("button", { name: /^Add/ })).toBeNull();
  });

  it("says when the key can't read the voice, and adds it unchecked only with a name", async () => {
    providerSays({ state: "key-refused", message: "The API key is missing the permission voices_read." });
    const onAdd = vi.fn();
    render(<AddVoiceById provider={elevenlabs} model={undefined} onAdd={onAdd} onCancel={() => {}} />);
    lookUp(CLONE);
    expect((await screen.findByRole("alert")).textContent).toMatch(/key can’t read that voice: The API key is missing/);
    const unchecked = screen.getByRole("button", { name: "Add without checking" });
    expect((unchecked as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Studio clone" } });
    fireEvent.click(unchecked);
    expect(onAdd).toHaveBeenCalledWith({ id: CLONE, name: "Studio clone" });
  });
});

describe("voices added by id", () => {
  it("are saved with Desk's settings, per provider, and can be removed", () => {
    addCustomVoice("elevenlabs", { id: CLONE, name: "My clone" });
    addCustomVoice("fish_audio", { id: "abc", name: "Narrator" });
    expect(saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customVoices: { elevenlabs: [{ id: CLONE, name: "My clone" }], fish_audio: [{ id: "abc", name: "Narrator" }] },
      }),
    );
    // Adding it again renames it rather than listing it twice.
    addCustomVoice("elevenlabs", { id: CLONE, name: "Clone" });
    expect(useSettings.getState().customVoices.elevenlabs).toEqual([{ id: CLONE, name: "Clone" }]);
    removeCustomVoice("elevenlabs", CLONE);
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ customVoices: { fish_audio: [{ id: "abc", name: "Narrator" }] } }));
  });

  it("follow the provider's own voices in its list", () => {
    const listed = withCustom(elevenlabs.voices as never, [{ id: CLONE, name: "My clone" }, { id: "EXAVITQu4vr4xnSDxMaL", name: "dupe" }]);
    expect(listed.at(-1)).toMatchObject({ id: CLONE, name: "My clone", custom: true });
    expect(listed.filter((v) => v.id === "EXAVITQu4vr4xnSDxMaL")).toHaveLength(1);
  });

  it("are picked for an agent, whose hub-side voice is the id itself", async () => {
    useDesk.setState({ hub: { vaultPaths: () => Promise.resolve(["speech/elevenlabs/api_key"]) } as unknown as DeskHub });
    addCustomVoice("elevenlabs", { id: CLONE, name: "My clone" });
    const onUse = vi.fn();
    render(
      <VoiceDialog
        title="How Ledger sounds"
        who="Ledger"
        current={null}
        defaultVoice={useSettings.getState().defaultVoice}
        onUse={onUse}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ElevenLabs/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /My clone/ }));
    expect(screen.getByText("Ledger will sound like My clone · ElevenLabs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this" }));
    await waitFor(() => expect(onUse).toHaveBeenCalledWith({ provider: "elevenlabs", model: "eleven_multilingual_v2", voice: CLONE }));

    const config = withVoice('[llm]\nprovider = "claude-code"\n', onUse.mock.calls[0]![0]);
    expect(config).toContain(`voice = "${CLONE}"`);
    expect(config).toContain('provider = "elevenlabs"');
  });

  it("are added from the picker and chosen at once", async () => {
    useDesk.setState({ hub: { vaultPaths: () => Promise.resolve(["speech/fish_audio/api_key"]) } as unknown as DeskHub });
    providerSays({ state: "found", name: "Narrator" });
    render(
      <VoiceDialog
        title="How Ledger sounds"
        who="Ledger"
        current={null}
        defaultVoice={useSettings.getState().defaultVoice}
        onUse={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use a voice ID" }));
    lookUp("0123456789abcdef0123456789abcdef");
    fireEvent.click(await screen.findByRole("button", { name: "Add voice" }));
    expect(useSettings.getState().customVoices.fish_audio).toEqual([{ id: "0123456789abcdef0123456789abcdef", name: "Narrator" }]);
    expect(screen.getByRole("radio", { name: /Narrator/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("are left alone when saved voices are repaired", () => {
    expect(repairVoice({ provider: "elevenlabs", voice: CLONE })).toEqual({ provider: "elevenlabs", voice: CLONE });
    expect(repairVoice({ provider: "fish_audio", model: "s1", voice: "0123456789abcdef0123456789abcdef" })).toEqual({
      provider: "fish_audio",
      model: "s1",
      voice: "0123456789abcdef0123456789abcdef",
    });
  });
});
