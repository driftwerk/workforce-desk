import { useEffect, useRef, useState } from "react";
import { ENGINE_TITLE, startable } from "../engines/engines";
import { useDesk, localSessions } from "../hub/store";
import type { Engine, EngineInfo, Ticket } from "../hub/types";
import { useHubOf, useMachines, keyOf, LOCAL, type MachineId } from "../machines/engines";
import { FolderPicker } from "../machines/FolderPicker";
import { homeWithin, onMachine } from "../machines/folders";
import { native as machineNative, type MachineNative } from "../machines/native";
import { RunOn } from "../machines/RunOn";
import { nameOfMachine, thisComputerLower } from "../machines/words";
import { useHost } from "../shell/host";
import { machineHome, pickFolder } from "../platform";
import { usePlans } from "../crew/planStore";
import { ModelSelect } from "../engines/ModelSelect";
import { isModelName, machineEnv, NothingToStart } from "../session/NewSession";
import { useModal } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { GroupChoice } from "../session/GroupChoice";
import { sessionItem, UNGROUPED } from "../groups/model";
import { moveItem, nameSession, useLayout } from "../groups/store";
import { recentFolders, sessionNameFor, sessionsOf, startDefaults, startOn } from "./board";
import { boardStartGroup, lastBoardGroup, lastBoardStart, rememberBoardGroup, rememberBoardStart } from "./startGroup";
import { useBoard } from "./store";

/** A folder as a chip says it: its own name. */
const folderName = (dir: string): string => dir.split("/").filter(Boolean).pop() ?? dir;

/** A new session for a ticket: where it runs (this computer or one of the
 *  person's machines), its engine, folder and model, as New session has them;
 *  it starts with the ticket as its goal and first prompt, and the ticket
 *  moves to Doing. */
export function StartSession({ ticket: t, onClose, native = machineNative }: { ticket: Ticket; onClose: () => void; native?: MachineNative }) {
  const localHub = useDesk((s) => s.hub);
  const sessions = useDesk((s) => localSessions(s.sessions));
  const machines = useMachines((s) => s.machines);
  const platform = useHost((h) => h.platform);
  // The ticket's own machine, folder, engine and model, when a plan gave it any.
  const planned = usePlans((s) => Object.values(s.details).flatMap((d) => d.tickets).find((x) => x.id === t.id) ?? null);
  // The folder and engine to go by: the ticket's own sessions', else the
  // board's, else its last start's: nothing is typed unless there is nothing.
  const boardTickets = useBoard((s) => s.tickets);
  const [from] = useState(() =>
    startDefaults(t, Object.values(boardTickets).filter((x) => x.board === t.board), sessions, lastBoardStart(t.board)),
  );
  const recent = recentFolders(Object.values(sessions));
  const layout = useLayout();
  const boardGroup = useBoard((s) => s.boards[t.board]?.group);
  const [group, setGroup] = useState(() => boardStartGroup(layout, boardGroup, lastBoardGroup()));
  const [on] = useState(() => startOn(planned, lastBoardStart(t.board), from));
  // Where it runs: the default only while that machine can take a session.
  const [wanted, setRunOn] = useState<MachineId>(on.machine);
  const [features, setFeatures] = useState<string[] | null>(null);
  // Only a hub that can start a ticket's session on a machine, or with a model.
  const canStartOn = features?.includes("ticket-start-on") === true;
  const machine: MachineId = canStartOn && machines.some((m) => m.id === wanted && m.state.kind === "ready") ? wanted : LOCAL;
  const remote = machine !== LOCAL;
  const hub = useHubOf(machine);
  const where = nameOfMachine(machine, machines, platform);
  const whereSaid = remote ? where : thisComputerLower(platform);
  const [picked, setEngine] = useState<Engine>((on.engine ?? from.engine ?? "claude") as Engine);
  // A folder for each computer: one here isn't one there.
  const [cwds, setCwds] = useState<Record<string, string>>({ [LOCAL]: from.cwd, ...(on.machine !== LOCAL ? { [on.machine]: on.folder } : {}) });
  const cwd = cwds[machine] ?? "";
  const setCwd = (dir: string) => setCwds((c) => ({ ...c, [machine]: dir }));
  const [models, setModels] = useState<Partial<Record<Engine, string | null>>>(on.model ? { [picked]: on.model } : {});
  const [machineFeatures, setMachineFeatures] = useState<string[] | null>(null);
  const [readAt, setReadAt] = useState(0);
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sheet = useRef<HTMLFormElement>(null);
  const keys = useModal(sheet, onClose);
  useEffect(() => {
    let live = true;
    localHub
      ?.features?.()
      .then((f) => live && setFeatures(f))
      .catch(() => live && setFeatures([]));
    return () => {
      live = false;
    };
  }, [localHub]);
  // Its computer's engines (and, on a machine, what its hub can do), read
  // again once Desk has installed or signed one in.
  useEffect(() => {
    let live = true;
    setEngines(null);
    (readAt ? hub?.enginesNow() : hub?.engines())
      ?.then((e) => live && setEngines(e))
      .catch(() => live && setEngines(null));
    return () => {
      live = false;
    };
  }, [hub, readAt]);
  useEffect(() => {
    let live = true;
    setMachineFeatures(null);
    if (remote)
      hub
        ?.features?.()
        .then((f) => live && setMachineFeatures(f))
        .catch(() => live && setMachineFeatures([]));
    return () => {
      live = false;
    };
  }, [hub, remote]);
  // What it went by may not start here (not installed, or no view): then
  // the first engine that does.
  const choices = startable(engines);
  const engine: Engine = choices.includes(picked) ? picked : (choices[0] ?? picked);
  // A model is offered where its hub runs the one it is given.
  const canPickModel = remote ? machineFeatures?.includes("session-model") === true : canStartOn;
  const model = canPickModel ? (models[engine] ?? null) : null;
  const badModel = model && !isModelName(model, engine) ? model : null;
  const noEngine = engines !== null && choices.length === 0;
  const missing = remote ? (engines?.filter((e) => e.installed === false).map((e) => e.title) ?? []) : [];
  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!remote && !cwd.trim()) || badModel || noEngine || !hub || !localHub) return;
    setBusy(true);
    setProblem(null);
    let started: { id: string; name: string } | null = null;
    try {
      const had = new Set(sessionsOf(t));
      let made: string | null;
      let at = cwd.trim();
      if (remote) {
        // On a machine, its own path: `~` (and nothing typed) is its home.
        at = onMachine(at || "~", await homeWithin(() => machineHome(machine), machine));
        const text = await localHub.ticketStartText(t.id, machine);
        const s = await hub.start({
          engine,
          cwd: at,
          name: text.name,
          goal: text.goal,
          prompt: text.prompt,
          ...(model ? { model } : {}),
          env: await machineEnv(native, machine),
        });
        started = { id: s.id, name: s.name || text.name };
        await useBoard.getState().assign(t.id, { machineSession: { machine, id: s.id, name: started.name } });
        made = keyOf(machine, s.id);
      } else {
        const now = await useBoard.getState().assign(t.id, { newSession: { path: at, engine, ...(model ? { model } : {}) } });
        // The new session: the one the ticket gained, else the one it is given to.
        made = now ? (sessionsOf(now).find((id) => !had.has(id)) ?? (now.assignee?.kind === "session" ? now.assignee.id : null)) : null;
      }
      rememberBoardGroup(group);
      rememberBoardStart(t.board, { cwd: cwd.trim(), engine, ...(remote ? { machine } : {}), ...(model ? { model } : {}) });
      if (made) {
        if (group !== UNGROUPED && layout.groups.some((g) => g.id === group)) moveItem([], sessionItem(made), group, null);
        // Short, so the sidebar row still shows it: the key and a few words.
        nameSession(made, sessionNameFor(t), useDesk.getState().sessions[made]?.name ?? "");
      }
      onClose();
    } catch (err) {
      setProblem(
        started
          ? `${started.name} did start on ${where}, but the ticket couldn’t be given to it (${plainError(err)}). It is running: don’t start another.`
          : plainError(err),
      );
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={keys}>
      <form ref={sheet} className="sheet" onSubmit={start} aria-label={`Start a session on ${t.key ?? "the ticket"}`} tabIndex={-1}>
        <h2 className="display-lg">Start a session on {t.key ?? "it"}</h2>
        <p className="muted small">It starts with “{t.title}” as its goal and first prompt, and the ticket moves to Doing.</p>
        {canStartOn && (
          <RunOn
            value={machine}
            onChange={(m) => {
              if (m === machine) return;
              setRunOn(m);
              setProblem(null);
            }}
          />
        )}
        {noEngine && engines && <NothingToStart engines={engines} machine={machine} where={whereSaid} native={native} onFixed={() => setReadAt(Date.now())} />}
        <div className="seg" role="radiogroup" aria-label="Engine">
          {choices.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={engine === k} onClick={() => setEngine(k)}>
              {ENGINE_TITLE[k]}
            </button>
          ))}
        </div>
        {remote && missing.length > 0 && !noEngine && (
          <p className="muted small">
            {missing.join(" and ")} {missing.length === 1 ? "isn’t" : "aren’t"} installed on {where}.
          </p>
        )}
        {remote ? (
          <FolderPicker key={machine} machine={machine} name={where} native={native} value={cwd} onChange={setCwd} always />
        ) : (
          <>
          {recent.length > 0 && (
            <div className="field">
              <span className="ov-label muted">Recent folders</span>
              <div className="chip-row" role="radiogroup" aria-label="Recent folders">
                {recent.map((dir) => (
                  <button key={dir} type="button" role="radio" className="chip-btn" title={dir} aria-checked={cwd.trim() === dir} aria-pressed={cwd.trim() === dir} onClick={() => setCwd(dir)}>
                    {folderName(dir)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="field">
            <span>Folder</span>
            <span className="field-row">
              <input data-autofocus value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="Choose a folder, or type its path" required />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={async () => {
                  const dir = await pickFolder();
                  if (dir) setCwd(dir);
                }}
              >
                Choose…
              </button>
            </span>
          </label>
          </>
        )}
        {canPickModel && choices.includes(engine) && (
          <div className="field">
            <span className="ov-label muted">Model</span>
            <ModelSelect engine={engine} value={model} label="Model" onChange={(m) => setModels((p) => ({ ...p, [engine]: m }))} />
          </div>
        )}
        {layout.groups.length > 0 && (
          <div className="field">
            <span className="ov-label muted">Group</span>
            <GroupChoice group={group} groups={layout.groups} onPick={setGroup} />
          </div>
        )}
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
        <footer className="sheet-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-signal" disabled={busy || (!remote && !cwd.trim()) || !!badModel || noEngine || !hub}>
            Start session
          </button>
        </footer>
      </form>
    </div>
  );
}
