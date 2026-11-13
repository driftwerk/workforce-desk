import { useId, type ReactNode } from "react";

/** A setting that is on or off and takes effect at once: its name, a line
 *  on what it does, and the switch at the row's end (as Memory and an
 *  agent's abilities draw it). `children` go between the words and the
 *  switch, for an action of the row's own. */
export function SwitchRow({
  label,
  sub,
  on,
  disabled,
  saving,
  onChange,
  children,
}: {
  label: ReactNode;
  sub?: ReactNode;
  on: boolean;
  disabled?: boolean;
  saving?: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="ability-row switch-row">
      {/* The words are the switch's label: clicking them flips it too. */}
      <label className="ability-text" htmlFor={`${id}-switch`}>
        <b id={`${id}-label`}>{label}</b>
        {sub && (
          <span className="ability-sub" id={`${id}-sub`}>
            {sub}
          </span>
        )}
      </label>
      {children}
      <button
        type="button"
        role="switch"
        id={`${id}-switch`}
        className="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={sub ? `${id}-sub` : undefined}
        aria-busy={saving || undefined}
        disabled={disabled || saving}
        onClick={() => onChange(!on)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}
