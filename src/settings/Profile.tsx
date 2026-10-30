import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import type { HubAccount, Me } from "../chat/types";
import { sendPicture } from "../hub/client";
import { pictureRefusal, spreadPicture, spreadSaid } from "../pictures/everywhere";
import { PictureField } from "../pictures/PictureField";
import { refOf } from "../pictures/who";
import { imageBlob, MY_PICTURE, useImage } from "../pictures/pictures";
import { Mark } from "../ui/Mark";

/** Your picture on each workspace you're connected to, as that workspace
 *  shows you (in Slack and its web app too, and in its places in Desk). */
export function Profile() {
  const hubs = useChat((s) => s.hubs);
  const me = useChat((s) => s.me);
  useEffect(() => {
    for (const hub of hubs) void useChat.getState().refreshMe(hub.id);
  }, [hubs]);
  return (
    <main className="settings-main">
      <div className="settings-head">
        <h1 className="display-xl">Profile</h1>
        <span className="muted">
          Each workspace keeps your picture on your account there: its Slack and web app show it too. Without one chosen, it’s your Slack picture there, if
          you have one.
        </span>
      </div>
      <section className="profile-hubs" aria-label="Your picture on each workspace">
        {hubs.map((hub) => (
          <HubPicture key={hub.id} hub={hub} me={me[hub.id]} others={hubs.filter((h) => h.id !== hub.id && me[h.id])} />
        ))}
      </section>
    </main>
  );
}

function HubPicture({ hub, me, others }: { hub: HubAccount; me: Me | undefined; others: HubAccount[] }) {
  const setPicture = useChat((s) => s.setPicture);
  const src = useImage(refOf(hub, MY_PICTURE, me?.picture?.version));
  const [said, setSaid] = useState<string | null>(null);
  const [spreading, setSpreading] = useState(false);

  const everywhere = async () => {
    setSpreading(true);
    setSaid(null);
    try {
      const image = await imageBlob({ conn: hub, path: MY_PICTURE });
      if (!image) throw new Error(`Desk couldn’t read your picture on ${hub.label}.`);
      const spread = await spreadPicture(image, others, (to, blob) => sendPicture(to, MY_PICTURE, blob));
      for (const { hub: to, picture } of spread.done) setPicture({ me: to.id }, picture);
      setSaid(spreadSaid(spread));
    } catch (e) {
      setSaid(pictureRefusal(e));
    } finally {
      setSpreading(false);
    }
  };

  return (
    <article className="profile-hub" aria-label={hub.label}>
      <span className="profile-hub-head">
        <b className="display">{hub.label}</b>
        {me?.name && <span className="faint small">{me.name}</span>}
      </span>
      {me ? (
        <PictureField
          name={me.name ?? "You"}
          person
          picture={me.picture}
          src={src}
          onSet={async (image) => {
            setSaid(null);
            setPicture({ me: hub.id }, await sendPicture(hub, MY_PICTURE, image));
          }}
        >
          {me.picture && others.length > 0 && (
            <span className="picture-actions">
              <button type="button" className="btn btn-ghost" disabled={spreading} onClick={() => void everywhere()}>
                {spreading ? "Setting it everywhere…" : "Use this picture everywhere"}
              </button>
            </span>
          )}
          {said && <span className="small muted">{said}</span>}
        </PictureField>
      ) : (
        <span className="picture-field">
          <Mark name="You" size="xl" person />
          <span className="small faint">Connect to {hub.label} as yourself (Settings → Workspaces) to have a picture there.</span>
        </span>
      )}
    </article>
  );
}
