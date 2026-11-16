import { useEffect, useMemo, useState } from "react";
import { useChat } from "../chat/store";
import type { HubAccount } from "../chat/types";
import type { Connector } from "../hub/connections";
import {
  agentOf,
  dismiss,
  dismissed,
  dismissKey,
  currentCopier,
  offerLines,
  offerOf,
  placeOf,
  remoteConnections,
  sameRemote,
  sources,
  type Copied,
  type CopyNative,
  type OfferItem,
  type RemoteList,
} from "../hub/keyCopies";

/** An item's id in this card: its service, key and tier there. */
const idOf = (i: { connector: string; key: string; agent?: string | null }) =>
  `${i.connector}/${i.key}/${agentOf(i) ?? ""}`;

/** "Linear · driftwerk (through Allan)": the service, the name the person
 *  gave it, and the agent it's kept through there. */
const titleOf = (i: OfferItem) => {
  const named =
    i.name && i.name !== i.service ? `${i.service} · ${i.name}` : i.service;
  const through = i.agentName || agentOf(i);
  return through ? `${named} (through ${through})` : named;
};

/** What the hub says no copy is made of, in a line. */
const SIGN_IN_ONLY: Record<string, string> = {
  google: "Google: sign in from Desk; a hub’s Google sign-in can’t be copied.",
};

/** How one result reads. */
const said = (
  r: Copied,
  from: string,
): { text: string; tone: "ok" | "bad" } => {
  switch (r.kind) {
    case "saved":
      return {
        text: r.account ? `Saved · signed in as ${r.account}` : "Saved",
        tone: "ok",
      };
    case "missing":
      return {
        text: `${from} doesn’t hold it any more. Nothing was saved.`,
        tone: "bad",
      };
    case "failed":
      return {
        text: /nothing was saved/i.test(r.error)
          ? r.error
          : `${r.error.replace(/[.\s]+$/, "")}. Nothing was saved.`,
        tone: "bad",
      };
  }
};

/** Settings → Connections' offers: per paired hub, the person's own
 *  connections there to set up here, and keys there newer than their copy. */
export function CopyOffers({
  local,
  reload,
  hubs: given,
  copier: givenCopier,
  list = remoteConnections,
}: {
  local: Connector[];
  reload: () => Promise<void>;
  hubs?: HubAccount[];
  copier?: CopyNative;
  list?: typeof remoteConnections;
}) {
  const all = useChat((s) => s.hubs);
  const hubs = useMemo(() => sources(given ?? all), [given, all]);
  // Only the main window copies keys; a grid's offers nothing.
  const copier = givenCopier ?? currentCopier();
  if (!copier) return null;
  return (
    <>
      {hubs.map((h) => (
        <HubOffer
          key={h.id}
          hub={h}
          local={local}
          reload={reload}
          copier={copier}
          list={list}
        />
      ))}
    </>
  );
}

function HubOffer({
  hub,
  local,
  reload,
  copier,
  list,
}: {
  hub: HubAccount;
  local: Connector[];
  reload: () => Promise<void>;
  copier: CopyNative;
  list: typeof remoteConnections;
}) {
  const [items, setItems] = useState<OfferItem[] | null>(null);
  const [signInOnly, setSignInOnly] = useState<RemoteList["signInOnly"]>([]);
  const [hidden, setHidden] = useState<Set<string>>(() => dismissed());
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [running, setRunning] = useState<OfferItem[] | null>(null);
  const [results, setResults] = useState<Copied[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Read again whenever the connections here change: a copy just made is
  // offered no more.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [remote, records] = await Promise.all([
        list(hub),
        copier.kept(hub.id).catch(() => []),
      ]);
      if (!live) return;
      setItems(
        remote ? offerOf(hub.id, remote.connections, records, local) : [],
      );
      setSignInOnly(remote?.signInOnly ?? []);
    })();
    return () => {
      live = false;
    };
  }, [hub, local, copier, list]);

  const shown = (items ?? []).filter((i) => !hidden.has(dismissKey(hub.id, i)));
  const fresh = shown.filter((i) => i.state === "new");
  const newer = shown.filter(
    (i): i is Extract<OfferItem, { state: "newer" }> => i.state === "newer",
  );
  const ticked = picked ?? new Set(fresh.map(idOf));

  const notNow = (which: OfferItem[]) => {
    const keys = which.map((i) => dismissKey(hub.id, i));
    dismiss(keys);
    setHidden((h) => new Set([...h, ...keys]));
  };

  const run = async (which: OfferItem[]) => {
    if (which.length === 0) return;
    setRunning(which);
    setResults(null);
    setProblem(null);
    const taken = await copier.take(
      hub.id,
      which.map((i) => {
        const agent = agentOf(i);
        return {
          connector: i.connector,
          key: i.key,
          ...(agent ? { agent } : {}),
          ...(i.state === "newer" ? { into: i.into } : {}),
        };
      }),
    );
    if (taken.kind === "done") setResults(taken.results);
    else if (taken.kind === "unavailable")
      setProblem("Copying keys works in the Desk app, not in this preview.");
    else setProblem(taken.error);
    setPicked(null);
    await reload();
  };

  if (running) {
    const of = (i: OfferItem) => results?.find((r) => sameRemote(r, i));
    return (
      <section
        className="copy-offer"
        aria-label={`Setting up from ${hub.label}`}
      >
        <h2>
          {results || problem
            ? `From ${hub.label}`
            : `Setting up ${running.length === 1 ? "1 connection" : `${running.length} connections`} from ${hub.label}`}
        </h2>
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
        <ul className="copy-picks" aria-label="Results">
          {running.map((i) => {
            const r = of(i);
            const line = r
              ? said(r, hub.label)
              : problem
                ? { text: "Nothing was saved.", tone: "bad" as const }
                : null;
            return (
              <li key={idOf(i)} className="copy-pick">
                <span className="copy-pick-text">
                  <b>{titleOf(i)}</b>
                  {line ? (
                    <span
                      className={`copy-res copy-res-${line.tone}`}
                      role="status"
                    >
                      {line.text}
                    </span>
                  ) : (
                    <span className="copy-res copy-res-wait">Checking…</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {(results || problem) && (
          <div className="copy-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setRunning(null);
                setResults(null);
                setProblem(null);
              }}
            >
              Done
            </button>
          </div>
        )}
      </section>
    );
  }

  if (shown.length === 0) return null;

  // A sign-in there that can't come here: said once, unless it's here.
  const signIns = signInOnly.flatMap((s) =>
    SIGN_IN_ONLY[s.connector] &&
    !local.some((c) => c.id === s.connector && c.connections.length > 0)
      ? [SIGN_IN_ONLY[s.connector]]
      : [],
  );

  return (
    <>
      {fresh.length > 0 && (
        <section
          className="copy-offer"
          aria-label={`Your connections on ${hub.label}`}
        >
          <h2>{`${hub.label} has ${fresh.length === 1 ? "1 of your connections" : `${fresh.length} of your connections`}`}</h2>
          <ul className="copy-froms" aria-label="Where they are">
            {offerLines(hub.label, fresh).map((l) => (
              <li key={l.from} className="copy-from">
                <b>{`${l.from}:`}</b> {l.services.join(" · ")}
              </li>
            ))}
            {signIns.map((line) => (
              <li key={line} className="copy-from copy-from-sign-in">
                {line}
              </li>
            ))}
          </ul>
          <p className="copy-lead small">
            Your own keys there. Set them up here for all your agents on this
            computer. Each one is checked first.
          </p>
          <ul className="copy-picks" aria-label="Connections to set up">
            {fresh.map((i) => {
              const where = placeOf(i);
              const through = i.agentName || agentOf(i);
              return (
                <li key={idOf(i)} className="copy-pick">
                  <label className="copy-pick-label">
                    <input
                      type="checkbox"
                      checked={ticked.has(idOf(i))}
                      onChange={(e) => {
                        const next = new Set(ticked);
                        if (e.target.checked) next.add(idOf(i));
                        else next.delete(idOf(i));
                        setPicked(next);
                      }}
                    />
                    <span className="copy-pick-text">
                      <b>{i.service}</b>
                      {where && <span className="copy-site">{where}</span>}
                      {through && (
                        <span className="copy-through">{`through ${through}`}</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="copy-actions">
            <button
              type="button"
              className="btn btn-signal"
              disabled={ticked.size === 0}
              onClick={() => void run(fresh.filter((i) => ticked.has(idOf(i))))}
            >
              {ticked.size === fresh.length
                ? fresh.length === 1
                  ? "Set it up here"
                  : "Set them up here"
                : `Set up ${ticked.size} here`}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => notNow(fresh)}
            >
              Not now
            </button>
            <span className="copy-note">{`Copied straight into Desk’s vault, never shown. ${hub.label} keeps its own.`}</span>
          </div>
        </section>
      )}
      {newer.map((i) => (
        <div
          key={idOf(i)}
          className="copy-newer"
          role="group"
          aria-label={`A newer ${i.service} key on ${hub.label}`}
        >
          <span className="copy-newer-dot" aria-hidden="true" />
          <span className="copy-newer-text">
            <b>{`${hub.label} has a newer ${i.service} key${agentOf(i) ? ` (through ${i.agentName || agentOf(i)})` : ""}`}</b>
            <span className="small muted">{` · for ${i.localName} here`}</span>
          </span>
          <span className="copy-newer-actions">
            <button
              type="button"
              className="btn btn-sm btn-signal"
              onClick={() => void run([i])}
            >
              Use it
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => notNow([i])}
            >
              Not now
            </button>
          </span>
        </div>
      ))}
    </>
  );
}
