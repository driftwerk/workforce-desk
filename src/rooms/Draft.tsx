import { RichMarkdown } from "@workforce/rich";
import { Attachments } from "../attachments/Attachments";
import { PromptCard } from "../chat/Approvals";
import { StatusLine, ToolChips } from "../chat/WorkingRow";
import type { RoomDraft } from "../hub/store";
import { AgentMark } from "../ui/Mark";
import { answerPrompt, dismiss, retry } from "./engine";

/** What a draft says when it isn't going: why, and what can be done. */
const NOTE: Partial<Record<RoomDraft["state"], string>> = {
  queued: "Will answer once it’s done in another thread",
  connecting: "Connecting…",
  busy: "Will answer once it’s done with something else",
  stalled: "Reconnecting…",
  interrupted: "Interrupted",
};

/** A member's answer on its way: what it has said so far, what it is
 *  doing, what it asks you first; once it can't go on, why, to ask again. */
export function Draft({ roomId, draft, name }: { roomId: string; draft: RoomDraft; name: string }) {
  const [hub, agent] = draft.member.split("/");
  const stopped = draft.state === "interrupted" || draft.state === "failed";
  const note = draft.state === "failed" ? draft.error : NOTE[draft.state];
  return (
    <article className="msg msg-assistant msg-draft" aria-busy={!stopped} aria-label={`${name}’s answer on its way`}>
      <AgentMark agent={draft.member} name={name} state={stopped ? undefined : "working"} />
      <div className="msg-body">
        <span className="msg-head">
          <b className="display">{name}</b>
        </span>
        <ToolChips tools={draft.tools} />
        {draft.text && (
          <div className="msg-text rich">
            <RichMarkdown text={draft.text} streaming={!stopped} />
          </div>
        )}
        <Attachments files={draft.attachments} home={hub && agent ? { hub, agent } : undefined} />
        {draft.prompts.map((p) => (
          <PromptCard key={p.requestId} prompt={p} onAnswer={(choice) => answerPrompt(roomId, draft.id, p.requestId, choice)} />
        ))}
        {draft.working && draft.state === "live" && <StatusLine working={draft.working} />}
        <span className="small faint draft-note" role="status">
          {!stopped && note}
        </span>
        {stopped && (
          <span className="small state-blocked draft-note" role="alert">
            {note}{" "}
            <button type="button" className="link small" onClick={() => retry(roomId, draft.id)}>
              Retry
            </button>{" "}
            <button type="button" className="link small" onClick={() => dismiss(roomId, draft.id)}>
              Dismiss
            </button>
          </span>
        )}
      </div>
    </article>
  );
}
