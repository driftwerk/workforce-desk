import type { CSSProperties } from "react";
import { cssVariables, tokenVar, type Theme } from "./tokens";
import { ANSI } from "./xterm";

/** Desk drawn small in `theme`: its sidebar, a chat, a card, the terminal
 *  and what waits on you. */
export function ThemePreview({ theme, label = "Preview" }: { theme: Theme; label?: string }) {
  return (
    <div className="preview" style={cssVariables(theme) as CSSProperties} data-testid="preview" aria-label={label}>
      <div className="pv-side">
        <span className="pv-word">
          <b>desk</b>
          <span className="pv-dot" />
        </span>
        <span className="pv-ask">Ask anyone</span>
        <span className="small faint">Crew</span>
        <span className="pv-crew">
          <span className="pv-mark pv-mark-working" style={{ background: tokenVar("mark1") }} />
          atlas
        </span>
        <span className="pv-crew">
          <span className="pv-mark" style={{ background: tokenVar("mark2") }} />
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
          <span style={{ color: "var(--ansi-cyan)" }}>●</span> Edit gateway.rs <span style={{ color: "var(--ansi-green)" }}>+14</span>{" "}
          <span style={{ color: "var(--ansi-red)" }}>-6</span>
        </span>
        <span className="pv-blocked">
          <b>Needs you</b>
          <span className="pv-allow">Allow</span>
        </span>
      </div>
    </div>
  );
}

/** The terminal's colours on its own ground: its text, cursor and
 *  selection, and the 16 ANSI colours, plain then bright. */
export function TerminalSwatches({ theme }: { theme: Theme }) {
  const c = theme.colors;
  return (
    <div className="term-swatches" style={{ background: c.sunken, color: c.termText }} aria-label="Terminal colours">
      <span className="term-swatches-text mono">
        <span style={{ background: c.termSelection }}>$ ls</span>
        <span className="term-swatches-cursor" style={{ background: c.termCursor }} />
      </span>
      <span className="term-swatches-row">
        {ANSI.map((t) => (
          <span key={t} className="term-swatch" title={`${t} ${c[t]}`} style={{ background: c[t] }} />
        ))}
      </span>
    </div>
  );
}
