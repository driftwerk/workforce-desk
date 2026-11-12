import { useEffect, useState } from "react";
import { Sessions } from "./Sessions";
import "../styles/settings.css";
import { Appearance } from "./Appearance";
import { Browser } from "./Browser";
import { Budgets } from "./Budgets";
import { Chat } from "./Chat";
import { Computer } from "./Computer";
import { Connections } from "./Connections";
import { Engines } from "./Engines";
import { Help } from "./Help";
import { Hubs } from "./Hubs";
import { Machines } from "./Machines";
import { Memory } from "./Memory";
import { Profile } from "./Profile";
import { Providers } from "./Providers";
import { Shortcuts } from "./Shortcuts";
import { Voices } from "./Voices";
import { dragWindow } from "../ui/drag";
import { SETTINGS_SECTIONS as SECTIONS, useUi, type SettingsSection as Section } from "../shell/ui";
import { startSetup } from "../setup/SetupLauncher";
import { searchSections } from "./search";

export function Settings({ onClose }: { onClose: () => void }) {
  const section = useUi((u) => u.settings) ?? "appearance";
  const setSection = useUi((u) => u.openSettings);
  const [query, setQuery] = useState("");
  const found = searchSections(query);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A sheet open on Settings (adding a machine) keeps Esc for itself,
      // wherever focus is: back from the browser, focus is on the page.
      const sheetOpen = document.querySelector(".sheet-backdrop");
      if (e.key === "Escape" && !e.defaultPrevented && !sheetOpen) onClose();
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
        <input
          type="search"
          className="settings-search"
          placeholder="Search settings"
          aria-label="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && found[0]) setSection(found[0]);
            if (e.key === "Escape" && query) {
              // Clears the search first; Esc again goes back to Desk.
              e.preventDefault();
              setQuery("");
            }
          }}
        />
        {found.length === 0 && <span className="faint small settings-none">Nothing matches “{query.trim()}”.</span>}
        {found.map((k: Section) => (
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
        <button
          type="button"
          className="btn btn-sm settings-setup"
          onClick={() => {
            onClose();
            startSetup();
          }}
        >
          Set up with an agent
        </button>
        <button type="button" className="link small settings-done" onClick={onClose}>
          Back to desk <kbd>esc</kbd>
        </button>
      </nav>
      {section === "profile" && <Profile />}
      {section === "appearance" && <Appearance />}
      {section === "chat" && <Chat />}
      {section === "hubs" && <Hubs />}
      {section === "computer" && <Computer />}
      {section === "browser" && <Browser />}
      {section === "machines" && <Machines />}
      {section === "providers" && <Providers />}
      {section === "connections" && <Connections />}
      {section === "engines" && <Engines />}
      {section === "sessions" && <Sessions />}
      {section === "memory" && <Memory />}
      {section === "budgets" && <Budgets />}
      {section === "voices" && <Voices />}
      {section === "shortcuts" && <Shortcuts />}
      {section === "help" && <Help />}
    </div>
  );
}
