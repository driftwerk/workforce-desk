import { useEffect } from "react";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { openAgentBeside } from "../rooms/AgentPanel";
import { useSettings } from "../settings/store";
import { SetupGuide } from "./SetupGuide";
import { useSetupViews } from "./slot";
import { leftOf, openSetup, setupSeen, STEPS, useDeskAgent, useProgress, useSetupOpen, useSteps } from "./steps";
import { useDesk } from "../hub/store";

/** Opens Desk's agent's DM with the setup in it: on first run by itself,
 *  and whenever "Set up with an agent" is pressed. */
export const startSetup = (): void => {
  openSetup();
  const { hubs, roster } = useChat.getState();
  const local = hubs.find((h) => h.local)?.id;
  const agent = roster.find((a) => a.hubId === local && a.isDefault) ?? roster.find((a) => a.hubId === local);
  if (agent) openAgentBeside(agentKey(agent));
};

/** Whether this is a first run: no provider connected and no session
 *  Desk knows. Anyone who has either (someone updating Desk) is set up
 *  already; when the hub can't say, it isn't counted as a first run. */
export const firstRun = async (): Promise<boolean> => {
  const { hub, sessions } = useDesk.getState();
  if (!hub || Object.keys(sessions).length > 0) return false;
  try {
    return !(await hub.providers()).some((p) => p.connected);
  } catch {
    return false;
  }
};

/** On a settings file that has never offered it, once the crew has been
 *  read: a first run opens the setup in Desk's agent's DM; anyone already
 *  set up has it marked as offered, quietly, and finds it in Settings. */
export function SetupLauncher() {
  // The main window's: it puts the setup's views where the DM and the Floor show them.
  useEffect(() => {
    useSetupViews.setState({ inDm: SetupGuide, onFloor: SetupOnFloor });
    return () => useSetupViews.setState({ inDm: null, onFloor: null });
  }, []);
  const loaded = useSettings((s) => s.loaded);
  const started = useSettings((s) => !!s.setup?.started);
  const rosterRead = useChat((s) => s.rosterRead);
  useEffect(() => {
    if (!loaded || !rosterRead || started) return;
    let live = true;
    void firstRun().then((first) => {
      if (!live || useSettings.getState().setup?.started) return;
      if (first) startSetup();
      else setupSeen();
    });
    return () => {
      live = false;
    };
  }, [loaded, rosterRead, started]);
  return null;
}

/** The setup on the Floor while it's open: whole, where there's no agent
 *  to say it; else a line to go back to it in the agent's DM. */
export function SetupOnFloor() {
  const open = useSetupOpen();
  const agent = useDeskAgent();
  const progress = useProgress();
  const steps = useSteps();
  const panel = useChat((s) => s.panelAgent);
  if (!open) return null;
  if (!agent) return <SetupGuide />;
  if (panel === agentKey(agent)) return null;
  const left = leftOf(steps, progress.skipped).length;
  if (left === 0) return null;
  return (
    <section className="floor-card setup-resume" aria-label="Setup">
      <div className="floor-card-head">
        <h2 className="display floor-card-title">Finish setting up Desk</h2>
        <span className="faint small">
          {STEPS.length - left} of {STEPS.length} done
        </span>
      </div>
      <p className="small muted">{agent.name} is walking you through it in your DM.</p>
      <div>
        <button type="button" className="btn btn-sm btn-signal" onClick={() => openAgentBeside(agentKey(agent))}>
          Continue with {agent.name}
        </button>
      </div>
    </section>
  );
}
