import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import { machineHome } from "../platform";
import type { MachineId } from "./engines";
import { sessionsOn } from "./engines";
import { homeWithin, listIn, meant, parentOf, shownPath, splitTyped, tilde, type Folder, type Listed } from "./folders";
import type { MachineNative } from "./native";

/** How long typing rests before the machine is asked for its folders. */
export const FOLDERS_DEBOUNCE_MS = 200;

/** The machine's home, from SSH (whether or not its hub answers), else as
 *  its folder listing names it; null until known. */
export function useMachineHome(machine: MachineId, listed: string | null): string | null {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    homeWithin(() => machineHome(machine), machine)
      .then((h) => live && setHome(h))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [machine]);
  return home ?? listed;
}

/** "2 h ago", "yesterday", "3 days ago". */
const ago = (iso: string, now = Date.now()): string => {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86_400) return "yesterday";
  return `${Math.round(s / 86_400)} days ago`;
};

/** The folders sessions ran in on `machine` lately, newest first. */
export function useRecentFolders(machine: MachineId, home: string | null): { path: string; when: string }[] {
  const sessions = useDesk((s) => s.sessions);
  const seen = new Set<string>();
  return sessionsOn(sessions, machine)
    .filter((s) => s.cwd)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap((s) => {
      const path = tilde(s.cwd, home);
      if (seen.has(path)) return [];
      seen.add(path);
      return [{ path, when: ago(s.updatedAt) }];
    })
    .slice(0, 4);
}

/** A folder on a machine: typed as its own path, or picked from the
 *  folders there (browsing in with ›, out with Up). Home is always the
 *  first choice and always works. Each listing gives up after 10 s and
 *  says so; a folder that isn't there is said, with the one it most likely
 *  meant. */
export function FolderPicker({
  machine,
  name,
  native,
  value,
  onChange,
  always = false,
  autoFocus = false,
  onMissing,
}: {
  machine: MachineId;
  name: string;
  native: Pick<MachineNative, "transport">;
  value: string;
  onChange: (path: string) => void;
  /** Says of home that it is always there (New session's panel). */
  always?: boolean;
  /** Told whether the folder typed is one the machine says isn't there. */
  onMissing?: (missing: boolean) => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const typed = value.trim();
  const dir = typed.endsWith("/") || typed === "~" ? typed.replace(/\/+$/, "") || "~" : splitTyped(typed).dir;
  const typedPrefix = typed.endsWith("/") || typed === "~" ? "" : splitTyped(typed).prefix;
  const [listed, setListed] = useState<Listed | null>(null);
  const [parentFolders, setParentFolders] = useState<Folder[]>([]);
  const [again, setAgain] = useState(0);
  const home = useMachineHome(machine, listed?.kind === "ok" ? listed.home : null);
  const recent = useRecentFolders(machine, home);

  const where = dir && dir !== "~" ? dir : null;
  useEffect(() => {
    let live = true;
    setListed(null);
    const t = setTimeout(() => {
      void listIn(native.transport(machine), where).then((l) => {
        if (!live) return;
        setListed(l);
        // A folder that isn't there: what's beside it, for "Did you mean".
        const up = where ? parentOf(where) : null;
        if (l.kind === "missing" && up)
          void listIn(native.transport(machine), up === "~" ? null : up).then((p) => live && setParentFolders(p.kind === "ok" ? p.folders.map((f) => ({ ...f, path: tilde(f.path, home) })) : []));
        else setParentFolders([]);
      });
    }, FOLDERS_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `home` only shortens what is shown: it never lists again.
  }, [machine, where, native, again]);

  // Under ~ wherever they are in its home, as the person types them.
  const folders = listed?.kind === "ok" ? listed.folders.map((f) => ({ ...f, path: tilde(f.path, home) })) : [];
  // A folder picked from the list keeps the others beside it shown.
  const prefix = folders.some((f) => f.path === typed) ? "" : typedPrefix;
  const shown = folders.filter((f) => {
    const last = f.path.slice(f.path.lastIndexOf("/") + 1);
    return last.toLowerCase().startsWith(prefix.toLowerCase());
  });
  // Typed a folder that isn't there: said, with the likeliest one.
  const typedMissing =
    listed?.kind === "ok" && prefix !== "" && !folders.some((f) => f.path === typed || f.path.slice(f.path.lastIndexOf("/") + 1).toLowerCase().startsWith(prefix.toLowerCase()));
  const missingPath = listed?.kind === "missing" ? (dir ?? "~") : typedMissing ? typed : null;
  const suggestion = listed?.kind === "missing" ? meant(dir ?? "", parentFolders) : typedMissing ? meant(typed, folders) : null;
  const up = dir ? parentOf(dir) : null;
  const tell = useRef(onMissing);
  tell.current = onMissing;
  useEffect(() => tell.current?.(!!missingPath), [missingPath]);
  const open = (path: string) => onChange(`${path.replace(/\/+$/, "")}/`);
  const retry = useCallback(() => setAgain((n) => n + 1), []);

  return (
    <div className="field folder-picker">
      <label htmlFor={id} className="ov-label muted">
        Folder on {name}
      </label>
      <span className="field-row">
        <input
          id={id}
          className="field-text mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="~"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoFocus={autoFocus}
          data-autofocus={autoFocus || undefined}
        />
        {up && (
          <button type="button" className="btn" onClick={() => open(up)}>
            Up
          </button>
        )}
      </span>
      <ul className="folder-list" aria-label={`Folders on ${name}`}>
        <li>
          <button type="button" className={`folder-row ${typed === "~" || typed === "" ? "on" : ""}`} onClick={() => onChange("~")}>
            <span className="folder-home" aria-hidden="true">
              ⌂
            </span>
            <span className="mono">~</span>
            <span className="small muted">
              · home folder{home ? `, ${shownPath(home)}` : ""}
              {always ? ", always there" : ""}
            </span>
          </button>
          <button type="button" className="folder-open" aria-label="Open ~" onClick={() => open("~")}>
            ›
          </button>
        </li>
        {shown.map((f) => (
          <li key={f.path}>
            <button type="button" className={`folder-row ${typed.replace(/\/+$/, "") === f.path ? "on" : ""}`} onClick={() => onChange(f.path)}>
              <span className="mono">{shownPath(f.path)}</span>
              {f.git && <span className="mono small faint">git</span>}
            </button>
            <button type="button" className="folder-open" aria-label={`Open ${shownPath(f.path)}`} onClick={() => open(f.path)}>
              ›
            </button>
          </li>
        ))}
      </ul>
      {listed === null && <span className="small faint">Reading {name}’s folders… Desk gives up after 10 s and says why.</span>}
      {missingPath && (
        <>
          <span className="small state-blocked" role="alert">
            {name} has no folder {shownPath(missingPath)}.
          </span>
          {suggestion && (
            <span className="folder-meant small">
              Did you mean {shownPath(suggestion)}?{" "}
              <button type="button" className="btn btn-sm" onClick={() => onChange(suggestion)}>
                Use it
              </button>
            </span>
          )}
        </>
      )}
      {listed?.kind === "slow" && (
        <>
          <span className="small state-blocked" role="alert">
            Couldn’t list the folders in {shownPath(dir ?? "~")}: {name} didn’t answer within 10 s.
          </span>
          <span className="folder-meant small">
            <button type="button" className="btn btn-sm" onClick={retry}>
              Try again
            </button>
            <span className="faint">Typing a path, or ~, still works.</span>
          </span>
        </>
      )}
      {listed?.kind === "outside" && (
        <span className="small muted">{name} lists folders only in its home and where its sessions run. A typed path there still works.</span>
      )}
      {listed?.kind === "failed" && (
        <span className="folder-meant small">
          <span className="state-blocked">Couldn’t list the folders: {listed.why}</span>
          <button type="button" className="btn btn-sm" onClick={retry}>
            Try again
          </button>
        </span>
      )}
      {recent.length > 0 && (
        <div className="field">
          <span className="ov-label muted">Recent on {name}</span>
          <div className="chip-row">
            {recent.map((r) => (
              <button key={r.path} type="button" className="chip-btn mono" onClick={() => onChange(r.path)}>
                {shownPath(r.path)} · {r.when}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
