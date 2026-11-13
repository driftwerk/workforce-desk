import { radioKeys } from "../ui/Dialog";
import { PRESETS, PRESET_NAME, presetDesc, type Preset } from "./presets";

/** How much an overseer does on its own, as four presets, each with the
 *  switches it implies: the same choice on the Floor's card and in its
 *  Settings. */
export function LevelPicker({
  value,
  onPick,
  label = "How much it does on its own",
}: {
  value: Preset;
  onPick: (p: Preset) => void;
  label?: string;
}) {
  const at = PRESETS.indexOf(value);
  return (
    <div
      className="oversee-levels oversee-levels-4"
      role="radiogroup"
      aria-label={label}
    >
      {PRESETS.map((p, i) => (
        <button
          key={p}
          type="button"
          role="radio"
          className="oversee-level"
          aria-checked={value === p}
          tabIndex={i === at ? 0 : -1}
          onClick={() => p !== value && onPick(p)}
          onKeyDown={(e) =>
            radioKeys(e, PRESETS, at, (next) => next !== value && onPick(next))
          }
        >
          <b>{PRESET_NAME[p]}</b>
          <span>{presetDesc(p)}</span>
        </button>
      ))}
    </div>
  );
}
