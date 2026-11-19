import { useEffect, useId, useRef, useState } from "react";
import { useChat } from "../chat/store";
import type { HubRef } from "../hub/net";
import { plainError } from "../ui/plainError";
import {
  chosenModel,
  keptModels,
  withModel,
  myAgentRoute,
  myRoute,
  ROUTE_TITLES,
  setMyAgentRoute,
  setMyRoute,
  whereDataGoes,
  type AgentRouteView,
  type RouteFallback,
  type RouteKind,
  type RouteOption,
  type RouteView,
  type PersonalRoute,
  type RouteWork,
} from "./llmRoute";

type Choice = "settings" | "hub" | RouteKind;

interface Row {
  value: Choice;
  title: string;
  sub?: string;
  refused: string | null;
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isKind = (c: Choice): c is RouteKind => c !== "settings" && c !== "hub";
const kindRows = (options: RouteOption[]): Row[] =>
  options.map((o) => ({
    value: o.kind,
    title: ROUTE_TITLES[o.kind],
    refused: o.refused,
  }));

/** The picker itself: one row per choice, a refused one greyed out with
 *  why, then what happens when the plan is used up, then where the
 *  conversations go. */
function Picker({
  label,
  rows,
  value,
  fallback,
  dataLine,
  busy,
  problem,
  onChange,
  models,
}: {
  /** The route's model rows, under the fallback, when it has them. */
  models?: React.ReactNode;
  label: string;
  rows: Row[];
  value: Choice;
  fallback: RouteFallback;
  dataLine: string;
  busy: boolean;
  problem: string | null;
  onChange: (choice: Choice, fallback: RouteFallback) => void;
}) {
  const ids = useId();
  return (
    <div className="route-picker">
      <fieldset className="oversee-card upd-field" disabled={busy}>
        <legend>{label}</legend>
        {rows.map((r) => (
          <label key={r.value} className="oversee-check">
            <input
              type="radio"
              name={`${ids}-route`}
              checked={r.value === value}
              // One already chosen stays chosen, with why it no longer serves.
              disabled={!!r.refused && r.value !== value}
              onChange={() => onChange(r.value, fallback)}
            />
            <span className="oversee-check-text">
              <b>{r.title}</b>
              {r.sub && <span className="oversee-sub">{r.sub}</span>}
              {r.refused && <span className="oversee-sub">{sentence(r.refused)}.</span>}
            </span>
          </label>
        ))}
        {isKind(value) && (
          <>
            <span className="field-label">When my plan is used up or my login fails</span>
            {(
              [
                ["wait", "Wait until it’s back, and say so"],
                ["hub", "Run that turn on the workspace’s models, and say so"],
              ] as const
            ).map(([key, title]) => (
              <label key={key} className="oversee-check">
                <input type="radio" name={`${ids}-fallback`} checked={fallback === key} onChange={() => onChange(value, key)} />
                <span className="oversee-check-text">{title}</span>
              </label>
            ))}
          </>
        )}
        {models}
        <span className="oversee-sub">{dataLine}</span>
      </fieldset>
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** Each kind of work a route's models are chosen for, as an agent's own
 *  model settings name them. */
const WORK: { work: RouteWork; name: string; what: string }[] = [
  {
    work: "conversation",
    name: "Conversation",
    what: "Plain chatting with you",
  },
  {
    work: "light",
    name: "Light background",
    what: "Session notes, gists, memory and running accounts",
  },
  {
    work: "heavy",
    name: "Heavy background",
    what: "Check-ins, decisions on sessions, updates and compaction",
  },
];

const TIERS = [
  ["cheap", "Cheapest model"],
  ["standard", "Everyday model"],
  ["powerful", "Most capable model"],
] as const;

const DEFAULT = "";

/** The models the person's own route runs by kind of work: its default, a
 *  tier, one of the models its provider offers, or for background work the
 *  conversation model. Shown only where the workspace lists the models. */
function RouteModelsRows({
  option,
  route,
  busy,
  onChange,
}: {
  option: RouteOption;
  route: PersonalRoute;
  busy: boolean;
  onChange: (route: PersonalRoute) => void;
}) {
  const ids = useId();
  const models = option.models ?? [];
  // Every tier on Codex is the one plan model, so only its models are offered.
  const tiers = option.kind === "codex" ? [] : TIERS;
  return (
    <>
      <span className="field-label">Models on {ROUTE_TITLES[option.kind]}</span>
      <div className="think-rows">
        {WORK.map(({ work, name, what }) => {
          const set = chosenModel(route, work);
          const known = !set || set === "chat" || models.includes(set) || tiers.some(([t]) => t === set);
          const id = `${ids}-${work}`;
          return (
            <div key={work} className="think-row think-row-work">
              <label htmlFor={id}>{name}</label>
              <span className="think-work">
                <select
                  id={id}
                  className="ability-select"
                  value={set ?? DEFAULT}
                  disabled={busy}
                  aria-describedby={`${id}-what`}
                  onChange={(e) => onChange(withModel(route, work, e.target.value === DEFAULT ? undefined : e.target.value))}
                >
                  <option value={DEFAULT}>
                    Default
                    {option.defaults ? ` · ${option.defaults[work]}` : ""}
                  </option>
                  {work !== "conversation" && <option value="chat">Same as conversation</option>}
                  {tiers.map(([tier, label]) => (
                    <option key={tier} value={tier}>
                      {label}
                    </option>
                  ))}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {!known && <option value={set}>{set}</option>}
                </select>
                <span id={`${id}-what`} className="small faint">
                  {what}
                </span>
              </span>
              {set ? <span /> : <span className="chip chip-default">Default</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** A loaded view, saving through `save`: each change is sent at once and
 *  the workspace's answer shown. */
function useRoute<V>(load: () => Promise<V>, deps: unknown[]) {
  const [view, setView] = useState<V | null>(null);
  // Which load is current: a save answered after the hub or agent changed
  // is dropped.
  const current = useRef(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    current.current += 1;
    // Another agent's or workspace's choice never shows, nor takes a click.
    setView(null);
    setProblem(null);
    load().then(
      (v) => live && setView(v),
      (e) => live && setProblem(plainError(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  const save = async (send: () => Promise<V>) => {
    const at = current.current;
    setBusy(true);
    setProblem(null);
    try {
      const next = await send();
      if (at === current.current) setView(next);
      // What each agent is shown to run on for you follows the choice.
      void useChat.getState().refreshRoster();
    } catch (e) {
      if (at === current.current) setProblem(plainError(e));
    } finally {
      setBusy(false);
    }
  };
  return { view, problem, busy, save };
}

/** The model rows for `route`, where the workspace lists its kind's models
 *  (one from before doesn't, and would refuse them). */
const modelsFor = (options: RouteOption[], route: PersonalRoute | null, busy: boolean, onChange: (route: PersonalRoute) => void) => {
  const option = route && options.find((o) => o.kind === route.kind && o.models !== undefined);
  return option && route ? <RouteModelsRows option={option} route={route} busy={busy} onChange={onChange} /> : undefined;
};

/** What `refused` says when nothing here can be picked. */
const unavailable = (options: RouteOption[]) =>
  sentence(options[0]?.refused ?? "this workspace doesn’t run people’s work on their own subscriptions") + ".";

/** Settings › Workspaces: what the person's work on `hub` runs on, on every
 *  agent there that allows it. */
export function WorkspaceRoute({ hub, workspace }: { hub: HubRef; workspace: string }) {
  const { view, problem, busy, save } = useRoute<RouteView>(() => myRoute(hub), [hub.id, hub.url]);
  if (!view) return problem ? <p className="small faint">Couldn’t read what your work runs on: {problem}</p> : null;
  if (view.missing) return null;
  if (!view.available) return <p className="small faint">{unavailable(view.options)}</p>;
  const value: Choice = view.route?.kind ?? "hub";
  return (
    <Picker
      label="Run my work on"
      rows={[{ value: "hub", title: `${workspace}’s models`, refused: null }, ...kindRows(view.options)]}
      value={value}
      fallback={view.route?.fallback ?? "wait"}
      dataLine={whereDataGoes(view.route?.kind ?? null, workspace)}
      busy={busy}
      problem={problem}
      onChange={(choice, fallback) =>
        void save(() => setMyRoute(hub, isKind(choice) ? { ...keptModels(view.route, choice), kind: choice, fallback } : null))
      }
      models={modelsFor(view.options, view.route, busy, (route) => void save(() => setMyRoute(hub, route)))}
    />
  );
}

/** An agent's settings: what the person's work with this agent alone runs
 *  on, "As in my settings" first. */
export function AgentRoute({ hub, workspace, agentId }: { hub: HubRef; workspace: string; agentId: string }) {
  const { view, problem, busy, save } = useRoute<AgentRouteView>(() => myAgentRoute(hub, agentId), [hub.id, hub.url, agentId]);
  if (!view) return problem ? <p className="small faint">Couldn’t read what your work runs on: {problem}</p> : null;
  if (view.missing) return null;
  if (!view.available) return <p className="small faint">{unavailable(view.options)}</p>;
  const route = view.route;
  const value: Choice = route === null ? "settings" : route === "hub" ? "hub" : route.kind;
  const own = route !== null && route !== "hub" ? route : null;
  const everyAgent = view.everyAgent ? ROUTE_TITLES[view.everyAgent.kind] : `${workspace}’s models`;
  return (
    <Picker
      label="Run my work with them on"
      rows={[
        {
          value: "settings",
          title: "As in my settings",
          sub: `Now: ${everyAgent}`,
          refused: null,
        },
        { value: "hub", title: `${workspace}’s models`, refused: null },
        ...kindRows(view.options),
      ]}
      value={value}
      fallback={own?.fallback ?? view.everyAgent?.fallback ?? "wait"}
      dataLine={whereDataGoes(view.effective?.kind ?? null, workspace)}
      busy={busy}
      problem={problem}
      onChange={(choice, fallback) =>
        void save(() =>
          setMyAgentRoute(
            hub,
            agentId,
            choice === "settings" ? null : choice === "hub" ? "hub" : { ...keptModels(own, choice), kind: choice, fallback },
          ),
        )
      }
      models={modelsFor(view.options, own, busy, (route) => void save(() => setMyAgentRoute(hub, agentId, route)))}
    />
  );
}
