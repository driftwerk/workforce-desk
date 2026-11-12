import { useEffect, useId, useState, type ReactNode } from "react";
import type { DeskHub } from "../hub/client";
import { deskListeners } from "../hub/store";
import type { DeskEvent, GroupMemory as Switches, MemorySettings } from "../hub/types";
import { CloseButton, Dialog } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { fallbackText, providerName } from "./words";

/** A group's memory switches: whether its sessions are remembered, and
 *  whether Desk's model reads them for notes. Each saves as it is switched.
 *  (Whether Desk asks before handing its work on comes with handoff.) */
export function GroupMemoryDialog({ group, hub, onClose }: { group: { id: string; name: string }; hub: DeskHub | null; onClose: () => void }) {
  const [settings, setSettings] = useState<MemorySettings | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!hub) return;
    const read = () =>
      hub.memorySettings().then(setSettings, (e: unknown) => {
        setSettings(null);
        setProblem(plainError(e));
      });
    void read();
    // Changed elsewhere (another window, the panel's ask): read again.
    const heard = (e: DeskEvent) => {
      if (e.type === "setting") void read();
    };
    deskListeners.add(heard);
    return () => void deskListeners.delete(heard);
  }, [hub]);
  const switches = settings?.groups.find((g) => g.id === group.id);
  const noting = !!settings && settings.limits.enabled && settings.limits.derive;
  // Turned on for the whole Desk here, then on for this group too.
  const turnNotingOn = async () => {
    if (!hub) return;
    let now: MemorySettings;
    try {
      now = await hub.chooseMemory({ enabled: true, derive: true });
      setSettings(now);
      setProblem(null);
    } catch (e) {
      setProblem(plainError(e));
      return;
    }
    try {
      const changed = await hub.changeGroupMemory(group.id, { derive: true });
      const { notice, ...on } = changed;
      setSettings({ ...now, groups: now.groups.map((g) => (g.id === group.id ? { ...g, ...on } : g)) });
      setProblem(notice ?? null);
    } catch (e) {
      // The Desk's part stands: say the group's didn't.
      setProblem(`Noting is on for the whole Desk now, but not for ${group.name} yet: ${plainError(e)} Turn it on with the switch above.`);
    }
  };
  const change = async (patch: Partial<Omit<Switches, "deriveDecided">>) => {
    if (!hub || !settings) return;
    try {
      const now = await hub.changeGroupMemory(group.id, patch);
      const { notice, ...switches } = now;
      setSettings({ ...settings, groups: settings.groups.map((g) => (g.id === group.id ? { ...g, ...switches } : g)) });
      setProblem(notice ?? null);
    } catch (e) {
      setProblem(plainError(e));
    }
  };
  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              Memory for {group.name}
            </h1>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-body memory-group">
        {settings === undefined ? (
          <p className="faint small">Loading…</p>
        ) : !settings || !switches ? (
          <p className="muted small">{settings === null && !problem ? "This version of Desk can't keep memory settings for groups yet." : `Desk doesn't know ${group.name} on this computer yet.`}</p>
        ) : (
          <>
            <Row
              name="Remember its sessions"
              sub="Desk keeps what they say, with secrets hidden, to search and to pick up later. Off, Desk keeps nothing new from them, but you can still search what it kept before."
              on={switches.harvest}
              onChange={(harvest) => void change({ harvest })}
            />
            <Row
              name="Let Desk's model note decisions"
              sub={`Desk's model reads what they say to note decisions, facts and to-dos, so it's sent to ${providerName(settings.limits.provider) ?? "the model Desk notes with"}.${settings.limits.fallbackProviders ? ` ${fallbackText}` : ""}`}
              on={switches.derive}
              disabled={!noting}
              onChange={(derive) => void change({ derive })}
            >
              {!noting && (
                <span className="ability-sub memory-off">
                  Noting is turned off for this Desk.
                  <button type="button" className="btn btn-sm" onClick={() => void turnNotingOn()}>
                    Turn on noting for the whole Desk and this group
                  </button>
                </span>
              )}
            </Row>
          </>
        )}
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
      </div>
      <footer className="dialog-foot">
        <span className="dialog-foot-note" />
        <button type="button" className="btn" data-autofocus onClick={onClose}>
          Done
        </button>
      </footer>
    </Dialog>
  );
}

function Row({
  name,
  sub,
  on,
  disabled = false,
  onChange,
  children,
}: {
  name: string;
  sub: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="ability-row">
      <span className="ability-text">
        <b id={id}>{name}</b>
        <span className="ability-sub">{sub}</span>
        {children}
      </span>
      <button type="button" role="switch" className="switch" aria-checked={on} aria-labelledby={id} disabled={disabled} onClick={() => onChange(!on)}>
        <span className="switch-knob" />
      </button>
    </div>
  );
}
