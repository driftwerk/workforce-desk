import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useDesk } from "../hub/store";
import { revealThemes, writeTheme } from "../platform";
import { DAY, NIGHT } from "../theme/builtin";
import { importTheme } from "../theme/import";
import { allThemes, resolveTheme, useThemeStore } from "../theme/store";
import { serializeTheme } from "../theme/toml";
import { contrastChecks, cssVariables, derive, isHex, type Corners, type Density, type ThemeSpec, type Token } from "../theme/tokens";
import { applyEdit, BACKGROUNDS, copyOf, DERIVED, FONTS, isBuiltin, SIGNALS, upsert, withOverride, type Swatch } from "./editing";
import { exportThemeFile, pickThemeFile } from "./files";

const SAVE_DELAY = 300;

const DENSITIES: readonly [Density, string][] = [
  ["compact", "Compact"],
  ["cozy", "Cozy"],
];

const CORNERS: readonly [Corners, string][] = [
  ["sharp", "Sharp"],
  ["soft", "Soft"],
  ["round", "Round"],
];

const FONT_ROLES = [
  ["display", "Names"],
  ["ui", "Interface"],
  ["mono", "Terminal"],
] as const;

interface Card {
  id: string;
  spec: ThemeSpec;
  label: string;
  sub: string;
}

const cardsFor = (custom: readonly ThemeSpec[], systemDark: boolean): Card[] => [
  { id: "night", spec: NIGHT, label: "Night", sub: "Default dark" },
  { id: "day", spec: DAY, label: "Day", sub: "Default light" },
  { id: "system", spec: systemDark ? NIGHT : DAY, label: "Match system", sub: "Night or Day with macOS" },
  ...allThemes(custom)
    .filter((t) => t.id !== "night" && t.id !== "day")
    .map((t) => ({ id: t.id, spec: t, label: t.name, sub: isBuiltin(t.id) ? "Built in" : `Yours · ${t.id}.toml` })),
];

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function Appearance() {
  const { choice, custom, systemDark, setChoice, setCustom } = useThemeStore();
  const fail = useDesk((s) => s.fail);
  const [draft, setDraft] = useState<ThemeSpec | null>(null);
  const [token, setToken] = useState<Token | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const pending = useRef<{ spec: ThemeSpec; timer: ReturnType<typeof setTimeout> } | null>(null);

  const resolved = resolveTheme(choice, custom, systemDark).spec;
  const spec = draft?.id === resolved.id ? draft : resolved;
  const theme = derive(spec);
  const builtin = isBuiltin(spec.id);
  const textCustom = Boolean(spec.text ?? spec.overrides.text);

  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    writeTheme(p.spec.id, serializeTheme(p.spec)).catch(fail);
  }, [fail]);

  useEffect(() => flush, [flush]);

  useEffect(() => {
    const stored = custom.find((t) => t.id === draft?.id);
    if (draft && stored && !pending.current && serializeTheme(stored) === serializeTheme(draft)) setDraft(null);
  }, [custom, draft]);

  const taken = (): string[] => allThemes(useThemeStore.getState().custom).map((t) => t.id);

  const show = (next: ThemeSpec) => {
    setDraft(next);
    setCustom(upsert(useThemeStore.getState().custom, next));
    if (useThemeStore.getState().choice !== next.id) setChoice(next.id);
  };

  const edit = (patch: Partial<ThemeSpec>) => {
    const next = applyEdit(spec, patch, taken());
    if (pending.current && pending.current.spec.id !== next.id) flush();
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { spec: next, timer: setTimeout(flush, SAVE_DELAY) };
    show(next);
  };

  const create = (next: ThemeSpec) => {
    flush();
    show(next);
    writeTheme(next.id, serializeTheme(next)).catch(fail);
  };

  const pick = (id: string) => {
    flush();
    setDraft(null);
    setToken(null);
    setTextOpen(false);
    setChoice(id);
  };

  const importFile = async () => {
    const file = await pickThemeFile().catch((e: unknown) => {
      fail(e);
      return null;
    });
    if (!file) return;
    try {
      const imported = importTheme(file.name, file.source);
      create(copyOf(imported, taken(), imported.name));
    } catch (e) {
      fail(`Couldn't import ${file.name}: ${message(e)}`);
    }
  };

  const cards = cardsFor(custom, systemDark);
  const preview = cssVariables(theme) as CSSProperties;

  return (
    <main className="settings-main">
      <div className="settings-head">
        <h1 className="display-xl">Appearance</h1>
        <span className="muted">Pick three colours. Desk works out the rest, including the terminal and chart colours.</span>
      </div>

      <section className="theme-cards" aria-label="Themes">
        {cards.map((card) => {
          const c = derive(draft?.id === card.id ? draft : card.spec).colors;
          return (
            <button
              key={card.id}
              type="button"
              className="theme-card"
              aria-pressed={choice === card.id}
              onClick={() => pick(card.id)}
            >
              <span className="theme-thumb" style={{ background: c.bg }}>
                <span style={{ background: c.surface }} />
                <span className="theme-thumb-lines">
                  <span style={{ background: c.text }} />
                  <span style={{ background: c.signal }} />
                </span>
              </span>
              <span className="strong">{card.label}</span>
              <span className="small muted">{card.sub}</span>
            </button>
          );
        })}
        <button type="button" className="theme-card theme-card-new" onClick={() => create(copyOf(spec, taken(), "New theme"))}>
          + New theme
        </button>
      </section>

      <div className="appearance-grid">
        <section className="appearance-editor" aria-label="Editor">
          <label className="field">
            <span>Name</span>
            <input value={spec.name} onChange={(e) => edit({ name: e.target.value })} />
          </label>

          <SwatchPicker label="Background" options={BACKGROUNDS} value={spec.background} onPick={(background) => edit({ background })} />
          <SwatchPicker label="Signal (your accent)" options={SIGNALS} value={spec.signal} onPick={(signal) => edit({ signal })} />

          <div className="set-group">
            <span className="set-label">Text</span>
            <span className="text-row">
              <span className="swatch swatch-static" style={{ background: theme.colors.text }} />
              {textCustom || textOpen ? (
                <>
                  <ColourField label="Text colour" value={theme.colors.text} onChange={(text) => edit({ text })} />
                  {textCustom && (
                    <button type="button" className="link text-row-action" onClick={() => edit({ text: undefined })}>
                      Automatic
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span>
                    Automatic, <span className="mono muted">{theme.colors.text}</span>
                  </span>
                  <button type="button" className="link link-signal text-row-action" onClick={() => setTextOpen(true)}>
                    Override
                  </button>
                </>
              )}
            </span>
          </div>

          <div className="font-fields">
            {FONT_ROLES.map(([role, label]) => (
              <label key={role} className="field">
                <span>{label}</span>
                <input
                  list="desk-fonts"
                  value={spec.fonts[role]}
                  onChange={(e) => edit({ fonts: { ...spec.fonts, [role]: e.target.value } })}
                />
              </label>
            ))}
            <datalist id="desk-fonts">
              {FONTS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>

          <div className="shape-row">
            <Segmented label="Density" options={DENSITIES} value={spec.density} onPick={(density) => edit({ density })} />
            <Segmented label="Corners" options={CORNERS} value={spec.corners} onPick={(corners) => edit({ corners })} />
          </div>

          <div className="set-group">
            <span className="set-label">Derived, override any of them</span>
            <div className="tokens">
              {DERIVED.map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  className={`token ${t in spec.overrides ? "token-set" : ""}`}
                  title={theme.colors[t]}
                  aria-pressed={token === t}
                  onClick={() => setToken(token === t ? null : t)}
                >
                  <span className="swatch swatch-sm" style={{ background: theme.colors[t] }} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            {token && (
              <div className="token-edit">
                <span className="strong">{DERIVED.find(([t]) => t === token)?.[1]}</span>
                <ColourField
                  label={`${token} colour`}
                  value={theme.colors[token]}
                  onChange={(hex) => edit({ overrides: withOverride(spec, token, hex) })}
                />
                {token in spec.overrides ? (
                  <button type="button" className="link" onClick={() => edit({ overrides: withOverride(spec, token, null) })}>
                    Clear override
                  </button>
                ) : (
                  <span className="small faint">Derived</span>
                )}
              </div>
            )}
          </div>

          <div className="set-group">
            <span className="set-label">Readability</span>
            {contrastChecks(theme).map((c) => (
              <span key={c.label} className="check">
                <span className={`badge ${c.pass ? "badge-pass" : "badge-low"}`}>{c.pass ? "Pass" : "Low"}</span>
                <span className="check-label">{c.label}</span>
                <span className="mono muted">{c.ratio.toFixed(1)}:1</span>
              </span>
            ))}
          </div>
        </section>

        <section className="appearance-side" aria-label="Preview and file">
          <span className="set-label">Preview</span>
          <div className="preview" style={preview} data-testid="preview">
            <div className="pv-side">
              <span className="pv-word">
                <b>desk</b>
                <span className="pv-dot" />
              </span>
              <span className="pv-ask">Ask anyone</span>
              <span className="small faint">Crew</span>
              <span className="pv-crew">
                <span className="pv-mark pv-mark-working" style={{ background: "#C9B8FF" }} />
                atlas
              </span>
              <span className="pv-crew">
                <span className="pv-mark" style={{ background: "#FFC98A" }} />
                allan
              </span>
            </div>
            <div className="pv-main">
              <span className="pv-title">release</span>
              <span className="small">
                <b>allan</b> <span className="muted">Three items are open.</span>
              </span>
              <span className="pv-card">
                <span style={{ width: "80%", background: "var(--signal)" }} />
                <span style={{ width: "34%", background: "var(--signal-soft)" }} />
                <span style={{ width: "20%", background: "var(--signal-soft)" }} />
              </span>
              <span className="pv-term">
                <span style={{ color: "var(--ansi-cyan)" }}>●</span> Edit gateway.rs{" "}
                <span style={{ color: "var(--ansi-green)" }}>+14</span> <span style={{ color: "var(--ansi-red)" }}>-6</span>
              </span>
              <span className="pv-blocked">
                <b>Needs you</b>
                <span className="pv-allow">Allow</span>
              </span>
            </div>
          </div>

          <div className="set-group">
            <span className="set-label">
              {builtin
                ? "Built in, so read-only. Change anything and Desk saves a copy you can edit."
                : "Theme file. Edit it in any editor and Desk updates live."}
            </span>
            {!builtin && <span className="mono small faint">~/Library/Application Support/Desk/themes/{spec.id}.toml</span>}
            <pre className="theme-toml" aria-label="Theme file">
              {serializeTheme(spec)}
            </pre>
            <div className="theme-actions">
              <button type="button" className="btn btn-signal" onClick={() => void importFile()}>
                Import…
              </button>
              <button type="button" className="btn" onClick={() => exportThemeFile(spec).catch(fail)}>
                Export
              </button>
              <button type="button" className="btn" onClick={() => create(copyOf(spec, taken()))}>
                Duplicate
              </button>
              <button type="button" className="btn" onClick={() => revealThemes().catch(fail)}>
                Show in Finder
              </button>
            </div>
            <span className="small faint">Import reads VS Code, Ghostty, iTerm2 and base16 themes.</span>
          </div>
        </section>
      </div>
    </main>
  );
}

function SwatchPicker({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly Swatch[];
  value: string;
  onPick: (hex: string) => void;
}) {
  return (
    <fieldset className="set-group">
      <legend className="set-label">{label}</legend>
      <div className="swatches">
        {options.map((o) => (
          <button
            key={o.hex}
            type="button"
            className="swatch"
            aria-label={o.label}
            aria-pressed={value === o.hex}
            style={{ background: o.hex }}
            onClick={() => onPick(o.hex)}
          />
        ))}
        <ColourField label={`${label} colour`} value={value} onChange={onPick} />
      </div>
    </fieldset>
  );
}

function ColourField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  return (
    <span className="colour-field">
      <input
        type="color"
        aria-label={`${label} picker`}
        value={value.toLowerCase()}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
      />
      <input
        className="mono"
        aria-label={label}
        value={text}
        spellCheck={false}
        maxLength={7}
        onChange={(e) => {
          const v = e.target.value.trim();
          const hex = v.startsWith("#") ? v : `#${v}`;
          setText(v);
          if (isHex(hex)) onChange(hex.toUpperCase());
        }}
      />
    </span>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly [T, string][];
  value: T;
  onPick: (value: T) => void;
}) {
  return (
    <div className="set-group">
      <span className="set-label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(([id, name]) => (
          <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onPick(id)}>
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
