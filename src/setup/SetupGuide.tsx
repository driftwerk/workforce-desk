import { useEffect, type ReactNode } from "react";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { OverseerCard } from "../floor/OverseerCard";
import { PlanSignIn } from "../floor/PlanCards";
import { openLoginItems, startHelper } from "../platform";
import { useDesk } from "../hub/store";
import { AgentMark } from "../ui/Mark";
import { openSettingsAt } from "../ui/problem";
import { useUi } from "../shell/ui";
import {
  closeSetup,
  leftOf,
  skip,
  STEP_TEXT,
  STEPS,
  unskip,
  useFacts,
  useProgress,
  useSteps,
  watchFacts,
  type StepId,
  type StepState,
} from "./steps";

/** What Desk's agent is asked to help with: the steps left, and those
 *  skipped (so it neither redoes them nor thinks them forgotten). */
export const helpText = (left: readonly StepId[], skipped: readonly StepId[] = []): string =>
  [
    "Help me finish setting up Desk. What's left:",
    ...left.map((s) => `- ${STEP_TEXT[s].title}`),
    ...(skipped.length ? ["", "I skipped these for now:", ...skipped.map((s) => `- ${STEP_TEXT[s].title}`)] : []),
    "",
    "Do what you can yourself, and tell me what only I can do.",
  ].join("\n");

/** Desk's first-run setup, said by Desk's own agent in its DM: each step a
 *  card that does it or opens where it's done, each skippable, and all of
 *  it closable and opened again from Settings. Without an agent (none on
 *  this computer yet), Desk says it itself. Every button is the person's:
 *  no agent's message can press one. */
export function SetupGuide({ agent }: { agent?: Agent }) {
  const progress = useProgress();
  const steps = useSteps();
  const allDone = STEPS.every((s) => steps[s] === "done");
  // Read again every few seconds until every step is done.
  useEffect(() => (allDone ? undefined : watchFacts()), [allDone]);
  const left = leftOf(steps, progress.skipped);
  const done = STEPS.filter((s) => steps[s] === "done").length;
  const name = agent?.name ?? "Desk";
  const key = agent ? agentKey(agent) : null;
  const skippedNow = STEPS.filter((s) => steps[s] !== "done" && progress.skipped.includes(s));
  const ask = () => key && useChat.getState().send(key, helpText(left, skippedNow));
  return (
    <article className="msg msg-assistant setup-guide" aria-label="Set up Desk">
      {key ? <AgentMark agent={key} name={name} /> : <span className="setup-mark" aria-hidden="true" />}
      <div className="msg-body">
        <span className="msg-head">
          <b className="display">{name}</b>
          <span className="faint small">
            Setup · {done} of {STEPS.length} done
          </span>
        </span>
        <p className="msg-text">
          {left.length === 0
            ? "You’re set up. Open this again from Settings whenever you want to change something."
            : `Hi, I’m ${name}. Let’s get Desk ready: each step below does it or takes you to where it’s done. Skip anything you don’t need.`}
        </p>
        <ol className="setup-steps">
          {STEPS.map((s) => (
            <Step key={s} id={s} state={steps[s]} skipped={progress.skipped.includes(s)} agentName={name} agentKey={key} />
          ))}
        </ol>
        <div className="setup-foot">
          {key && left.length > 0 && (
            <button type="button" className="btn btn-sm" onClick={ask}>
              Ask {name} to help with the rest
            </button>
          )}
          <button type="button" className="link small" onClick={closeSetup}>
            {left.length === 0 ? "Close" : "Close setup"}
          </button>
          <span className="faint small">You can open it again in Settings → Help.</span>
        </div>
      </div>
    </article>
  );
}

function Step({
  id,
  state,
  skipped,
  agentName,
  agentKey: key,
}: {
  id: StepId;
  state: StepState;
  skipped: boolean;
  agentName: string;
  agentKey: string | null;
}) {
  const text = STEP_TEXT[id];
  const mark = state === "done" ? "✓" : skipped ? "–" : "•";
  return (
    <li className={`setup-step setup-${skipped && state !== "done" ? "skipped" : state}`} aria-label={text.title}>
      <span className="setup-step-mark" aria-hidden="true">
        {mark}
      </span>
      <div className="setup-step-body">
        <b>{text.title}</b>
        {state === "done" ? (
          <span className="small state-done">Done</span>
        ) : skipped ? (
          <span className="small faint">
            Skipped.{" "}
            <button type="button" className="link small" onClick={() => unskip(id)}>
              Do it now
            </button>
          </span>
        ) : (
          <>
            <span className="small muted">{text.why}</span>
            <div className="setup-step-actions">
              <Actions id={id} agentName={agentName} agentKey={key} />
              <button type="button" className="link small" onClick={() => skip(id)}>
                Skip
              </button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}

/** What a step's card does. */
function Actions({ id, agentName, agentKey: key }: { id: StepId; agentName: string; agentKey: string | null }): ReactNode {
  const helper = useFacts((s) => s.helper);
  const fail = useDesk((s) => s.fail);
  const read = useFacts((s) => s.read);
  switch (id) {
    case "plan":
      return (
        <>
          <PlanSignIn kind="claude" />
          <PlanSignIn kind="chatgpt" />
          <button type="button" className="link small" onClick={() => openSettingsAt("providers")}>
            Use an API key instead
          </button>
        </>
      );
    case "helper":
      return helper?.state === "needs-approval" ? (
        <button type="button" className="btn btn-sm btn-signal" onClick={() => void openLoginItems().catch(fail)}>
          Allow it in Login Items
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-sm btn-signal"
          onClick={() =>
            void startHelper()
              .then(() => read())
              .catch((e: unknown) => fail(e, { what: "starting Desk's helper" }))
          }
        >
          Start it
        </button>
      );
    case "overseer":
      return <OverseerStep />;
    case "connections":
      return (
        <>
          <button type="button" className="btn btn-sm btn-signal" onClick={() => openSettingsAt("connections")}>
            Open Connections
          </button>
          {key && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => useChat.getState().send(key, "Help me connect the services I work in (GitHub, Jira, Linear…). Ask me which ones.")}
            >
              Ask {agentName} to connect one
            </button>
          )}
        </>
      );
    case "workspaces":
      return (
        <button type="button" className="btn btn-sm btn-signal" onClick={() => openSettingsAt("hubs")}>
          Pair a workspace
        </button>
      );
    case "machines":
      return (
        <button type="button" className="btn btn-sm btn-signal" onClick={() => openSettingsAt("machines")}>
          Add a machine
        </button>
      );
  }
}

/** The overseer step: #175's card, or, with no agent here to oversee yet,
 *  a crew member to make first. */
function OverseerStep() {
  const local = useChat((s) => s.hubs.find((h) => h.local)?.id ?? null);
  const anyone = useChat((s) => s.roster.some((a) => a.hubId === local));
  if (!anyone)
    return (
      <>
        <span className="small muted">You have no crew member to oversee it yet.</span>
        <button type="button" className="btn btn-sm btn-signal" onClick={() => useUi.getState().setNewCrew(true)}>
          New crew member
        </button>
      </>
    );
  return <OverseerCard inSetup />;
}
