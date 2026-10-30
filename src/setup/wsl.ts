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
      return `Desk needs Ubuntu 22.04 or newer, or Debian 12 (this one has glibc ${p.glibc})`;
    case "root_user":
      return `Set a normal default user for ${p.distro}; Desk won’t run as root`;
  }
};

/** A distro as the chooser offers it. */
export interface DistroOption {
  name: string;
  note: string;
  tag: string;
  /** Desk can be set up there, after `convert` when it's on WSL 1. */
  usable: boolean;
  convert: boolean;
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
    };
  if (f.problem) return { name, note: problemText(f.problem), tag: "Can’t use", usable: false, convert: false };
  const parts = [
    "WSL 2",
    f.distro.default ? "your default" : f.distro.state.toLowerCase(),
    f.probe && `Linux ${kernelOf(f.probe.kernel)}`,
    f.probe && `you’re ${f.probe.user} here`,
  ].filter(Boolean);
  return { name, note: parts.join(" · "), tag: f.distro.default ? "Recommended" : "WSL 2", usable: true, convert: false };
};

/** The distro picked first: the default when Desk can use it, else the
 *  first it can. */
export const firstPick = (found: WslFound[]): string | null => {
  const options = found.map(optionFor);
  const usable = options.filter((o) => o.usable && !o.convert);
  return (usable.find((o) => found.find((f) => f.distro.name === o.name)?.distro.default) ?? usable[0] ?? options.find((o) => o.usable))?.name ?? null;
};

export const STEPS: { step: SetupStep; label: (distro: string) => string; note: string }[] = [
  { step: "copy", label: (d) => `Copy Desk into ${d}`, note: "desk-helper, the agents and memory, into ~/.local/share/Desk/bin" },
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
