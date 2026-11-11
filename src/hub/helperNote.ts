import { openLoginItems, startHelper, type HelperStatus } from "../platform";
import { type Problem } from "../ui/problem";
import { useDesk } from "./store";

/** What a helper that did not start says, in the person's words, and the
 *  button that helps (if any). */
export const refusal = (s: HelperStatus): { text: string; login?: true } | null => {
  switch (s.state) {
    case "running":
    case "starting":
      return null;
    case "development":
      return { text: "This is a development run: start Desk’s helper by hand, as you did before." };
    case "needs-approval":
      return { text: "Desk Helper is turned off in your login items.", login: true };
    case "move-to-applications":
      return { text: "Move Desk to your Applications folder, then open it from there." };
    case "failed":
      return { text: `Desk Helper couldn’t start: ${s.message}` };
    default:
      return { text: "Desk Helper couldn’t be started from here. Settings → Help says why." };
  }
};

/** What follows "Start it" in a toast: nothing when the helper is on its way;
 *  else the next step, kept up as the new problem (with Open login items where
 *  that's the step). */
export const afterStart = (status: HelperStatus): Problem | null => {
  const no = refusal(status);
  if (!no) return null;
  if (status.state === "failed") return { plain: "Desk’s helper couldn’t start.", details: status.message, what: "starting Desk’s helper" };
  return { plain: no.text, what: "starting Desk’s helper", ...(no.login ? { fix: { label: "Open login items", run: () => void openLoginItems().catch(() => undefined) } } : {}) };
};

/** "Start it" for a problem's toast: starts the helper as the banner does, and
 *  says the next step when the system won't (login item off, not in
 *  Applications, a development run) instead of going quiet. */
export const startLocalHelper = (): void => {
  void startHelper().then(
    (status) => {
      const next = afterStart(status);
      if (next) useDesk.setState({ error: next });
    },
    (e: unknown) => useDesk.getState().fail(e, { what: "starting Desk’s helper" }),
  );
};
