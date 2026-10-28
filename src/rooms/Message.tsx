import { RichHostProvider, RichMarkdown, type RichHost } from "@workforce/rich";
import { useMemo } from "react";
import { openUrl } from "../platform";
import type { ChatMessage } from "../chat/types";
import { Mark } from "../ui/Mark";

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export function Message({
  message,
  author,
  home,
  onSubmitForm,
}: {
  message: ChatMessage;
  author: string;
  home?: string;
  onSubmitForm: (summary: string, values: Record<string, unknown>) => boolean;
}) {
  const host = useMemo<RichHost>(
    () => ({
      openUrl,
      submitForm: async (summary, values) => onSubmitForm(summary, values),
    }),
    [onSubmitForm],
  );
  const you = message.role === "user";
  return (
    <article className={`msg msg-${message.role}`}>
      {you ? <span className="msg-avatar">K</span> : <Mark name={author} />}
      <div className="msg-body">
        <span className="msg-head">
          <b className="display">{you ? "You" : message.role === "system" ? "Desk" : author}</b>{" "}
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
        {you || message.role === "system" ? (
          <p className={message.status === "error" ? "msg-text state-blocked" : "msg-text"}>{message.content}</p>
        ) : (
          <RichHostProvider host={host}>
            <div className="msg-text rich">
              <RichMarkdown text={message.content} streaming={message.status === "streaming"} />
            </div>
          </RichHostProvider>
        )}
      </div>
    </article>
  );
}
