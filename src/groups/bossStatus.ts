// A group's boss on another hub, as the native side reads it (`boss_status`):
// names and states, never a token. Apart from `./remoteBoss` so a grid's
// window, which offers "Hand to Allan" on its panes' sessions, reaches this
// read and none of the Boss sheet's commands.

import { invoke } from "../platform";
import type { RemoteBoss } from "./remoteBoss";

export const bossStatus = {
  read: (group: string): Promise<RemoteBoss | null> => invoke<RemoteBoss | null>("boss_status", { group }),
};
