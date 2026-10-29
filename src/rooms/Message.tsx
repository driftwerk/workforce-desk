import { RichHostProvider, RichMarkdown, type RichHost } from "@workforce/rich";
import { useMemo } from "react";
import { openUrl } from "../platform";
import type { Relayed } from "../chat/relayed";
import type { ChatMessage } from "../chat/types";
import { DeskActions } from "../overview/DeskActions";
import { Mark } from "../ui/Mark";

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export function Message({
  message,
  author,
  home,
  relayed,
  onSubmitForm,
}: {
  message: ChatMessage;
  author: string;
  home?: string;
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
  return (
    <article className={`msg msg-${fromOverseer ? "assistant" : message.role}${relayed ? " msg-relayed" : ""}`} data-message-id={message.id}>
      {you ? <span className="msg-avatar">K</span> : <Mark name={fromOverseer ? relayed.overseer : author} />}
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
        {message.role !== "assistant" ? (
          <p className={message.status === "error" ? "msg-text state-blocked" : "msg-text"}>{relayed?.text ?? message.content}</p>
        ) : (
          <RichHostProvider host={host}>
            <div className="msg-text rich">
              <RichMarkdown text={message.content} streaming={message.status === "streaming"} />
            </div>
          </RichHostProvider>
        )}
        {message.role === "assistant" && message.desk && <DeskActions extras={message.desk} />}
      </div>
    </article>
  );
}
