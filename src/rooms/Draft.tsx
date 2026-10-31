import { RichMarkdown } from "@workforce/rich";
import { Attachments } from "../attachments/Attachments";
import { PromptCard } from "../chat/Approvals";
import { useNeeds } from "../floor/store";
import type { RoomDraft } from "../hub/store";
import { AgentMark } from "../ui/Mark";
import { answerPrompt, cancelAsk, dismiss, retry, stop } from "./engine";
import { Progress } from "./ProgressCard";
import { memberOf } from "./routing";

/** What a draft says when it isn't going: why, and what can be done. */
const NOTE: Partial<Record<RoomDraft["state"], string>> = {
  queued: "Will answer once it’s done in another thread",
  connecting: "Connecting…",
  busy: "Will answer once it’s done with something else",
  stalled: "Reconnecting…",
  interrupted: "Interrupted",
  stopped: "Stopped by you",
};

/** "Stopped by you · it had taken in 2 more messages" */
const stoppedNote = (took: number): string =>
  took ? `${NOTE.stopped} · it had taken in ${took} more message${took === 1 ? "" : "s"}` : NOTE.stopped!;

/** A member's answer on its way: what it has said so far, what it is
 *  doing, what it asks you first; once it can't go on, why, to ask again. */
export function Draft({ roomId, draft, name }: { roomId: string; draft: RoomDraft; name: string }) {
  const home = memberOf(draft.member) ?? undefined;
  const stopped = draft.state === "interrupted" || draft.state === "failed" || draft.state === "stopped";
  const note = draft.state === "failed" ? draft.error : draft.state === "stopped" ? stoppedNote(draft.took ?? 0) : NOTE[draft.state];
  const cancellable = draft.state === "queued" || draft.state === "busy";
  // A need the Floor placed on its thread for its member waits on you too.
  const asked = useNeeds().some(
    (n) => n.place.kind === "room" && n.place.room === roomId && n.place.thread === draft.threadId && `${n.hubId}/${n.who.id}` === draft.member,
  );
  return (
    <article className="msg msg-assistant msg-draft" aria-busy={!stopped} aria-label={`${name}’s answer on its way`}>
      <AgentMark agent={draft.member} name={name} state={stopped ? undefined : "working"} />
      <div className="msg-body">
        <span className="msg-head">
          <b className="display">{name}</b>
        </span>
        <Progress draft={draft} asked={asked} onStop={() => stop(roomId, draft.id)} />
        {draft.text && (
          <div className="msg-text rich">
            <RichMarkdown text={draft.text} streaming={!stopped} />
          </div>
        )}
        <Attachments files={draft.attachments} home={home} />
        {draft.prompts.map((p) => (
          <PromptCard key={p.requestId} prompt={p} onAnswer={(choice) => answerPrompt(roomId, draft.id, p.requestId, choice)} />
        ))}
        <span className="small faint draft-note" role="status">
          {!stopped && note}
          {cancellable && (
            <button type="button" className="link small" onClick={() => cancelAsk(roomId, draft.id)}>
              Cancel
            </button>
          )}
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
