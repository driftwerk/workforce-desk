// What an agent's settings show in Desk's main window alone: making an
// agent on a paired hub a group's boss (which opens the group's Boss sheet
// and its boss commands). Handed down by the main window's shell through
// `MainWindowParts` (crew/AgentSettings.tsx), as board/chrome.tsx's parts
// are, never set as a side effect: a grid's own window has none.

import type { AgentSettingsParts } from "./AgentSettings";
import { BossOfAGroup } from "./BossOfAGroup";

export const MAIN_WINDOW_PARTS: AgentSettingsParts = { BossOfAGroup };
