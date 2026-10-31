// The emoji picker (frimousse, drawn in the theme's colours): search,
// categories, the emoji you've used lately and a skin tone. Arrows move
// through the emoji from the search field, Enter picks, Escape closes.

import { EmojiPicker as Picker, type EmojiData, type EmojiPickerListCategoryHeaderProps } from "frimousse";
import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { loadEmoji, useEmojiSet, type EmojiSet, type Tone } from "./data";
import { setTone, used, useEmojiPrefs } from "./prefs";

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const asPicker = new WeakMap<EmojiSet, EmojiData>();

/** The set as frimousse takes it: found by its shortcodes as well as its
 *  name and keywords. */
export const pickerData = (set: EmojiSet): EmojiData => {
  let data = asPicker.get(set);
  if (!data) {
    data = {
      locale: "en",
      emojis: set.entries.map((e) => ({
        emoji: e.emoji,
        category: e.group,
        label: capital(e.label),
        version: e.version,
        tags: [...e.tags, ...e.shortcodes],
        ...(e.skins ? { skins: e.skins } : {}),
      })),
      categories: set.groups,
      skinTones: set.tones,
    };
    asPicker.set(set, data);
  }
  return data;
};

const resolve = () => loadEmoji().then(pickerData);

function CategoryHeader({ category, ...props }: EmojiPickerListCategoryHeaderProps) {
  return (
    <div {...props} className="emoji-category">
      {category.label}
    </div>
  );
}

export default function EmojiPicker({
  style,
  onPick,
  onClose,
}: {
  /** Where it opens. */
  style?: CSSProperties;
  onPick: (emoji: string) => void;
  onClose: (refocus: boolean) => void;
}) {
  const set = useEmojiSet();
  const { recent, tone } = useEmojiPrefs();
  const viewport = useRef<HTMLDivElement>(null);

  // A click anywhere else closes it (its own button toggles it).
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!(e.target instanceof Element && e.target.closest(".emoji-popover, .composer-emoji"))) onClose(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);

  const choose = (emoji: string) => {
    used(emoji);
    onPick(emoji);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose(true);
  };
  /** Scrolls the list to the category `label`. */
  const jump = (label: string) => {
    const v = viewport.current;
    const header = [...(v?.querySelectorAll("[frimousse-category-header]") ?? [])].find((h) => h.textContent === label);
    const category = header?.closest("[frimousse-category]");
    if (!v || !category) return;
    v.scrollTo({ top: category.getBoundingClientRect().top - v.getBoundingClientRect().top + v.scrollTop });
  };
  const firstOf = (group: number) => set?.entries.find((e) => e.group === group)?.emoji;

  return (
    <div className="emoji-popover" style={style} role="dialog" aria-label="Emoji" onKeyDown={onKeyDown}>
      <Picker.Root
        className="emoji-picker"
        columns={9}
        skinTone={tone}
        resolveEmojiData={resolve}
        onEmojiSelect={(e) => choose(e.emoji)}
      >
        <Picker.Search className="emoji-search" aria-label="Search emoji" placeholder="Search emoji" autoFocus />
        {set && (
          <nav className="emoji-categories" aria-label="Categories">
            {set.groups.map((g) => (
              <button key={g.index} type="button" title={g.label} aria-label={g.label} onClick={() => jump(g.label)}>
                <span aria-hidden="true">{firstOf(g.index)}</span>
              </button>
            ))}
          </nav>
        )}
        {recent.length > 0 && (
          <div className="emoji-recent" role="group" aria-label="Recently used">
            <span className="emoji-category">Recently used</span>
            <div className="emoji-recent-row">
              {recent.map((emoji) => (
                <button key={emoji} type="button" className="emoji-cell" aria-label={emoji} onClick={() => choose(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}
        <Picker.Viewport ref={viewport} className="emoji-viewport">
          <Picker.Loading className="faint small emoji-note">Loading emoji…</Picker.Loading>
          <Picker.Empty className="faint small emoji-note">{({ search }) => `No emoji for “${search}”`}</Picker.Empty>
          <Picker.List className="emoji-list" components={{ CategoryHeader }} />
        </Picker.Viewport>
        <footer className="emoji-foot">
          <Picker.ActiveEmoji>
            {({ emoji }) => (
              <span className="emoji-active small">
                {emoji ? (
                  <>
                    <span aria-hidden="true">{emoji.emoji}</span> {emoji.label}
                  </>
                ) : (
                  <span className="faint">Arrows to move, Enter to pick</span>
                )}
              </span>
            )}
          </Picker.ActiveEmoji>
          <Picker.SkinTone emoji="✋">
            {({ skinToneVariations }) => (
              <span className="seg emoji-tones" role="radiogroup" aria-label="Skin tone">
                {skinToneVariations.map((v) => (
                  <button
                    key={v.skinTone}
                    type="button"
                    role="radio"
                    aria-checked={tone === v.skinTone}
                    aria-label={v.skinTone === "none" ? "Default skin tone" : (set?.tones[v.skinTone] ?? v.skinTone)}
                    onClick={() => setTone(v.skinTone as Tone)}
                  >
                    {v.emoji}
                  </button>
                ))}
              </span>
            )}
          </Picker.SkinTone>
        </footer>
      </Picker.Root>
    </div>
  );
}
