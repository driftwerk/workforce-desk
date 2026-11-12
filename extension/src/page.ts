// What Desk does inside a page: functions shipped in the extension and run
// in Desk's own tab with `scripting.executeScript({ func, args })`, in the
// isolated world (page scripts can't see or replace them). Each is
// self-contained: Chrome serialises the function alone, so nothing here may
// reach outside its own body. Each returns plain data, capped, never a DOM
// object, and never posts a message.

/** The page's address, title and text or HTML, each capped. `all` is the
 *  text with every field's value too, for the hub's check for a secret
 *  before a picture is taken. */
export function readPage(what: "text" | "html" | "all", maxText: number, maxHtml: number): { url: string; title: string; text?: string; html?: string } {
  const out: { url: string; title: string; text?: string; html?: string } = { url: location.href, title: document.title.slice(0, 1000) };
  if (what === "html") out.html = document.documentElement.outerHTML.slice(0, maxHtml);
  else {
    let text = document.body ? (document.body.innerText ?? document.body.textContent ?? "") : "";
    if (what === "all") {
      const values = Array.from(document.querySelectorAll("input, textarea")).map((e) => (e as HTMLInputElement).value || "");
      text = text + "\n" + values.join("\n");
    }
    out.text = text.slice(0, maxText);
  }
  return out;
}

/** What the page shows of an element (the focused one without a
 *  selector): its text, a button's value, its label, title, type, name,
 *  autocomplete hint and placeholder, and its form's action. What the hub's
 *  never-list reads. */
export function shownOf(selector: string | null, form: boolean): string {
  const el = (selector ? document.querySelector(selector) : document.activeElement) as HTMLInputElement | null;
  if (!el) return "";
  const button = el.tagName === "BUTTON" || (el.tagName === "INPUT" && /^(submit|button|reset)$/i.test(el.type || ""));
  const first = el.labels && el.labels.length ? (el.labels[0] as HTMLElement) : null;
  const label = first ? (first.innerText ?? first.textContent ?? "") : "";
  const action = form && el.form ? el.form.getAttribute("action") || "" : "";
  return [
    button || !("value" in el) ? ((el as HTMLElement).innerText ?? el.textContent ?? "") : "",
    button ? el.value : "",
    el.getAttribute("aria-label"),
    el.title,
    el.getAttribute("type"),
    el.getAttribute("name"),
    el.getAttribute("autocomplete"),
    el.getAttribute("placeholder"),
    label,
    action,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
}

/** Clicks the element `selector` names where it shows: at its centre, and
 *  only if that point is the element (or inside it), not something laid
 *  over it. */
export function clickOn(selector: string): "ok" | "missing" | "hidden" | "covered" {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return "missing";
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return "hidden";
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (hit && hit !== el && !el.contains(hit)) return "covered";
  const at = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  el.dispatchEvent(new PointerEvent("pointerdown", at));
  el.dispatchEvent(new MouseEvent("mousedown", at));
  if (typeof el.focus === "function") el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", at));
  el.dispatchEvent(new MouseEvent("mouseup", at));
  el.click();
  return "ok";
}

/** Puts `value` in the field `selector` names, as a person typing it would
 *  leave it: through the field's own setter, then `input` and `change`.
 *  Only on `origin`, the one the hub resolved `value` for: a page that
 *  moved since is left as it is. */
export function fillField(selector: string, value: string, origin: string | null): "ok" | "missing" | "moved" {
  if (origin === null || location.origin !== origin) return "moved";
  const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return "missing";
  el.focus();
  if ((el as HTMLElement).isContentEditable) {
    (el as HTMLElement).textContent = value;
  } else {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (set) set.call(el, value);
    else el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
}

/** Types `text` at the end of what the field `selector` names (the focused
 *  element without a selector) holds, a character at a time; only on
 *  `origin`, as [`fillField`]. */
export function typeText(selector: string | null, text: string, origin: string | null): "ok" | "missing" | "moved" {
  if (origin === null || location.origin !== origin) return "moved";
  const el = (selector ? document.querySelector(selector) : document.activeElement) as HTMLInputElement | HTMLElement | null;
  if (!el) return "missing";
  if (typeof el.focus === "function") el.focus();
  const editable = (el as HTMLElement).isContentEditable;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  for (const ch of Array.from(text)) {
    const key = { key: ch, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", key));
    if (editable) {
      (el as HTMLElement).textContent = ((el as HTMLElement).textContent || "") + ch;
    } else if ("value" in el) {
      const next = (el as HTMLInputElement).value + ch;
      if (set) set.call(el, next);
      else (el as HTMLInputElement).value = next;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
    el.dispatchEvent(new KeyboardEvent("keyup", key));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
}

/** Presses `key` (Enter, Tab, Escape, an arrow, or a character) on the
 *  element `selector` names, or the focused one. Enter in a form's field
 *  submits the form, as a browser does, unless the page stopped it. */
export function pressKey(selector: string | null, key: string): boolean {
  const el = (selector ? document.querySelector(selector) : document.activeElement || document.body) as HTMLElement | null;
  if (!el) return false;
  if (selector && typeof el.focus === "function") el.focus();
  const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true };
  const go = el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  if (go && key === "Enter") {
    const form = (el as HTMLInputElement).form;
    if (form && el.tagName === "INPUT") {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    } else if (el.tagName === "BUTTON" || el.tagName === "A") {
      el.click();
    }
  }
  return true;
}

/** Chooses the option of the select `selector` names whose value or text
 *  is `value`. */
export function selectOption(selector: string, value: string): boolean {
  const sel = document.querySelector(selector) as HTMLSelectElement | null;
  if (!sel || !sel.options) return false;
  const opt = Array.from(sel.options).find((o) => o.value === value || o.text === value);
  if (!opt) return false;
  sel.value = opt.value;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Reads a new key off a service's key page, for Desk to keep without its
 *  model ever seeing it. In this one call, so the page can't move between
 *  the check and the read: the page must be on `origin` under one of
 *  `paths` (whole segments: `/settings/api` holds `/settings/api/new`, not
 *  `/settings/apikeys`); the element must show to the person (laid out,
 *  visible, not see-through, not a hidden input); never an editable field,
 *  a password-like field (by type, autocomplete, id or name), or anything
 *  in a form with a password field. */
export function readKey(
  selector: string,
  origin: string,
  paths: string[],
  max: number,
): { value: string; origin: string; path: string } | { refused: string } {
  const here = { origin: location.origin, path: location.pathname };
  const under = (path: string, prefix: string) => {
    const p = prefix.replace(/\/+$/, "");
    return p === "" || path === p || path.startsWith(p + "/");
  };
  if (here.origin !== origin || !paths.some((p) => under(here.path, p))) return { refused: "not a key page" };
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return { refused: "missing" };
  const field = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? (el as HTMLInputElement) : null;
  if (field && !field.readOnly) return { refused: "an editable field" };
  const type = (el.getAttribute("type") || "").toLowerCase();
  const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
  const named = `${el.id} ${el.getAttribute("name") || ""}`;
  if (type === "password" || auto.includes("password") || /pass/i.test(named)) return { refused: "a password field" };
  const form = el.closest("form");
  if (form && form.querySelector('input[type="password" i]')) return { refused: "in a form with a password" };
  // It shows to the person: nothing hidden is read, field or text.
  if (type === "hidden") return { refused: "hidden" };
  const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
  if (r && (r.width === 0 || r.height === 0)) return { refused: "hidden" };
  for (let at: Element | null = el; at; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return { refused: "hidden" };
  }
  const value = (field ? field.value : (el.innerText ?? el.textContent ?? "")).trim().slice(0, max);
  if (!value) return { refused: "empty" };
  return { value, origin: here.origin, path: here.path };
}

/** Whether the page is on one of `pages` now: read with the call that
 *  depends on it. */
export function onKeyPage(pages: { origin: string; paths: string[] }[]): boolean {
  const under = (path: string, prefix: string) => {
    const p = prefix.replace(/\/+$/, "");
    return p === "" || path === p || path.startsWith(p + "/");
  };
  return pages.some((k) => location.origin === k.origin && k.paths.some((p) => under(location.pathname, p)));
}

/** The page's address now. */
export function hrefNow(): string {
  return location.href;
}

/** Whether `selector` names an element now. */
export function present(selector: string): boolean {
  return document.querySelector(selector) !== null;
}

/** Whether the element `selector` names has the focus. */
export function focused(selector: string): boolean {
  const el = document.querySelector(selector);
  return !!el && document.activeElement === el;
}

/** Gives the file input `selector` names these files, as choosing them
 *  would. */
export function setFiles(selector: string, files: { name: string; type: string; base64: string }[]): boolean {
  const input = document.querySelector(selector) as HTMLInputElement | null;
  if (!input || input.tagName !== "INPUT" || input.type !== "file") return false;
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }));
  }
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}
