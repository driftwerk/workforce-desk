import { useEffect } from "react";
import { useChat } from "../chat/store";
import { workspaces, type HubAccount } from "../chat/types";
import { deskCall, HubError } from "../hub/client";
import { answerJob, type ThemeJob } from "./proposals";

/** How long a hub holds Desk's ask open for an agent's theme call. */
const HOLD_S = 25;
/** How long after a failed ask Desk asks again, at most. */
const MOST_BACKOFF_MS = 60_000;
/** A hub from before `theme.*` is asked again this seldom. */
const OLD_HUB_MS = 10 * 60_000;

const JOBS = "/api/me/desk-theme-jobs";

/** Takes agents' `theme.*` calls from hub `hub` and answers each, until
 *  `stopped`. A proposal is saved here, by Desk, as a proposal only. */
export const takeThemeJobs = (hub: HubAccount, stopped: () => boolean): void => {
  let backoff = 1000;
  const loop = async () => {
    while (!stopped()) {
      try {
        const { jobs } = await deskCall<{ jobs?: ThemeJob[] }>(hub, "GET", `${JOBS}?wait=${HOLD_S}`);
        backoff = 1000;
        // Answered even when stopped meanwhile: the hub handed them here.
        for (const job of jobs ?? []) {
          const answer = await answerJob(hub.id, job);
          // The agent may have stopped waiting: nothing more to do.
          await deskCall(hub, "POST", `${JOBS}/${encodeURIComponent(job.id)}`, answer).catch(() => undefined);
        }
      } catch (e) {
        const wait = e instanceof HubError && e.status === 404 ? OLD_HUB_MS : backoff;
        backoff = Math.min(backoff * 2, MOST_BACKOFF_MS);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
  void loop();
};

/** Keeps every workspace Desk is signed in to (this computer's hub and the
 *  paired ones) handing it the theme calls of the person's agents there. */
export function useThemeJobs(): void {
  const key = useChat((s) =>
    workspaces(s.hubs)
      .map((h) => `${h.id}@${h.revision}`)
      .sort()
      .join(" "),
  );
  useEffect(() => {
    let stopped = false;
    for (const hub of workspaces(useChat.getState().hubs)) takeThemeJobs(hub, () => stopped);
    return () => {
      stopped = true;
    };
  }, [key]);
}
