import { useEffect, useState } from "react";
import { agentKey, type Agent } from "../chat/types";
import { HubError, type DeskHub, type Revision } from "../hub/client";
import { useDesk } from "../hub/store";
import { useSettings } from "../settings/store";
import { matches, shortcutLabel } from "../shortcuts/keys";
import { CloseButton, Dialog } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { withKeptChanges } from "../restore/drafts";
import { useUi } from "../shell/ui";
import {
  AGENT_FILES,
  ago,
  dirtyFiles,
  discarded,
  draftOf,
  draftStatus,
  edited,
  isDirty,
  opened,
  restored,
  saved,
  useDrafts,
} from "./files";

/** When the file's newest version was saved, if the hub keeps versions. */
const savedAt = (hub: DeskHub, id: string, file: string): Promise<string | null> =>
  hub.identityRevisions(id, file).then(
    (r) => r[0]?.created_at ?? null,
    () => null,
  );

/** Saves one file's draft; what's typed meanwhile stays a draft. */
export async function saveDraft(hub: DeskHub, agent: Agent, file: string): Promise<void> {
  const key = agentKey(agent);
  const d = draftOf(useDrafts.getState().drafts, key, file);
  if (!d || !isDirty(d)) return;
  const text = d.text;
  try {
    await hub.saveIdentityFile(agent.id, file, text);
  } catch (e) {
    throw new Error(plainError(e));
  }
  const now = draftOf(useDrafts.getState().drafts, key, file) ?? d;
  useDrafts.getState().put(key, file, saved(now, text, new Date().toISOString()));
}

/** Discards every unsaved change to an agent's files. */
export const discardDrafts = (agent: Agent): void => {
  const key = agentKey(agent);
  const { drafts, put } = useDrafts.getState();
  for (const file of dirtyFiles(drafts, key)) put(key, file, discarded(draftOf(drafts, key, file)!));
};

/** The agent's Files tab: the files that shape them, edited in place, with
 *  every saved version kept. */
export function AgentFiles({ agent }: { agent: Agent }) {
  const hub = useDesk((s) => s.hub);
  const key = agentKey(agent);
  const drafts = useDrafts((s) => s.drafts);
  const put = useDrafts((s) => s.put);
  // The file open, per agent (and across launches).
  const chosen = useUi((u) => u.agentFiles[key]);
  const file = AGENT_FILES.some((f) => f.name === chosen) ? chosen! : AGENT_FILES[0].name;
  const setAgentFile = useUi((u) => u.setAgentFile);
  const setFile = (f: string) => setAgentFile(key, f);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveKeys = useSettings((s) => s.keys.saveFile);
  const [history, setHistory] = useState(false);
  const draft = draftOf(drafts, key, file);
  const dirty = isDirty(draft);
  const status = draftStatus(draft);

  useEffect(() => {
    if (!hub) return;
    for (const f of AGENT_FILES) {
      if (draftOf(useDrafts.getState().drafts, key, f.name)) continue;
      Promise.all([hub.identityFile(agent.id, f.name), savedAt(hub, agent.id, f.name)]).then(
        ([text, at]) => {
          // Changes kept from before (a crash, a quit) go back over it.
          if (!draftOf(useDrafts.getState().drafts, key, f.name)) put(key, f.name, withKeptChanges(opened(text, at), key, f.name));
        },
        (e: unknown) => setProblem(`Desk couldn’t open ${f.name}. ${plainError(e)}`),
      );
    }
  }, [hub, agent.id, key, put]);

  const save = async () => {
    if (!hub || !dirty || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await saveDraft(hub, agent, file);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="files"
      onKeyDown={(e) => {
        if (matches(e, saveKeys)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <nav className="files-nav" aria-label="Files">
        {AGENT_FILES.map((f) => {
          const d = draftOf(drafts, key, f.name);
          return (
            <button
              key={f.name}
              type="button"
              className="file-row"
              aria-current={f.name === file ? "true" : undefined}
              onClick={() => setFile(f.name)}
            >
              <span className="file-name">
                {f.name}
                {isDirty(d) && <span className="unsaved-dot" role="img" aria-label="Unsaved changes" />}
              </span>
              <span>{f.about}</span>
            </button>
          );
        })}
        <p className="files-note">Every save is kept. Open History to see or restore an earlier version.</p>
      </nav>
      <section className="files-editor" aria-label={file}>
        <div className="files-bar">
          <span className="files-bar-title">
            <b>{file}</b>
            <span className={`file-status file-status-${status.tone === "quiet" ? "" : status.tone}`} role="status">
              {saving ? "Saving…" : status.text}
            </span>
            {problem && <span className="small state-blocked">{problem}</span>}
          </span>
          <button type="button" className="btn btn-ghost" disabled={!draft} onClick={() => setHistory(true)}>
            History
          </button>
          <button type="button" className="btn" disabled={!dirty} onClick={() => draft && put(key, file, discarded(draft))}>
            Discard
          </button>
          <button type="button" className="btn btn-signal" disabled={!dirty || saving} onClick={() => void save()}>
            Save
          </button>
        </div>
        <textarea
          className="files-text"
          aria-label={file}
          spellCheck={false}
          value={draft?.text ?? ""}
          disabled={!draft}
          placeholder={draft ? `${file} is empty.` : "Opening…"}
          onChange={(e) => draft && put(key, file, edited(draft, e.target.value))}
        />
        <div className="files-foot">
          <span>Markdown · takes effect from {agent.name}’s next message</span>
          <span>
            <kbd>{shortcutLabel(saveKeys)}</kbd> to save
          </span>
        </div>
      </section>
      {history && hub && (
        <HistoryDialog
          hub={hub}
          agent={agent}
          file={file}
          dirty={dirty}
          onRestored={(text, at) => put(key, file, restored(text, at))}
          onClose={() => setHistory(false)}
        />
      )}
    </div>
  );
}

const how = (r: Revision, name: string): string => {
  switch (r.edited_via) {
    case "web":
      return "Saved in Desk";
    case "restore":
      return r.restored_from ? `Restored version ${r.restored_from}` : "Restored an earlier version";
    case "agent_tool":
      return `${name} changed it`;
    case "seed":
      return "First version";
    case "slack":
      return "Changed from Slack";
    case "cli":
      return "Changed from the command line";
    default:
      return "Changed outside Desk";
  }
};

function HistoryDialog({
  hub,
  agent,
  file,
  dirty,
  onRestored,
  onClose,
}: {
  hub: DeskHub;
  agent: Agent;
  file: string;
  dirty: boolean;
  onRestored: (text: string, at: string) => void;
  onClose: () => void;
}) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [content, setContent] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    hub.identityRevisions(agent.id, file).then(
      (r) => {
        setRevisions(r);
        setSelected(r[0]?.rev ?? null);
      },
      (e: unknown) =>
        setProblem(
          e instanceof HubError && e.status === 503
            ? "Earlier versions aren’t kept on this Mac yet, so there’s nothing to go back to."
            : `Desk couldn’t load the history. ${plainError(e)}`,
        ),
    );
  }, [hub, agent.id, file]);

  useEffect(() => {
    if (selected === null || content[selected] !== undefined) return;
    hub.identityRevision(agent.id, file, selected).then(
      (r) => setContent((c) => ({ ...c, [selected]: r.content ?? "" })),
      (e: unknown) => setProblem(plainError(e)),
    );
  }, [hub, agent.id, file, selected, content]);

  const newest = revisions?.[0]?.rev;
  const restore = async () => {
    if (selected === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await hub.restoreIdentityRevision(agent.id, file, selected);
      const [text, list] = await Promise.all([hub.identityFile(agent.id, file), hub.identityRevisions(agent.id, file)]);
      onRestored(text, list[0]?.created_at ?? new Date().toISOString());
      onClose();
    } catch (e) {
      setProblem(plainError(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      wide
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head dialog-head-rule">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {file} history
            </h1>
            <p>Every saved version of {agent.name}’s file, newest first. Restoring one keeps the rest.</p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-body">
        {revisions && revisions.length > 0 ? (
          <>
            <nav className="history-list" aria-label="Versions">
              {revisions.map((r) => (
                <button
                  key={r.rev}
                  type="button"
                  className="provider-row"
                  aria-current={r.rev === selected ? "true" : undefined}
                  data-autofocus={r.rev === selected ? true : undefined}
                  onClick={() => setSelected(r.rev)}
                >
                  <span className="provider-text">
                    <b>{r.rev === newest ? "Current version" : `Version ${r.rev}`}</b>
                    <span>
                      {how(r, agent.name)} · {ago(r.created_at)}
                    </span>
                  </span>
                </button>
              ))}
            </nav>
            <div className="history-preview">
              <pre aria-label="This version">{selected !== null ? (content[selected] ?? "Opening…") : ""}</pre>
            </div>
          </>
        ) : (
          <div className="brain-pane">
            <p className="pane-empty">{problem ?? (revisions ? `No saved versions of ${file} yet.` : "Opening the history…")}</p>
          </div>
        )}
      </div>
      <footer className="dialog-foot">
        <span className={`dialog-foot-note ${problem || dirty ? "state-blocked" : ""}`}>
          {revisions && revisions.length > 0 && (problem ?? (dirty ? "Restoring replaces your unsaved changes." : ""))}
        </span>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="btn btn-signal"
          disabled={busy || selected === null || selected === newest || !revisions?.length}
          onClick={() => void restore()}
        >
          {busy ? "Restoring…" : selected === newest ? "This is the current version" : "Restore this version"}
        </button>
      </footer>
    </Dialog>
  );
}
