import { useEffect, useId, useState } from "react";
import { systemFonts } from "../platform";
import { SIZE_RANGES, type SizeRole, type ThemeSpec } from "../theme/tokens";
import { faceOf, FontPicker, fontOptions } from "./FontPicker";

const FONT_ROLES = [
  ["display", "Headings", "titles and names"],
  ["ui", "Interface and chat", "everything you read"],
  ["mono", "Code and terminals", "monospaced"],
] as const;

const SIZE_ROLES: readonly [SizeRole, string][] = [
  ["size", "Interface"],
  ["chatSize", "Chats and documents"],
  ["codeSize", "Code and terminals"],
];

/** `value` held to `role`'s range, in half pixels. */
export const sizeFor = (role: SizeRole, value: number): number => {
  const [min, max] = SIZE_RANGES[role];
  return Math.min(max, Math.max(min, Math.round(value * 2) / 2));
};

/** A theme's fonts and sizes: a font for each role, a size for each kind
 *  of text, and how they look together. */
export function TypeSettings({ spec, onEdit }: { spec: ThemeSpec; onEdit: (patch: Partial<ThemeSpec>) => void }) {
  const [system, setSystem] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    systemFonts().then(
      (fonts) => live && setSystem(fonts),
      (e: unknown) => console.warn("couldn't list this computer's fonts:", e),
    );
    return () => {
      live = false;
    };
  }, []);
  const options = fontOptions(system);
  const f = spec.fonts;
  return (
    <div className="type-settings">
      <div className="set-group">
        <span className="set-label">Type</span>
        <div className="font-fields">
          {FONT_ROLES.map(([role, label, hint]) => (
            <FontPicker key={role} label={label} hint={hint} value={f[role]} options={options} onPick={(name) => onEdit({ fonts: { ...f, [role]: name } })} />
          ))}
        </div>
      </div>
      <div className="set-group">
        <span className="set-label">Sizes</span>
        <div className="size-rows">
          {SIZE_ROLES.map(([role, label]) => (
            <SizeRow key={role} role={role} label={label} value={f[role]} onChange={(v) => onEdit({ fonts: { ...f, [role]: v } })} />
          ))}
        </div>
        <span className="small faint">Each kind of text is sized on its own, and saved with the theme.</span>
      </div>
      <div className="type-preview" aria-label="Type preview" data-testid="type-preview">
        <span style={{ fontFamily: faceOf(f.display), fontSize: 22, fontWeight: 650 }}>Floor</span>
        <span className="muted" style={{ fontFamily: faceOf(f.ui), fontSize: f.size }}>
          4 working · 3 need you · 9 done today
        </span>
        <span className="type-preview-msg">
          <b style={{ fontFamily: faceOf(f.ui), fontSize: f.size }}>Allan</b>
          <span style={{ fontFamily: faceOf(f.ui), fontSize: f.chatSize, lineHeight: 1.55 }}>
            Here’s the breakdown for this week: 100 tickets tracked, 6 in flight, and 12 urgent fixes shipped.
          </span>
        </span>
        <pre style={{ fontFamily: faceOf(f.mono), fontSize: f.codeSize }}>{"git push origin main\ncargo nextest run -j 2"}</pre>
      </div>
    </div>
  );
}

function SizeRow({ role, label, value, onChange }: { role: SizeRole; label: string; value: number; onChange: (v: number) => void }) {
  const id = useId();
  const [min, max] = SIZE_RANGES[role];
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={min} max={max} step={0.5} value={value} onChange={(e) => onChange(sizeFor(role, Number(e.target.value)))} />
      <span className="size-number">
        <input
          className="mono"
          type="number"
          aria-label={`${label} size in pixels`}
          min={min}
          max={max}
          step={0.5}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(n) && n >= min && n <= max) onChange(sizeFor(role, n));
          }}
          onBlur={() => setText(String(value))}
        />
        <span className="faint small">px</span>
      </span>
    </>
  );
}
