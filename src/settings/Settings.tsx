import { useEffect, useState } from "react";
import "../styles/settings.css";
import { Appearance } from "./Appearance";
import { Calls } from "./Calls";
import { Help } from "./Help";
import { Hubs } from "./Hubs";
import { Providers } from "./Providers";
import { Shortcuts } from "./Shortcuts";
import { Voices } from "./Voices";
import { dragWindow } from "../ui/drag";

const SECTIONS = { appearance: "Appearance", hubs: "Workspaces", providers: "Providers", voices: "Voices", calls: "Calls and voice", shortcuts: "Shortcuts", help: "Help" } as const;
type Section = keyof typeof SECTIONS;

export function Settings({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<Section>("appearance");
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
      {section === "appearance" && <Appearance />}
      {section === "hubs" && <Hubs />}
      {section === "providers" && <Providers />}
      {section === "voices" && <Voices />}
      {section === "calls" && <Calls />}
      {section === "shortcuts" && <Shortcuts />}
      {section === "help" && <Help />}
    </div>
  );
}
