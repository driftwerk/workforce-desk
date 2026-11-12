import { useRef, useState, type CSSProperties } from "react";
import { EmojiPopover, placeBy } from "../emoji/EmojiButton";
import { Menu, type MenuEntry } from "../ui/Menu";

/** A narrow composer's one overflow button: the emoji, and whatever else
 *  its buttons do (`more`), folded into a menu. It shows only while the
 *  composer is narrow (app.css): the buttons it stands for hide then. */
export function ComposerMore({
  label,
  onEmoji,
  more = [],
  disabled = false,
}: {
  /** "More for Desk": what the button is called. */
  label: string;
  onEmoji: (emoji: string) => void;
  more?: MenuEntry[];
  disabled?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [emojiAt, setEmojiAt] = useState<CSSProperties | null>(null);
  const entries: MenuEntry[] = [
    {
      kind: "item",
      label: "Add an emoji",
      onSelect: () => button.current && setEmojiAt(placeBy(button.current)),
    },
    ...more,
  ];
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-btn-sm composer-attach composer-more"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title={label}
        disabled={disabled}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.top - 4 });
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="12.5" cy="8" r="1.4" />
        </svg>
      </button>
      {menu && (
        <Menu
          label={label}
          at={menu}
          entries={entries}
          onClose={(refocus) => {
            setMenu(null);
            if (refocus) button.current?.focus();
          }}
        />
      )}
      {emojiAt && (
        <EmojiPopover
          place={emojiAt}
          onPick={onEmoji}
          onClose={(refocus) => {
            setEmojiAt(null);
            if (refocus) button.current?.focus();
          }}
        />
      )}
    </>
  );
}
