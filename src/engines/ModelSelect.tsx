import { useEffect, useRef, useState } from "react";
import type { Engine } from "../hub/types";
import { ENGINE_MODELS } from "./engines";

const OTHER = "\u0000other";

/** An engine's model: its default, one listed for it (ENGINE_MODELS), or
 *  Other…, which takes a model's exact id in a small field. Drawn as the
 *  plan card's engine picker is (`pc-engine`). */
export function ModelSelect({
  engine,
  value,
  label,
  disabled,
  onChange,
}: {
  engine: Engine;
  /** null is the engine's default. */
  value: string | null;
  label: string;
  disabled?: boolean;
  onChange: (model: string | null) => void;
}) {
  const listed = ENGINE_MODELS[engine] ?? [];
  const known = !value || listed.some((m) => m.id === value);
  const [typing, setTyping] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // Escape leaves the field: the blur that follows keeps nothing typed.
  const cancelled = useRef(false);
  useEffect(() => {
    if (typing !== null) field.current?.focus();
  }, [typing !== null]);

  const done = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const id = typing?.trim() ?? "";
    setTyping(null);
    if (id && id !== value) onChange(id);
  };
  if (typing !== null)
    return (
      <input
        ref={field}
        className="pc-engine pc-model-other mono"
        aria-label={`${label}: the model's exact id`}
        placeholder="model id"
        value={typing}
        readOnly={disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setTyping(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            done();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancelled.current = true;
            setTyping(null);
          }
        }}
      />
    );
  return (
    <select
      className="pc-engine"
      aria-label={label}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value;
        if (v === OTHER) {
          cancelled.current = false;
          setTyping(known ? "" : (value ?? ""));
        }
        else onChange(v || null);
      }}
    >
      <option value="">Engine default</option>
      {listed.map((m) => (
        <option key={m.id} value={m.id}>
          {m.title}
        </option>
      ))}
      {!known && value && <option value={value}>{value}</option>}
      <option value={OTHER}>Other…</option>
    </select>
  );
}
