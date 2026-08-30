import { initModrinth } from "./modrinth-ui.js";
import { initGithub } from "./github-ui.js";
import { initCurseforge } from "./curseforge-ui.js";

export function initCatalog(options) {
  const providers = { modrinth: initModrinth(options), github: initGithub(options), curseforge: initCurseforge(options) };
  let selected = Object.hasOwn(providers, options.initialProvider) ? options.initialProvider : "modrinth";
  const tabs = document.getElementById("catalogSources");
  const buttons = [...tabs.querySelectorAll("[data-catalog-source]")];
  function select(name, open = true) {
    if (options.getBusy() || !Object.hasOwn(providers, name)) return;
    selected = name;
    for (const button of buttons) {
      const active = button.dataset.catalogSource === selected;
      button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
      document.getElementById(button.getAttribute("aria-controls")).hidden = !active;
    }
    if (open) providers[selected].onOpen();
  }
  tabs.addEventListener("click", event => {
    const button = event.target.closest("[data-catalog-source]");
    if (button) select(button.dataset.catalogSource);
  });
  tabs.addEventListener("keydown", event => {
    const index = buttons.indexOf(document.activeElement);
    if (index < 0 || options.getBusy() || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length;
    select(buttons[next].dataset.catalogSource); buttons[next].focus();
  });
  select(selected, false);
  return { onOpen: force => providers[selected].onOpen(force), selected: () => selected };
}
