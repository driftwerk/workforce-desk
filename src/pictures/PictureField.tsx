import { useId, useRef, useState, type ReactNode } from "react";
import { ago } from "../crew/files";
import { Mark } from "../ui/Mark";
import { MAX_INPUT_BYTES, pictureType } from "./crop";
import { CropDialog } from "./CropDialog";
import { pictureRefusal } from "./everywhere";
import type { Picture } from "./pictures";

/** Where the picture shown came from, as Settings says it. */
export const pictureNote = (picture: Picture | null | undefined, now?: Date): string =>
  !picture
    ? "No picture"
    : picture.source === "slack"
      ? `From Slack${picture.slack ? ` (${picture.slack})` : ""}`
      : `Chosen ${ago(picture.at, now)}`;

/** Whether a file is a picture Desk takes; why not, when it isn't. */
export const refusalOf = async (file: File): Promise<string | null> => {
  if (file.size > MAX_INPUT_BYTES) return "That picture is too big. Choose one under 25 MB.";
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return pictureType(head) ? null : "Choose a PNG, JPEG or WebP picture.";
};

/** Someone's picture and where it came from, with choosing one (framed
 *  square), going back to their Slack picture, or removing the chosen one,
 *  where they can be changed. */
export function PictureField({
  name,
  person = false,
  picture,
  src,
  onSet,
  children,
}: {
  name: string;
  person?: boolean;
  picture: Picture | null | undefined;
  src: string | null;
  /** Chooses `image` (null: stops choosing one); none where it can't be changed. */
  onSet?: (image: Blob | null) => Promise<void>;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = useId();
  const chosen = picture?.source === "chosen";

  const unchoose = async () => {
    if (!onSet) return;
    setBusy(true);
    setProblem(null);
    try {
      await onSet(null);
    } catch (e) {
      setProblem(pictureRefusal(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="picture-field">
      <span className="picture-face">
        <Mark name={name} size="xl" src={src} person={person} />
        <span id={noteId} className="small faint">
          {pictureNote(picture)}
        </span>
      </span>
      <span className="picture-side">
        {onSet && (
          <>
            <span className="picture-actions" role="group" aria-describedby={noteId}>
              <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
                Choose a picture…
              </button>
              {chosen && picture?.slack != null && (
                <button type="button" className="btn" disabled={busy} onClick={() => void unchoose()}>
                  Use the Slack picture
                </button>
              )}
              {chosen && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void unchoose()}>
                  Remove
                </button>
              )}
            </span>
            <input
              ref={input}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp"
              onChange={async (e) => {
                const picked = e.target.files?.[0];
                e.target.value = "";
                if (!picked) return;
                const refused = await refusalOf(picked);
                setProblem(refused);
                if (!refused) setFile(picked);
              }}
            />
            <span className="small faint">PNG, JPEG or WebP. Desk crops it square; drag in the crop to frame it.</span>
          </>
        )}
        {children}
        {problem && <span className="small state-blocked">{problem}</span>}
      </span>
      {file && onSet && (
        <CropDialog
          file={file}
          who={name}
          person={person}
          onUse={async (image) => {
            setProblem(null);
            await onSet(image);
          }}
          onClose={() => setFile(null)}
        />
      )}
    </div>
  );
}
