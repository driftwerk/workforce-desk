import { useEffect } from "react";
import "../styles/settings.css";
import { Appearance } from "./Appearance";
import { Calls } from "./Calls";
import { Chat } from "./Chat";
import { Engines } from "./Engines";
import { Help } from "./Help";
import { Hubs } from "./Hubs";
import { Profile } from "./Profile";
import { Providers } from "./Providers";
import { Shortcuts } from "./Shortcuts";
import { Voices } from "./Voices";
import { dragWindow } from "../ui/drag";
import { SETTINGS_SECTIONS as SECTIONS, useUi, type SettingsSection as Section } from "../shell/ui";

export function Settings({ onClose }: { onClose: () => void }) {
  const section = useUi((u) => u.settings) ?? "appearance";
  const setSection = useUi((u) => u.openSettings);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inSheet = e.target instanceof Element && e.target.closest(".sheet-backdrop");
      if (e.key === "Escape" && !e.defaultPrevented && !inSheet) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings">
        <span className="settings-title" onMouseDown={dragWindow}>
          Settings
        </span>
        {(Object.keys(SECTIONS) as Section[]).map((k) => (
          <button
            key={k}
            type="button"
            className={`side-row ${section === k ? "on" : ""}`}
            aria-current={section === k ? "page" : undefined}
            onClick={() => setSection(k)}
          >
            {SECTIONS[k]}
          </button>
        ))}
        <button type="button" className="link small settings-done" onClick={onClose}>
          Back to desk <kbd>esc</kbd>
        </button>
      </nav>
      {section === "profile" && <Profile />}
      {section === "appearance" && <Appearance />}
      {section === "chat" && <Chat />}
      {section === "hubs" && <Hubs />}
      {section === "providers" && <Providers />}
      {section === "engines" && <Engines />}
      {section === "voices" && <Voices />}
      {section === "calls" && <Calls />}
      {section === "shortcuts" && <Shortcuts />}
      {section === "help" && <Help />}
    </div>
  );
}
