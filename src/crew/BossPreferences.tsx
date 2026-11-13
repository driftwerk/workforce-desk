import { useCallback, useEffect, useId, useRef, useState } from "react";
import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import type { Preference, PreferencePatch, PreferenceScope } from "../hub/types";
import { useLayout } from "../groups/store";
import { plainError } from "../ui/plainError";

// The person's preferences for one boss, as its settings list them: each
// rule in words, where it holds and how often it was used, with Edit, Pause
// or Resume, and Forget. The boss makes them from an "Always" or when told
// "from now on…"; here they're read and changed, not made.

/** The boss scope the hub keeps a boss's preferences under: "main" for the
 *  main overseer, else the group it is the boss of. */
export const bossScopeOf = (group: string | null | undefined): string => group || "main";

/** Where it holds, as you read it. */
export function scopeSaid(scope: PreferenceScope, groupName: (id: string) => string | null): string {
  if (scope === "all") return "Every session";
  if (scope.startsWith("group:")) {
    const id = scope.slice("group:".length);
    return `Sessions in ${groupName(id) ?? "a group that’s gone"}`;
  }
  return `Sessions in ${scope.slice("repo:".length)}`;
}

/** How often it was used and undone, and whether it's paused. */
export function usedSaid(p: Preference): string {
  const used = p.appliedCount === 0 ? "Not used yet" : p.appliedCount === 1 ? "Used once" : `Used ${p.appliedCount} times`;
  const twice = p.overruledCount >= 2;
  const undone = p.overruledCount === 0 ? "" : p.overruledCount === 1 ? "you undid it once" : `you undid it ${p.overruledCount} times`;
  const paused = p.state !== "paused" ? "" : twice ? `paused after ${undone}` : "paused";
  return [used, paused || undone].filter(Boolean).join(" · ");
}

/** What changed between a preference and what's typed: nothing sent when
 *  nothing did (the hub says "Say what changes."). */
export function patchOf(p: Preference, when: string, then: string, scope: PreferenceScope): PreferencePatch | null {
  const patch: PreferencePatch = {};
  if (when.trim() !== p.whenText) patch.whenText = when.trim();
  if (then.trim() !== p.thenText) patch.thenText = then.trim();
  if (scope !== p.scope) patch.scope = scope;
  return Object.keys(patch).length ? patch : null;
}

type Loaded = { state: "loading" } | { state: "none" } | { state: "failed"; problem: string } | { state: "ok"; list: Preference[] };

/** The preferences part of a boss's settings. Nothing on a hub without them. */
export function BossPreferences({ name, group }: { name: string; group: string | null }) {
  const hub = useDesk((s) => s.hub);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const scope = bossScopeOf(group);
  const asking = useRef(0);

  // Read again when the hub changes and when you come back to Desk: the
  // boss makes them and pauses them while you're elsewhere.
  const load = useCallback(() => {
    if (!hub) return;
    // A hub client without them (a test's) has none to show.
    if (typeof hub.preferences !== "function") return setLoaded({ state: "none" });
    const n = ++asking.current;
    hub.preferences().then(
      (list) => n === asking.current && setLoaded({ state: "ok", list }),
      (e) => {
        if (n !== asking.current) return;
        // An older hub keeps none.
        if (e instanceof HubError && e.status === 404) setLoaded({ state: "none" });
        else setLoaded((was) => (was.state === "ok" ? was : { state: "failed", problem: plainError(e) }));
      },
    );
  }, [hub]);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("focus", load);
      asking.current++;
    };
  }, [load]);

  if (loaded.state === "none" || loaded.state === "loading") return null;
  const mine = loaded.state === "ok" ? loaded.list.filter((p) => p.bossScope === scope && p.state !== "retired") : [];
  const replace = (next: Preference) =>
    setLoaded((l) => (l.state === "ok" ? { state: "ok", list: l.list.map((p) => (p.id === next.id ? next : p)) } : l));
  const remove = (id: string) =>
    setLoaded((l) => (l.state === "ok" ? { state: "ok", list: l.list.filter((p) => p.id !== id) } : l));

  return (
    <div className="oversee-part">
      <h3>Your preferences</h3>
      <span className="oversee-sub">
        What {name} does in place of asking you. Answer “Always” to one of its questions, or tell it “from now on…”, and it keeps
        the rule here.
      </span>
      {loaded.state === "failed" ? (
        <p className="small state-blocked" role="alert">
          {loaded.problem}{" "}
          <button type="button" className="link" onClick={load}>
            Try again
          </button>
        </p>
      ) : mine.length === 0 ? (
        <p className="oversee-sub">None yet.</p>
      ) : (
        <ul className="oversee-card oversee-prefs" aria-label="Your preferences">
          {mine.map((p) => (
            <Row key={p.id} p={p} onChanged={replace} onGone={remove} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ p, onChanged, onGone }: { p: Preference; onChanged: (p: Preference) => void; onGone: (id: string) => void }) {
  const groups = useLayout().groups;
  const connected = useDesk((s) => !!s.hub);
  const [mode, setMode] = useState<"show" | "edit" | "forget">("show");
  const editButton = useRef<HTMLButtonElement>(null);
  const was = useRef(mode);
  // Back from editing or forgetting, focus returns to the row's Edit.
  useEffect(() => {
    if (mode === "show" && was.current !== "show") editButton.current?.focus();
    was.current = mode;
  }, [mode]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = useId();
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? null;
  const paused = p.state === "paused";

  const run = async (call: () => Promise<Preference>, after?: () => void) => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await call();
      if (next.state === "retired") onGone(next.id);
      else onChanged(next);
      after?.();
    } catch (e) {
      // Forgotten elsewhere, or gone.
      if (e instanceof HubError && e.status === 404) onGone(p.id);
      else setProblem(plainError(e));
    } finally {
      setBusy(false);
    }
  };
  const hub = () => useDesk.getState().hub!;

  return (
    <li className={`oversee-row oversee-pref${paused ? " is-paused" : ""}`}>
      {mode === "edit" ? (
        <Edit
          p={p}
          groups={groups}
          busy={busy}
          problem={problem}
          onCancel={() => {
            setProblem(null);
            setMode("show");
          }}
          onSave={(patch) => void run(() => hub().changePreference(p.id, patch), () => setMode("show"))}
        />
      ) : (
        <>
          <span className="oversee-check-text">
            <b>When {p.whenText}</b>
            <span>{sentence(p.thenText)}</span>
            <span className="oversee-sub">
              {scopeSaid(p.scope, groupName)} · {usedSaid(p)}
            </span>
            {problem && (
              <span className="small state-blocked" role="alert">
                {problem}
              </span>
            )}
          </span>
          <span className="oversee-pref-tools">
            {mode === "forget" ? (
              <>
                <span className="oversee-sub" id={`${ids}-forget`}>
                  Forget it?
                </span>
                <button
                  type="button"
                  className="link"
                  aria-describedby={`${ids}-forget`}
                  disabled={busy || !connected}
                  onClick={() => void run(() => hub().setPreference(p.id, "retire"))}
                >
                  Forget
                </button>
                <button type="button" className="link" autoFocus disabled={busy} onClick={() => setMode("show")}>
                  Keep
                </button>
              </>
            ) : (
              <>
                <button
                  ref={editButton}
                  type="button"
                  className="link"
                  aria-label={`Edit: when ${p.whenText}`}
                  disabled={busy || !connected}
                  onClick={() => setMode("edit")}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="link"
                  aria-label={`${paused ? "Resume" : "Pause"}: when ${p.whenText}`}
                  disabled={busy || !connected}
                  onClick={() => void run(() => hub().setPreference(p.id, paused ? "resume" : "pause"))}
                >
                  {paused ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  className="link"
                  aria-label={`Forget: when ${p.whenText}`}
                  disabled={busy || !connected}
                  onClick={() => setMode("forget")}
                >
                  Forget
                </button>
              </>
            )}
          </span>
        </>
      )}
    </li>
  );
}

/** Capitalised and closed with a period, as a line of its own. */
const sentence = (t: string): string => {
  const s = t.trim();
  if (!s) return s;
  const up = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
};

function Edit({
  p,
  groups,
  busy,
  problem,
  onCancel,
  onSave,
}: {
  p: Preference;
  groups: readonly { id: string; name: string }[];
  busy: boolean;
  problem: string | null;
  onCancel: () => void;
  onSave: (patch: PreferencePatch) => void;
}) {
  const ids = useId();
  const [when, setWhen] = useState(p.whenText);
  const [then, setThen] = useState(p.thenText);
  const [where, setWhere] = useState<string>(p.scope.startsWith("repo:") ? "repo" : p.scope);
  const [repo, setRepo] = useState(p.scope.startsWith("repo:") ? p.scope.slice("repo:".length) : "");
  const scope: PreferenceScope = where === "repo" ? `repo:${repo.trim()}` : (where as PreferenceScope);
  const blank = !when.trim() || !then.trim() || (where === "repo" && !repo.trim());
  const patch = blank ? null : patchOf(p, when, then, scope);
  // A group it named that's gone stays pickable as it was.
  const named = p.scope.startsWith("group:") && !groups.some((g) => `group:${g.id}` === p.scope);
  const save = () => {
    if (patch) onSave(patch);
    else if (!blank) onCancel();
  };
  return (
    <form
      className="oversee-pref-edit"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="field">
        <span className="oversee-sub">When</span>
        <input autoFocus value={when} onChange={(e) => setWhen(e.target.value)} aria-describedby={problem ? `${ids}-p` : undefined} />
      </label>
      <label className="field">
        <span className="oversee-sub">Then</span>
        <input value={then} onChange={(e) => setThen(e.target.value)} />
      </label>
      <div className="oversee-pref-where">
        <label className="field">
          <span className="oversee-sub">For</span>
          <select className="ability-select" value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value="all">Every session</option>
            {groups.map((g) => (
              <option key={g.id} value={`group:${g.id}`}>
                Sessions in {g.name}
              </option>
            ))}
            {named && <option value={p.scope}>Sessions in a group that’s gone</option>}
            <option value="repo">Sessions in a repository…</option>
          </select>
        </label>
        {where === "repo" && (
          <label className="field">
            <span className="oversee-sub">Repository</span>
            <input className="mono" placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} />
          </label>
        )}
      </div>
      {problem && (
        <span id={`${ids}-p`} className="small state-blocked" role="alert">
          {problem}
        </span>
      )}
      {blank && (
        <span id={`${ids}-blank`} className="oversee-sub">
          Say the case, what to do then{where === "repo" ? ", and the repository" : ""}.
        </span>
      )}
      <span className="oversee-pref-tools">
        <button type="submit" className="btn btn-sm btn-signal" disabled={busy || blank} aria-describedby={blank ? `${ids}-blank` : undefined}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}
