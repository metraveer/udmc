/**
 * Tooltips drawn by the panel instead of by the operating system.
 *
 * A title attribute is shown by Windows in its own grey box, in its own font, about a second
 * after the pointer stops — the last piece of the interface that still looked borrowed. The
 * attribute stays the source of the text and stays in the markup; it is lifted off the element
 * only while the pointer is on it, which is what keeps the system box from appearing, and put
 * back on the way out. Every element that carries one also carries an aria-label, so nothing
 * is taken away from a screen reader while the attribute is off.
 */

const DELAY = 420;
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
    const target = event.target instanceof Element ? event.target.closest("[title]") : null;
    if (!target || target === held?.element) return;
    show(target, target.getAttribute("title"));
  });
  document.addEventListener("pointerout", event => {
    const target = event.target instanceof Element ? event.target.closest("[title],[data-tooltip-held]") : null;
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
    const target = event.target instanceof Element ? event.target.closest("[title]") : null;
    if (target) show(target, target.getAttribute("title"));
  });
  document.addEventListener("focusout", () => hide());
}

function show(element, text) {
  hide();
  if (!text || !text.trim()) return;
  held = { element, text };
  element.removeAttribute("title");
  element.setAttribute("data-tooltip-held", "");
  timer = window.setTimeout(() => {
    if (held?.element !== element || !element.isConnected) return;
    bubble.textContent = text;
    bubble.hidden = false;
    place(element);
  }, DELAY);
}

function hide() {
  window.clearTimeout(timer);
  if (held) {
    // Something may have written a fresher title while this one was lifted off; that one wins.
    if (held.element.isConnected && !held.element.hasAttribute("title")) held.element.setAttribute("title", held.text);
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
