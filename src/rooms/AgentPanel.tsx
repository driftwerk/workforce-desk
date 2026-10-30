import { useChat } from "../chat/store";
import { agentKey, describeAgent, type Agent } from "../chat/types";
import { PutInGrid } from "../grids/PutInGrid";
import { reveal } from "../grids/windows";
import { useDesk } from "../hub/store";
import { useUi } from "../shell/ui";
import { SidePanel } from "../panels/Stage";
import { Mark } from "../ui/Mark";
import { DirectMessage } from "./Rooms";

/** Shows your DM with agent `key` in Rooms. */
const openInRooms = (key: string): void => {
  void useDesk.getState().openRoom(null);
  useChat.getState().openDm(key);
};

/** Opens agent `key`'s Settings, in Rooms. */
export const openAgentSettings = (key: string): void => {
  const chat = useChat.getState();
  if (chat.panelAgent === key) chat.setPanelAgent(null);
  useUi.getState().setAgentTab(key, "settings");
  openInRooms(key);
};

/** Opens your DM with agent `key`: where it shows in a grid, if it does;
 *  else beside the Floor, on the Floor, and in Rooms anywhere else. */
export const openAgent = (key: string): void => {
  if (reveal({ kind: "agent", agent: key })) return;
  if (useDesk.getState().view === "floor") useChat.getState().setPanelAgent(key);
  else openInRooms(key);
};

/** The agent whose DM shows beside the Floor: only on the Floor, and once
 *  the roster has it. */
export function useAgentPanel(): Agent | undefined {
  const floor = useDesk((s) => s.view === "floor");
  return useChat((s) => (floor && s.panelAgent ? s.roster.find((a) => agentKey(a) === s.panelAgent) : undefined));
}

/** A DM beside the Floor: the conversation, which can go to a grid or open
 *  in full in Rooms. */
export function AgentPanel({ agent }: { agent: Agent }) {
  const key = agentKey(agent);
  const hub = useChat((s) => s.hubs.find((h) => h.id === agent.hubId));
  const close = () => useChat.getState().setPanelAgent(null);
  return (
    <SidePanel
      className="dm-panel"
      label={agent.name}
      noun="this conversation"
      onClose={close}
      title={
        <>
          <Mark name={agent.name} />
          <span className="session-title">
            <b className="display">{agent.name}</b>
            <span className="faint small">{describeAgent(agent, hub?.label ?? agent.hubId)}</span>
          </span>
        </>
      }
      actions={
        <>
          <button type="button" className="link" onClick={() => openAgentSettings(key)}>
            Settings
          </button>
          <button
            type="button"
            className="link"
            onClick={() => {
              close();
              openInRooms(key);
            }}
          >
            Open full
          </button>
          <PutInGrid content={{ kind: "agent", agent: key }} label={`Put ${agent.name} in a grid`} onShown={close} />
        </>
      }
    >
      <DirectMessage key={key} agent={key} />
    </SidePanel>
  );
}
