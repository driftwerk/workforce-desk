import { useEffect, useId, useRef, useState } from "react";
import { create } from "zustand";
import type { AudioPrefs, DeviceChoice } from "../platform";
import { perPlatform, useHost } from "../shell/host";
import { Menu, type MenuEntry } from "../ui/Menu";
import { SwitchRow } from "../ui/SwitchRow";
import { audioDevices, audioLevel, audioMeter, audioNow, audioTest, type AudioDevice, type AudioDevices, type AudioNow } from "../voice/api";
import { ShortcutField } from "./ShortcutField";
import { setAudio, useSettings } from "./store";

/** How often the meter reads the level; what's in use (and why not what
 *  was chosen); and the device list (for one plugged in meanwhile). */
const METER_MS = 100;
const STATUS_MS = 1000;
const DEVICES_MS = 3000;

/** The level as the meter's fill, 0 to 1: −60 dB (silence) to 0 dB. */
export const meterFill = (rms: number): number => (rms > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 60)) : 0);

/** A choice of microphone or speaker as a menu's entries: the system's
 *  (named), every device there is, and a remembered one that's away. */
export const deviceEntries = (devices: AudioDevice[], chosen: DeviceChoice | null, choose: (c: DeviceChoice | null) => void): MenuEntry[] => {
  const system = devices.find((d) => d.isDefault);
  const present = chosen ? devices.find((d) => d.id === chosen.id) ?? devices.find((d) => d.name === chosen.name) : undefined;
  const entries: MenuEntry[] = [
    { kind: "item", label: "Same as system", hint: system?.name, radio: true, checked: !chosen, onSelect: () => choose(null) },
    { kind: "separator" },
    ...devices.map(
      (d): MenuEntry => ({
        kind: "item",
        label: d.name,
        radio: true,
        checked: present?.id === d.id,
        onSelect: () => choose({ id: d.id, name: d.name }),
      }),
    ),
  ];
  if (chosen && !present) entries.push({ kind: "item", label: chosen.name, hint: "not connected", radio: true, checked: true, disabled: true });
  return entries;
};

/** What a choice shows as on its button. */
const chosenLabel = (devices: AudioDevice[], chosen: DeviceChoice | null): string =>
  chosen ? chosen.name : `Same as system${devices.find((d) => d.isDefault) ? ` (${devices.find((d) => d.isDefault)!.name})` : ""}`;

/** The microphone and speaker list, shared by every view of it: read at
 *  most every couple of seconds however many ask. */
const useDeviceList = create<{ devices: AudioDevices; at: number }>(() => ({ devices: { inputs: [], outputs: [] }, at: 0 }));

export const refreshDevices = (): void => {
  if (Date.now() - useDeviceList.getState().at < DEVICES_MS - 500) return;
  useDeviceList.setState({ at: Date.now() });
  audioDevices()
    .then((d) => d && Array.isArray(d.inputs) && useDeviceList.setState({ devices: d }))
    .catch(() => undefined);
};

/** The microphones and speakers as last read. */
export const currentDevices = (): AudioDevices => useDeviceList.getState().devices;

/** The microphones and speakers: `"watch"` reads them now and every few
 *  seconds (for one plugged in meanwhile), `"once"` reads them now. */
export const useAudioDevices = (how: "watch" | "once" | "off" = "watch"): AudioDevices => {
  useEffect(() => {
    if (how === "off") return;
    refreshDevices();
    if (how === "once") return;
    const t = setInterval(refreshDevices, DEVICES_MS);
    return () => clearInterval(t);
  }, [how]);
  return useDeviceList((s) => s.devices);
};

function Picker({
  label,
  devices,
  chosen,
  onChoose,
}: {
  label: string;
  devices: AudioDevice[];
  chosen: DeviceChoice | null;
  onChoose: (c: DeviceChoice | null) => void;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn audio-picker"
        aria-haspopup="menu"
        aria-label={`${label}: ${chosenLabel(devices, chosen)}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: r.left, y: r.bottom + 4 });
        }}
      >
        <span className="audio-picker-name">{chosenLabel(devices, chosen)}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
          <path d="M1 3.5 5 7.5 9 3.5Z" />
        </svg>
      </button>
      {at && (
        <Menu
          label={label}
          at={at}
          entries={deviceEntries(devices, chosen, onChoose)}
          onClose={(refocus) => {
            setAt(null);
            if (refocus) button.current?.focus();
          }}
        />
      )}
    </>
  );
}

/** How loud the microphone is, as a bar: read ten times a second while
 *  shown and the window is in view, without re-rendering anything else. */
export function LevelMeter() {
  const bar = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let live = true;
    const t = setInterval(() => {
      if (document.hidden) return;
      audioLevel()
        .then((level) => {
          if (!live || typeof level !== "number") return;
          const f = meterFill(level);
          if (fill.current) fill.current.style.width = `${f * 100}%`;
          bar.current?.setAttribute("aria-valuenow", String(Math.round(f * 100)));
        })
        .catch(() => undefined);
    }, METER_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return (
    <span ref={bar} className="audio-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}>
      <span ref={fill} className="audio-meter-fill" style={{ width: "0%" }} />
    </span>
  );
}

type Testing = { state: "idle" } | { state: "testing" } | { state: "done" } | { state: "failed"; why: string };

/** Settings › Voice's microphone and speaker: which of each, with a live
 *  level, echo cancelling, how readily speech is heard, push to talk only,
 *  and a test that records a moment and plays it back. */
export function AudioSettings() {
  const audio = useSettings((s) => s.audio);
  // The meter opens a microphone: only once voice is on, so looking at
  // Settings never asks for the microphone or lights its indicator.
  const voiceOn = useSettings((s) => s.voice);
  const platform = useHost((s) => s.platform);
  const devices = useAudioDevices();
  const [now, setNow] = useState<AudioNow | null>(null);
  const [testing, setTesting] = useState<Testing>({ state: "idle" });
  const [sense, setSense] = useState(audio.sensitivity);
  const senseId = useId();
  useEffect(() => setSense(audio.sensitivity), [audio.sensitivity]);

  // The meter's microphone while this is shown (voice's own when it has
  // one), and what's in use.
  useEffect(() => {
    let live = true;
    let ticks = 0;
    const read = () => {
      if (document.hidden) return;
      // Opened again now and then: voice closing its microphone closes it.
      if (voiceOn && ticks++ % 3 === 0) void audioMeter(true).catch(() => undefined);
      audioNow()
        .then((n) => live && n && typeof n.level === "number" && setNow(n))
        .catch(() => undefined);
    };
    read();
    const t = setInterval(read, STATUS_MS);
    return () => {
      live = false;
      clearInterval(t);
      if (voiceOn) void audioMeter(false).catch(() => undefined);
    };
  }, [voiceOn]);

  const set = (patch: Partial<AudioPrefs>) => setAudio(patch);
  const commitSense = () => {
    if (sense !== audio.sensitivity) set({ sensitivity: sense });
  };

  const test = async () => {
    setTesting({ state: "testing" });
    try {
      await audioTest();
      setTesting({ state: "done" });
    } catch (e) {
      setTesting({ state: "failed", why: String(e) });
    }
  };

  const echoSub = perPlatform(platform, {
    macos: "Removes Desk’s own voice from what the microphone hears, so it never answers itself. With headphones, turn it off: you can talk over Desk, and quiet speech isn’t filtered.",
    windows: "Quiets the microphone while Desk speaks, so it never hears itself. With headphones, turn it off so you can talk over Desk.",
    linux: "Quiets the microphone while Desk speaks, so it never hears itself. With headphones, turn it off so you can talk over Desk.",
  });

  return (
    <section className="prov-section audio-settings" aria-label="Microphone and speaker">
      <h2 className="field-label">Microphone and speaker</h2>
      <div className="prov-list">
        <div className="setting-card">
          <span className="card-text">
            <b>Microphone</b>
            <span>{now?.input ? `Hearing ${now.input.name}` : "The one Desk listens to"}</span>
            {voiceOn ? <LevelMeter /> : <span className="small faint">Turn on Talk to agents to see the level.</span>}
          </span>
          <Picker label="Microphone" devices={devices.inputs} chosen={audio.input} onChoose={(input) => set({ input })} />
        </div>
        <div className="setting-card">
          <span className="card-text">
            <b>Speaker</b>
            <span>{now?.output ? `Playing on ${now.output.name}` : "Where Desk’s voice plays"}</span>
          </span>
          <Picker label="Speaker" devices={devices.outputs} chosen={audio.output} onChoose={(output) => set({ output })} />
        </div>
        <div className="setting-card">
          <span className="card-text">
            <b>Test</b>
            <span aria-live="polite">
              {testing.state === "idle" && "Records three seconds from the microphone and plays them back on the speaker."}
              {testing.state === "testing" && "Say something — it plays back in three seconds…"}
              {testing.state === "done" && "Done. Heard nothing? Choose another microphone, or turn sensitivity up."}
              {testing.state === "failed" && <span className="state-blocked">{testing.why}</span>}
            </span>
          </span>
          <button type="button" className="btn" disabled={testing.state === "testing"} onClick={() => void test()}>
            {testing.state === "testing" ? "Testing…" : "Test"}
          </button>
        </div>
      </div>
      {now?.notes.map((note) => (
        <p key={note} className="small state-working" role="status">
          {note}
        </p>
      ))}
      <SwitchRow label="Echo cancelling" sub={echoSub} on={audio.echoCancel} onChange={(echoCancel) => set({ echoCancel })} />
      <div className="audio-sense">
        <label htmlFor={senseId}>
          <b>Input sensitivity</b>
          <span className="small muted">Turn it up if Desk misses what you say from across the room; down if it hears noise as speech.</span>
        </label>
        <div className="audio-sense-row">
          <span className="small faint">Close speech only</span>
          <input
            id={senseId}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sense}
            onChange={(e) => setSense(Number(e.target.value))}
            onPointerUp={commitSense}
            onKeyUp={commitSense}
            onBlur={commitSense}
          />
          <span className="small faint">Quiet and distant voices</span>
        </div>
      </div>
      <SwitchRow
        label="Push to talk only"
        sub="Desk hears you only while you hold the keys — for a noisy room, or a call going on nearby."
        on={audio.pushToTalkOnly}
        onChange={(pushToTalkOnly) => set({ pushToTalkOnly })}
      />
      {audio.pushToTalkOnly && <ShortcutField id="pushToTalk" />}
    </section>
  );
}
