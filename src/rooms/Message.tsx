import { RichHostProvider, RichMarkdown, type RichHost } from "@workforce/rich";
import { memo, useMemo, type ReactNode } from "react";
import { Attachments, type FileHome } from "../attachments/Attachments";
import { RoutedApproval } from "../chat/Approvals";
import { saveMadeFile } from "../attachments/save";
import { linkParts, openLink } from "../shell/links";
import { DESK_RICH_HOST } from "../shell/richHost";
import type { Relayed } from "../chat/relayed";
import type { ChatMessage, DeliveryKind } from "../chat/types";
import { DeskActions } from "../overview/DeskActions";
import { AgentMark, Mark, YouMark } from "../ui/Mark";
import type { Step } from "../hub/types";
import { stepsOf } from "./progress";
import { Steps } from "./ProgressCard";

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

/** Plain text with its links clickable: the web's, and Desk's own. */
function Linked({ text }: { text: string }) {
  return (
    <>
      {linkParts(text).map((p, i) =>
        p.kind === "text" ? (
          p.text
        ) : (
          <a
            key={i}
            href={p.url}
            onClick={(e) => {
              e.preventDefault();
              openLink(p.url);
            }}
          >
            {p.text}
          </a>
        ),
      )}
    </>
  );
}

const fullTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString([], { dateStyle: "full", timeStyle: "short" });
};

/** A message, rendered again only when what it's given changes: so those
 *  who show it keep what they give it the same. */
export const Message = memo(function Message({
  message,
  author,
  authorKey,
  youOn = null,
  home,
  relayed,
  origin,
  steps,
  answered,
  chips,
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
  /** The tools an agent's turn ran for it, shown folded away. */
  steps?: readonly Step[];
  /** A form in it was answered already: it stays locked. */
  answered?: boolean;
  /** Notes beside its time: where an answer went, where a copy came from. */
  chips?: ReactNode;
  /** Resolves true once the answer is on its way; false unlocks the form. */
  onSubmitForm: (summary: string, values: Record<string, unknown>) => boolean | Promise<boolean>;
}) {
  const host = useMemo<RichHost>(
    () => ({
      ...DESK_RICH_HOST,
      answered,
      saveFile: saveMadeFile,
      submitForm: async (summary, values) => onSubmitForm(summary, values),
    }),
    [onSubmitForm, answered],
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
          <span className="faint small" title={fullTime(message.at)}>
            {home ? `${home} · ` : ""}
            {time(message.at)}
          </span>
          {chips}
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
          <p className={message.status === "error" ? "msg-text state-blocked" : "msg-text"}>
            <Linked text={relayed?.text ?? message.content} />
          </p>
        ) : (
          <RichHostProvider host={host}>
            <div className="msg-text rich">
              <RichMarkdown text={message.content} streaming={message.status === "streaming"} />
            </div>
          </RichHostProvider>
        )}
        {steps && steps.length > 0 && (
          <details className="msg-steps">
            <summary className="small">
              What {name} did · {steps.length} step{steps.length === 1 ? "" : "s"}
            </summary>
            <Steps steps={stepsOf(steps)} />
          </details>
        )}
        {message.attachments && <Attachments files={message.attachments} home={origin} />}
        {message.role === "assistant" && message.desk && <DeskActions extras={message.desk} />}
        {message.delivery === "approval" && message.requestId && origin && (
          <RoutedApproval hubId={origin.hub} requestId={message.requestId} />
        )}
      </div>
    </article>
  );
});
