import { RichHostProvider, RichMarkdown, type RichHost } from "@workforce/rich";
import { useMemo } from "react";
import { Attachments, type FileHome } from "../attachments/Attachments";
import { RoutedApproval } from "../chat/Approvals";
import { openUrl } from "../platform";
import type { Relayed } from "../chat/relayed";
import type { ChatMessage, DeliveryKind } from "../chat/types";
import { DeskActions } from "../overview/DeskActions";
import { AgentMark, Mark, YouMark } from "../ui/Mark";

/** What a delivered message is badged as, for the kinds that are shown. */
export const DELIVERY_BADGES: Partial<Record<DeliveryKind, string>> = {
  reminder: "Reminder",
  job: "Scheduled job",
  workflow: "Workflow",
  check_in: "Check-in",
  approval: "Approval",
};

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export function Message({
  message,
  author,
  authorKey,
  youOn = null,
  home,
  relayed,
  origin,
  onSubmitForm,
}: {
  message: ChatMessage;
  author: string;
  /** The author's agent key, when an agent wrote it. */
  authorKey?: string;
  /** The hub whose places this is in (null or none: Desk's own), whose
   *  picture of you shows on what you said. */
  youOn?: string | null;
  home?: string;
  /** The hub and agent of the conversation it is in: where its files are,
   *  unless a file names its own, and where an approval it asks for is
   *  decided. */
  origin?: FileHome;
  /** A turn the overseer sent on, shown as from it (or from you, saying yes
   *  to it), not as something you typed. */
  relayed?: Relayed | null;
  onSubmitForm: (summary: string, values: Record<string, unknown>) => boolean;
}) {
  const host = useMemo<RichHost>(
    () => ({
      openUrl,
      submitForm: async (summary, values) => onSubmitForm(summary, values),
    }),
    [onSubmitForm],
  );
  const fromOverseer = relayed?.by === "overseer";
  const you = message.role === "user" && !fromOverseer;
  const name = fromOverseer ? relayed.overseer : you ? "You" : message.role === "system" ? "Desk" : author;
  const badge = message.delivery && DELIVERY_BADGES[message.delivery];
  return (
    <article className={`msg msg-${fromOverseer ? "assistant" : message.role}${relayed ? " msg-relayed" : ""}`} data-message-id={message.id}>
      {you ? <YouMark hub={youOn} /> : fromOverseer || !authorKey ? <Mark name={fromOverseer ? relayed.overseer : author} /> : <AgentMark agent={authorKey} name={author} />}
      <div className="msg-body">
        <span className="msg-head">
          <b className="display">{name}</b>{" "}
          {relayed && (
            <>
              <span className="msg-via small">
                {relayed.task ? "task " : ""}via {relayed.overseer}
              </span>{" "}
            </>
          )}
          {badge && <span className="chip msg-delivery">{badge}</span>}{" "}
          <span className="faint small">
            {home ? `${home} · ` : ""}
            {time(message.at)}
          </span>
        </span>
        {message.tools.length > 0 && (
          <span className="msg-tools">
            {message.tools.map((t, i) => (
              <span key={i} className={`chip ${t.done ? "" : "chip-live"}`}>
                {t.name}
              </span>
            ))}
          </span>
        )}
        {!message.content.trim() ? null : message.role !== "assistant" ? (
          <p className={message.status === "error" ? "msg-text state-blocked" : "msg-text"}>{relayed?.text ?? message.content}</p>
        ) : (
          <RichHostProvider host={host}>
            <div className="msg-text rich">
              <RichMarkdown text={message.content} streaming={message.status === "streaming"} />
            </div>
          </RichHostProvider>
        )}
        {message.attachments && <Attachments files={message.attachments} home={origin} />}
        {message.role === "assistant" && message.desk && <DeskActions extras={message.desk} />}
        {message.delivery === "approval" && message.requestId && origin && (
          <RoutedApproval hubId={origin.hub} requestId={message.requestId} />
        )}
      </div>
    </article>
  );
}
