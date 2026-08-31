/**
 * A dropdown list drawn by the panel instead of by the operating system.
 *
 * The list a native <select> opens is drawn by Windows: it ignores every colour, corner and
 * font on this page, and next to the rest of the interface it looks like a different program.
 * Only the list is replaced here. The <select> itself stays exactly where it is — same place
 * in the layout, same label, same value, same events — so nothing that reads or writes it has
 * to know. Focus never leaves it either: the menu is a picture of its options, driven from the
 * element that already has the keyboard.
 *
 * Every select is served by one set of listeners on the document rather than by wiring each
 * one: rows of files build their own selects as they render, and those must behave the same
 * without anyone remembering to register them.
 */

const open = { select: null, menu: null, index: -1 };
let started = false;

export function initSelectMenus() {
  if (started) return;
  started = true;

  document.addEventListener("mousedown", event => {
    const select = event.target instanceof HTMLSelectElement ? event.target : null;
    if (select) {
      if (select.disabled || event.button !== 0) return;
      // Without this the operating system opens its own list on top of ours.
      event.preventDefault();
      select.focus();
      if (open.select === select) closeMenu(); else openMenu(select);
      return;
    }
    if (open.select && !event.target.closest(".select-menu")) closeMenu();
  });

  document.addEventListener("keydown", event => {
    const select = event.target instanceof HTMLSelectElement ? event.target : null;
    if (!select || select.disabled) return;
    if (open.select !== select) {
      // Enter is left alone: inside a form it may be the way the person submits it.
      if (["ArrowDown", "ArrowUp", " "].includes(event.key)) { event.preventDefault(); openMenu(select); }
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") { closeMenu(); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); commit(); return; }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step) { event.preventDefault(); move(step); return; }
    if (event.key === "Home" || event.key === "End") { event.preventDefault(); highlight(event.key === "Home" ? 0 : Infinity); }
  });

  document.addEventListener("focusout", event => {
    if (open.select && event.target === open.select) closeMenu();
  });

  // Anchored to the viewport, so it follows what it hangs from and leaves when that leaves.
  const follow = () => {
    if (!open.select) return;
    const anchor = open.select.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > window.innerHeight) closeMenu(); else place();
  };
  document.addEventListener("scroll", follow, true);
  window.addEventListener("resize", follow);
}

function options(select) {
  return [...select.options].filter(option => !option.hidden);
}

function openMenu(select) {
  closeMenu();
  const choices = options(select);
  if (!choices.length) return;

  const menu = document.createElement("div");
  menu.className = "select-menu";
  menu.setAttribute("role", "listbox");
  choices.forEach((option, index) => {
    const row = document.createElement("div");
    row.className = "select-option";
    row.id = `select-option-${index}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(option.selected));
    if (option.disabled) row.setAttribute("aria-disabled", "true");
    row.textContent = option.textContent;
    row.addEventListener("mousedown", event => {
      // Choosing on mousedown, with the default prevented, keeps the keyboard on the select:
      // a click that moved focus would blur it and close the menu before the choice landed.
      event.preventDefault();
      if (option.disabled) return;
      open.index = index;
      commit();
    });
    row.addEventListener("mousemove", () => { if (!option.disabled) highlight(index); });
    menu.append(row);
  });

  // A select inside a modal has to put its menu inside that modal: the dialog is drawn in the
  // browser's top layer, above anything left on the page behind it.
  (select.closest("dialog") || document.body).append(menu);
  open.select = select;
  open.menu = menu;
  select.classList.add("select-open");
  select.setAttribute("aria-expanded", "true");
  place();
  highlight(Math.max(0, choices.findIndex(option => option.selected)));
}

function closeMenu() {
  if (!open.select) return;
  open.menu.remove();
  open.select.classList.remove("select-open");
  open.select.removeAttribute("aria-expanded");
  open.select.removeAttribute("aria-activedescendant");
  open.select = null; open.menu = null; open.index = -1;
}

function highlight(index) {
  const rows = [...open.menu.children];
  if (!rows.length) return;
  open.index = Math.max(0, Math.min(rows.length - 1, index));
  rows.forEach((row, position) => row.classList.toggle("active", position === open.index));
  open.select.setAttribute("aria-activedescendant", rows[open.index].id);
  rows[open.index].scrollIntoView?.({ block: "nearest" });
}

function move(step) {
  const rows = [...open.menu.children];
  let next = open.index;
  // Steps over the unavailable entries instead of stopping on one.
  for (let attempt = 0; attempt < rows.length; attempt++) {
    next = (next + step + rows.length) % rows.length;
    if (!rows[next].hasAttribute("aria-disabled")) break;
  }
  highlight(next);
}

function commit() {
  const select = open.select;
  const choice = options(select)[open.index];
  closeMenu();
  select.focus();
  if (!choice || choice.disabled || choice.selected) return;
  choice.selected = true;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function place() {
  const anchor = open.select.getBoundingClientRect();
  const menu = open.menu;
  menu.style.minWidth = `${Math.round(anchor.width)}px`;
  const height = menu.offsetHeight;
  const below = window.innerHeight - anchor.bottom - 10;
  // Above when there is not enough room underneath and more of it overhead.
  const above = below < height && anchor.top > below;
  menu.style.top = above ? `${Math.round(Math.max(8, anchor.top - height - 4))}px` : `${Math.round(anchor.bottom + 4)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
}
