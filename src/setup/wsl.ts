import type { SetupEvent, SetupState, SetupStep, WslFound, WslProblem } from "../platform";

/** A WSL problem in the person's words. */
export const problemText = (p: WslProblem): string => {
  switch (p.kind) {
    case "not_installed":
      return "WSL isn’t on this computer yet";
    case "no_distro":
      return "WSL has no Linux installed yet";
    case "wsl1":
      return `${p.distro} runs on WSL 1, and Desk needs WSL 2`;
    case "arch":
      return `Desk doesn’t run on ${p.found} Linux`;
    case "old_linux":
      return `Too old for Desk: it needs a newer Linux, such as Ubuntu 22.04 or later`;
    case "root_user":
      return `Its only user is root, and Desk won’t run as root`;
  }
};

/** A distro as the chooser offers it. */
export interface DistroOption {
  name: string;
  note: string;
  tag: string;
  /** Desk can be set up there, after its `fix` when it has one. */
  usable: boolean;
  convert: boolean;
  /** What Desk does first, with the person's yes (the button says it):
   *  move it to WSL 2, or make a normal user there. */
  fix: "convert" | "user" | null;
}

/** The kernel's version as people say it: `6.6` of `6.6.36.6-microsoft-standard-WSL2`. */
const kernelOf = (kernel: string): string => kernel.split(/[.-]/).slice(0, 2).join(".");

export const optionFor = (f: WslFound): DistroOption => {
  const { name } = f.distro;
  if (f.problem?.kind === "wsl1")
    return {
      name,
      note: "WSL 1: Desk needs WSL 2. “Convert” takes a few minutes and keeps your files.",
      tag: "Convert to WSL 2",
      usable: true,
      convert: true,
      fix: "convert",
    };
  if (f.problem?.kind === "root_user")
    return {
      name,
      note: "Its only user is root, and Desk won’t run as root. “Create a user” makes you one and sets it as the default; your files stay.",
      tag: "Create a user",
      usable: true,
      convert: false,
      fix: "user",
    };
  if (f.problem) return { name, note: problemText(f.problem), tag: "Can’t use", usable: false, convert: false, fix: null };
  const parts = [
    "WSL 2",
    f.distro.default ? "your default" : f.distro.state.toLowerCase(),
    f.probe && `Linux ${kernelOf(f.probe.kernel)}`,
    f.probe && `you’re ${f.probe.user} here`,
  ].filter(Boolean);
  return { name, note: parts.join(" · "), tag: f.distro.default ? "Recommended" : "WSL 2", usable: true, convert: false, fix: null };
};

/** The one distro Desk can set up in without asking anything: the only
 *  usable one on WSL 2. Null when there is a choice to make, or none. */
export const onlyChoice = (found: WslFound[]): string | null => {
  const usable = found.map(optionFor).filter((o) => o.usable);
  return usable.length === 1 && !usable[0]!.fix ? usable[0]!.name : null;
};

/** Whether to offer "Install Ubuntu alongside": a Linux is there, but the
 *  only ones Desk can't use are too old for it, and none is usable. */
export const offerAlongside = (found: WslFound[]): boolean =>
  found.some((f) => f.problem?.kind === "old_linux") &&
  !found.map(optionFor).some((o) => o.usable) &&
  // Never for one Desk couldn't look into: what's wrong there is unknown.
  found.every((f) => f.problem !== null || f.probe !== null);

/** Why "Set up" can't be pressed yet, or null when it can. */
export const whyNotYet = (option: DistroOption | null, busy: boolean): string | null =>
  busy ? null : !option ? "Choose a Linux first." : !option.usable ? `Desk can’t run in ${option.name}: ${option.note}` : null;

/** How long "Setting up Desk in …" shows, with Cancel, before Desk sets
 *  up in the only Linux it can use. */
export const START_SOON_MS = 3_000;

/** How often Desk looks for WSL again while it isn't there. */
export const LOOK_AGAIN_MS = 10_000;

/** The distro picked first: the default when Desk can use it, else the
 *  first it can. */
export const firstPick = (found: WslFound[]): string | null => {
  const options = found.map(optionFor);
  const usable = options.filter((o) => o.usable && !o.fix);
  return (usable.find((o) => found.find((f) => f.distro.name === o.name)?.distro.default) ?? usable[0] ?? options.find((o) => o.usable))?.name ?? null;
};

export const STEPS: { step: SetupStep; label: (distro: string) => string; note: string }[] = [
  { step: "copy", label: (d) => `Copy Desk into ${d}`, note: "Desk’s helper, agents and memory, into your Linux home" },
  { step: "check", label: () => "Check it runs there", note: "" },
  { step: "start", label: () => "Start the database and memory", note: "The first time takes about a minute" },
  { step: "reach", label: () => "Reach it from Windows", note: "" },
  {
    step: "startup",
    label: () => "Start with Windows",
    note: "Desk Helper runs at sign-in, so agents and sessions keep going when this window is closed",
  },
];

export interface StepView {
  state: SetupState | "waiting";
  note: string | null;
}

/** Where each step stands after `events`, in the order they came. */
export const stepsAfter = (events: SetupEvent[]): Record<SetupStep, StepView> => {
  const views = Object.fromEntries(STEPS.map(({ step }) => [step, { state: "waiting", note: null }])) as Record<SetupStep, StepView>;
  for (const e of events) views[e.step] = { state: e.state, note: e.note ?? views[e.step].note };
  return views;
};
