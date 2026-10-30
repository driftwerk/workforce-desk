import type { Attachment, HubAccount } from "../chat/types";
import { uploadFile } from "../platform";
import { formatSize } from "./kinds";

/** The largest file Desk sends, which it reads whole to send: a hub's own
 *  default (`[desk] attachment_max_mb`). A hub that takes less says so
 *  when it refuses. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** The most files one message carries (the hub's `MAX_PER_MESSAGE`). */
export const MAX_FILES = 20;

/** Why `file` can't be sent, before trying, if it can't. */
export const tooBig = (file: Pick<File, "name" | "size">): string | null =>
  file.size > MAX_FILE_BYTES
    ? `${file.name} is ${formatSize(file.size)}; a file can be up to ${formatSize(MAX_FILE_BYTES)}.`
    : file.size === 0
      ? `${file.name} is empty.`
      : null;

/** What went wrong sending `name`, in plain words. */
export const uploadError = (name: string, e: unknown): Error => {
  const said = e instanceof Error ? e.message : String(e);
  if (/at most \d+ MB/i.test(said)) return new Error(`${name} is too big to send: ${said.replace(/^a file may be/i, "a file can be")}.`);
  if (/empty/i.test(said)) return new Error(`${name} is empty.`);
  if (e instanceof TypeError || /reach/i.test(said)) return new Error(`Couldn’t send ${name}: its workspace can’t be reached right now.`);
  return new Error(`Couldn’t send ${name}: ${said}`);
};

/** Uploads `files` to agent `agent`'s conversation on `channel` of `hub`,
 *  in order; the first that fails stops it, saying which. */
export const uploadAll = async (hub: HubAccount, agent: string, channel: string, files: readonly File[]): Promise<Attachment[]> => {
  const sent: Attachment[] = [];
  for (const file of files) {
    const why = tooBig(file);
    if (why) throw new Error(why);
    try {
      sent.push(await uploadFile(hub, agent, channel, file));
    } catch (e) {
      throw uploadError(file.name, e);
    }
  }
  return sent;
};
