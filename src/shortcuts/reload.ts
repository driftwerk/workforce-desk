import { deskState } from "../restore/boot";

/** Reloads this window (the main one, or a detached grid's, each only
 *  itself) after saving what's waiting to be written, so a draft typed a
 *  moment ago comes back. Sessions and terminals live on the hub. */
export const reloadDesk = async (): Promise<void> => {
  await deskState.flush().catch(() => undefined);
  window.location.reload();
};
