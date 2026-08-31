/**
 * Tooltips drawn by the panel instead of by the operating system.
 *
 * A title attribute is shown by Windows in its own grey box, in its own font, about a second
 * after the pointer stops — the last piece of the interface that still looked borrowed. The
 * attribute stays the source of the text and stays in the markup; it is lifted off the element
 * only while the pointer is on it, which is what keeps the system box from appearing, and put
 * back on the way out. Every element that carries one also carries an aria-label, so nothing
 * is taken away from a screen reader while the attribute is off.
 *
 * The question marks (data-hint) are drawn by the same bubble. They used to carry their own,
 * built by CSS out of an absolutely positioned box three hundred pixels wide. Such a box is
 * laid out even while invisible, so every explanation quietly widened whatever contained it:
 * that is where the sideways scrollbars in the dialogs came from.
 */

const SOURCES = ["title", "data-hint"];
// A question mark is there to be read: it answers at once. A title is a second thought.
const DELAY = { title: 420, "data-hint": 80 };
let bubble = null;
let held = null;
let timer = 0;

export function initTooltips() {
  if (bubble) return;
  bubble = document.createElement("div");
  bubble.className = "tooltip-bubble";
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  document.body.append(bubble);

  document.addEventListener("pointerover", event => {
    const target = carrier(event.target);
    if (!target || target === held?.element) return;
    show(target);
  });
  document.addEventListener("pointerout", event => {
    const target = event.target instanceof Element
      ? event.target.closest("[title],[data-hint],[data-tooltip-held]") : null;
    if (target && target === held?.element) hide();
  });
  // A press means the person is acting, not reading; a moved page leaves the bubble pointing
  // at nothing.
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  document.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
  // The keyboard deserves the same explanation the pointer gets.
  document.addEventListener("focusin", event => {
    const target = carrier(event.target);
    if (target) show(target);
  });
  document.addEventListener("focusout", () => hide());
}

/** The nearest element that explains itself, and the attribute it explains itself with. */
function carrier(node) {
  return node instanceof Element ? node.closest("[title],[data-hint]") : null;
}

function show(element) {
  hide();
  const source = SOURCES.find(name => element.getAttribute(name)?.trim());
  if (!source) return;
  const text = element.getAttribute(source);
  held = { element, text, source };
  // Only the title has to go: it is the one the operating system would draw itself.
  if (source === "title") element.removeAttribute("title");
  element.setAttribute("data-tooltip-held", "");
  timer = window.setTimeout(() => {
    if (held?.element !== element || !element.isConnected) return;
    bubble.textContent = text;
    // An explanation inside a modal has to be drawn inside it: the dialog is in the browser's
    // top layer, and anything left on the page behind it stays behind it.
    (element.closest("dialog") || document.body).append(bubble);
    bubble.hidden = false;
    place(element);
  }, DELAY[source]);
}

function hide() {
  window.clearTimeout(timer);
  if (held) {
    // Something may have written a fresher title while this one was lifted off; that one wins.
    if (held.source === "title" && held.element.isConnected && !held.element.hasAttribute("title")) {
      held.element.setAttribute("title", held.text);
    }
    held.element.removeAttribute("data-tooltip-held");
    held = null;
  }
  if (bubble) bubble.hidden = true;
}

function place(element) {
  const anchor = element.getBoundingClientRect();
  const width = bubble.offsetWidth;
  const height = bubble.offsetHeight;
  const below = anchor.bottom + 8;
  // Above when the bubble would not fit under the element.
  bubble.style.top = `${Math.round(below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 8) : below)}px`;
  bubble.style.left = `${Math.round(Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)))}px`;
}
