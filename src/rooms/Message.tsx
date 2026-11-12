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
import { isCardText } from "../crew/plan";
import { AgentMark, Mark, YouMark } from "../ui/Mark";
import type { Step } from "../hub/types";
import { stepsOf } from "./progress";
import { Steps } from "./ProgressCard";
import { ToolChips } from "../chat/WorkingRow";
import { ImageBudget } from "../shell/RemoteImage";
import { readableError } from "../chat/agentError";
import { PlanSignIn } from "../floor/PlanCards";
import { TicketKeys } from "../board/TicketChip";
import { commandMarkdown, shownText } from "../chat/commands";

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

/** Plain text with its links clickable (the web's, and Desk's own), and
 *  the keys of tickets on the board as their chips. */
function Linked({ text }: { text: string }) {
  return (
    <>
      {linkParts(text).map((p, i) =>
        p.kind === "text" ? (
          <TicketKeys key={i} text={p.text} />
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

/** An error a turn ended with, in plain words: signing in where that's what
 *  would help, and the hub's own words folded away. */
export function TurnError({ raw }: { raw: string }) {
  const said = readableError(raw);
  return (
    <>
      <p className="msg-text state-blocked">
        <Linked text={said.text} />
      </p>
      {said.signIn && (
        <div className="plan-signin">
          <PlanSignIn kind={said.signIn} />
        </div>
      )}
      {said.details && (
        <details className="msg-steps">
          <summary className="small">Details</summary>
          <p className="small muted">{said.details}</p>
        </details>
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
  onRetry,
  onRemove,
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
  /** Sends a message that wasn't delivered again. */
  onRetry?: (id: string) => void;
  /** Takes a message that wasn't delivered away. */
  onRemove?: (id: string) => void;
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
  const cardText = message.role === "assistant" && !!message.desk?.plan && isCardText(message.content);
  const command = !!message.command && !relayed;
  return (
    <article
      className={`msg msg-${fromOverseer ? "assistant" : message.role}${relayed ? " msg-relayed" : ""}${command ? " msg-command" : ""}${message.undelivered ? " msg-undelivered" : ""}`}
      data-message-id={message.id}
    >
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
          {command && (
            <>
              <span className="chip msg-command-chip" title="The hub answered this itself. It isn’t kept in the conversation, so it shows only here.">
                {you ? "Command" : "Only here"}
              </span>{" "}
            </>
          )}
          <span className="faint small" title={fullTime(message.at)}>
            {home ? `${home} · ` : ""}
            {time(message.at)}
          </span>
          {chips}
        </span>
        <ToolChips tools={message.tools} live={message.status === "streaming"} />
        {/* A plan card says all its own header does, and shows it while it can't;
            anything else the boss said with it (its closing summary) stays. */}
        {!message.content.trim() || cardText ? null : message.status === "error" && message.superseded ? (
          <details className="msg-steps">
            <summary className="small">Didn’t finish · answered below</summary>
            <TurnError raw={message.content} />
          </details>
        ) : message.status === "error" ? (
          <TurnError raw={message.content} />
        ) : message.role !== "assistant" && command ? (
          <p className="msg-text">
            <code className="msg-command-text">{shownText(message.content.trim())}</code>
          </p>
        ) : message.role !== "assistant" ? (
          <p className="msg-text">
            <Linked text={relayed?.text ?? (message.role === "user" ? shownText(message.content) : message.content)} />
          </p>
        ) : (
          <RichHostProvider host={host}>
            <div className="msg-text rich">
              <ImageBudget>
                <RichMarkdown text={command ? commandMarkdown(message.content) : message.content} streaming={message.status === "streaming"} />
              </ImageBudget>
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
        {message.undelivered && you && (
          <p className="msg-undelivered-note small" role="status">
            <span className="state-blocked">Not delivered</span>
            {onRetry && (
              <button type="button" className="link small" onClick={() => onRetry(message.id)}>
                Retry
              </button>
            )}
            {onRemove && (
              <button type="button" className="link small" onClick={() => onRemove(message.id)}>
                Remove
              </button>
            )}
          </p>
        )}
        {message.role === "assistant" && message.desk && <DeskActions extras={message.desk} text={cardText ? message.content : undefined} />}
        {message.delivery === "approval" && message.requestId && origin && (
          <RoutedApproval hubId={origin.hub} requestId={message.requestId} />
        )}
      </div>
    </article>
  );
});
