import { useEffect, useId, useState, type ReactNode } from "react";
import type { DeskHub } from "../hub/client";
import type { GroupMemory as Switches, MemorySettings } from "../hub/types";
import { CloseButton, Dialog } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { providerName } from "./words";

/** A group's memory switches: whether its sessions are remembered, whether
 *  Desk's model reads them for notes, and whether Desk asks before handing
 *  its work to another engine. Each saves as it is switched. */
export function GroupMemoryDialog({ group, hub, onClose }: { group: { id: string; name: string }; hub: DeskHub | null; onClose: () => void }) {
  const [settings, setSettings] = useState<MemorySettings | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!hub) return;
    hub.memorySettings().then(setSettings, (e: unknown) => {
      setSettings(null);
      setProblem(plainError(e));
    });
  }, [hub]);
  const switches = settings?.groups.find((g) => g.id === group.id);
  const change = async (patch: Partial<Omit<Switches, "deriveDecided">>) => {
    if (!hub || !settings) return;
    try {
      const now = await hub.changeGroupMemory(group.id, patch);
      setSettings({ ...settings, groups: settings.groups.map((g) => (g.id === group.id ? { ...g, ...now } : g)) });
      setProblem(null);
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
          <p className="muted small">{settings === null && !problem ? "This computer's hub can't keep memory settings for groups yet." : `Desk doesn't know ${group.name} on this computer's hub yet.`}</p>
        ) : (
          <>
            <Row
              name="Remember its sessions"
              sub="Desk keeps what they say, with secrets hidden, to search and to pick up later. Off, nothing they say meanwhile is kept."
              on={switches.harvest}
              onChange={(harvest) => void change({ harvest })}
            />
            <Row
              name="Let Desk's model note decisions"
              sub={`Desk's model reads what they say to note decisions, facts and to-dos, so it's sent to ${providerName(settings.limits.provider) ?? "the model the hub notes with"}.`}
              on={switches.derive}
              disabled={!settings.limits.derive}
              onChange={(derive) => void change({ derive })}
            >
              {!settings.limits.derive && <span className="ability-sub">Noting is turned off for this Desk.</span>}
            </Row>
            <Row
              name="Ask before handing its work on"
              sub="Desk asks before it continues one of its sessions in another engine."
              on={switches.handoffAsk}
              onChange={(handoffAsk) => void change({ handoffAsk })}
            />
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
