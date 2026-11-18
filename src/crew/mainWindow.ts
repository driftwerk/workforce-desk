// What an agent's settings show in Desk's main window alone: making an
// agent on a paired hub a group's boss (which opens the group's Boss sheet
// and its boss commands). Imported by the main window's shell only, as
// board/chrome.tsx is, so a grid's own window never reaches those commands.

import { MAIN_WINDOW } from "./AgentSettings";
import { BossOfAGroup } from "./BossOfAGroup";

MAIN_WINDOW.BossOfAGroup = BossOfAGroup;
