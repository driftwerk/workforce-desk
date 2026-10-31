import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "../styles/emoji.css";

// The picker and the emoji it shows load the first time it's opened.
const EmojiPicker = lazy(() => import("./EmojiPicker"));

const MARGIN = 8;

/** Where the picker opens: over everything (so a grid pane or a side panel
 *  doesn't cut it off), above the button and lined up with its right edge,
 *  never past the window's. */
const placeBy = (button: HTMLElement): CSSProperties => {
  const r = button.getBoundingClientRect();
  return {
    bottom: Math.max(MARGIN, window.innerHeight - r.top + 6),
    right: Math.max(MARGIN, window.innerWidth - r.right),
    maxHeight: Math.max(160, r.top - 6 - MARGIN),
  };
};

/** A composer's emoji button: opens the picker, whose choice goes in at the
 *  caret. */
export function EmojiButton({ onPick, disabled = false }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const open = place !== null;
  const close = (refocus: boolean) => {
    setPlace(null);
    if (refocus) button.current?.focus();
  };
  // It follows the button as the window changes size.
  useEffect(() => {
    if (!open) return;
    const follow = () => button.current && setPlace(placeBy(button.current));
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [open]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-btn-sm composer-attach composer-emoji"
        aria-label="Add an emoji"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Add an emoji"
        disabled={disabled}
        onClick={(e) => setPlace(open ? null : placeBy(e.currentTarget))}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" />
          <path d="M5.4 9.6a3.2 3.2 0 005.2 0" strokeLinecap="round" />
          <path d="M6 6.4h.01M10 6.4h.01" strokeLinecap="round" strokeWidth="2" />
        </svg>
      </button>
      {place &&
        createPortal(
          <Suspense
            fallback={
              <div className="emoji-popover" style={place} role="dialog" aria-label="Emoji" aria-busy="true">
                <span className="faint small emoji-note">Loading emoji…</span>
              </div>
            }
          >
            <EmojiPicker
              style={place}
              onPick={(emoji) => {
                close(false);
                onPick(emoji);
              }}
              onClose={close}
            />
          </Suspense>,
          document.body,
        )}
    </>
  );
}
