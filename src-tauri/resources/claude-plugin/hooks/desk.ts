// Desk's hooks module: Claude Code loads one per plugin, so this one
// registers each of Desk's: the plan's usage (usage.ts) and the session's
// line (line.ts).

import { register as line, type On as LineOn } from "./line";
import { register as usage, type On as UsageOn } from "./usage";

export const register = (on: UsageOn & LineOn): void => {
  usage(on);
  line(on);
};
