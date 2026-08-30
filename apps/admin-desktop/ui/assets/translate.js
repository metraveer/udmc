import { t, getLanguage } from "./i18n.js";
import { formatAgentError } from "./http.js";

const $ = id => document.getElementById(id);
const invoke = (name, args) => {
  if (!window.__TAURI__?.core?.invoke) throw new Error(t("Перевод доступен в Windows-приложении UDMC Control."));
  return window.__TAURI__.core.invoke(name, args);
};
const MAX_TEXTS = 32;
const MAX_TEXT = 4000;
const MAX_TOTAL = 9000;

export function initTranslator({ showToast }) {
  let config = null;
  let builtin = null;
  let saving = false;
  let editing = false;
  let testing = false;
  let verified = null; // null = not checked yet, true/false = the live check outcome

  function renderSettings() {
    const state = $("translatorState");
    const configured = Boolean(config);
    if (builtin) { state.textContent = t("Встроенный перевод доступен"); state.className = "state-badge online"; }
    else if (testing) { state.textContent = t("Проверяем перевод..."); state.className = "state-badge neutral"; }
    else if (configured && verified === true) { state.textContent = t("Перевод работает"); state.className = "state-badge online"; }
    else if (configured && verified === false) { state.textContent = t("Проверка не прошла"); state.className = "state-badge warning"; }
    else if (configured) { state.textContent = t("Ключ сохранён, не проверен"); state.className = "state-badge neutral"; }
    else { state.textContent = t("Не настроен"); state.className = "state-badge neutral"; }
    $("translatorForm").hidden = configured && !editing;
    $("translatorConfigured").hidden = !configured || editing;
    $("translatorEditCancelButton").hidden = !(configured && editing);
    $("translatorTestButton").disabled = testing;
    if (config) $("translatorConfiguredSummary").textContent = t("Ключ хранится в защищённом хранилище Windows и в файлы проекта не попадает. Каталог Yandex Cloud: {0}.", config.folder);
    $("translatorFolderInput").value = editing ? config?.folder || $("translatorFolderInput").value : config?.folder || "";
  }

  async function testTranslation(manual) {
    if (!config || testing) return;
    testing = true;
    renderSettings();
    try {
      const out = await invoke("translate_texts", { key: config.key, folder: config.folder, texts: ["Hello"], target: "ru" });
      verified = true;
      showToast(t("Переводчик работает: «Hello» → «{0}»", String(out?.[0] ?? "")));
    } catch (error) {
      verified = false;
      showToast(formatAgentError(error), "error");
    } finally {
      testing = false;
      renderSettings();
    }
  }

  // The Windows vault is only touched on demand: opening the settings page or
  // pressing a translate button, never at boot.
  let configPromise = null;
  function load() {
    return configPromise ??= (async () => {
      try {
        const raw = await invoke("credential_read", { name: "translator-key" });
        const parsed = raw ? JSON.parse(raw) : null;
        config = parsed && typeof parsed.key === "string" && typeof parsed.folder === "string" ? parsed : null;
      } catch { config = null; }
      try {
        // The Chromium built-in translator ships models through Chrome's component
        // updater, which WebView2 currently lacks; use it only when already usable.
        if (typeof Translator !== "undefined"
          && await Translator.availability({ sourceLanguage: "en", targetLanguage: "ru" }) === "available") {
          builtin = await Translator.create({ sourceLanguage: "en", targetLanguage: "ru" });
        }
      } catch { builtin = null; }
      renderSettings();
    })();
  }

  const engineReady = () => Boolean(builtin || config);

  async function translateBatch(texts) {
    if (builtin) {
      const out = [];
      for (const text of texts) out.push(await builtin.translate(text));
      return out;
    }
    return invoke("translate_texts", { key: config.key, folder: config.folder, texts, target: "ru" });
  }

  async function translateAll(texts) {
    const out = new Array(texts.length);
    let start = 0;
    while (start < texts.length) {
      let end = start, total = 0;
      while (end < texts.length && end - start < MAX_TEXTS) {
        const length = Math.min(texts[end].length, MAX_TEXT);
        if (total + length > MAX_TOTAL && end > start) break;
        total += length;
        end++;
      }
      const chunk = texts.slice(start, end).map(text => text.slice(0, MAX_TEXT));
      const translated = await translateBatch(chunk);
      for (let i = 0; i < translated.length; i++) out[start + i] = translated[i];
      start = end;
    }
    return out;
  }

  function collectNodes(containers) {
    const nodes = [];
    for (const id of containers) {
      const root = $(id);
      if (!root) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.data.trim()) continue;
        if (node.parentElement?.closest("code, pre")) continue;
        nodes.push(node);
      }
    }
    return nodes;
  }

  function register(buttonId, containers) {
    const button = $(buttonId);
    if (!button) return;
    const label = button.querySelector("span");
    let applied = null; // { nodes, originals }
    let busy = false;
    const setLabel = translated => { label.textContent = translated ? t("Оригинал") : t("Перевести"); };
    const reset = () => { applied = null; setLabel(false); };
    // A newly selected mod re-renders the description: drop the stale toggle state.
    for (const id of containers) {
      const root = $(id);
      if (root) new MutationObserver(() => { if (!busy) reset(); }).observe(root, { childList: true });
    }
    button.hidden = getLanguage() !== "ru";
    button.addEventListener("click", async () => {
      if (busy) return;
      if (applied) {
        for (let i = 0; i < applied.nodes.length; i++) applied.nodes[i].data = applied.originals[i];
        reset();
        return;
      }
      await load();
      if (!engineReady()) {
        showToast(t("Переводчик не настроен. Сохраните ключ на странице «Настройки»."), "error");
        return;
      }
      const nodes = collectNodes(containers).filter(node => node.data.trim().length > 1);
      if (!nodes.length) return;
      busy = true;
      button.disabled = true;
      label.textContent = t("Перевод...");
      try {
        const originals = nodes.map(node => node.data);
        const translated = await translateAll(originals);
        for (let i = 0; i < nodes.length; i++) {
          if (typeof translated[i] === "string" && nodes[i].isConnected) nodes[i].data = translated[i];
        }
        applied = { nodes, originals };
        setLabel(true);
      } catch (error) {
        showToast(formatAgentError(error), "error");
        setLabel(false);
      } finally {
        busy = false;
        button.disabled = false;
      }
    });
  }

  $("translatorForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (saving) return;
    const key = $("translatorKeyInput").value.trim();
    const folder = $("translatorFolderInput").value.trim();
    if (!key || !folder) {
      showToast(t("Заполните ключ API и идентификатор каталога."), "error");
      return;
    }
    saving = true;
    try {
      await invoke("credential_write", { name: "translator-key", value: JSON.stringify({ provider: "yandex", key, folder }) });
      config = { provider: "yandex", key, folder };
      $("translatorKeyInput").value = "";
      editing = false;
      verified = null;
      renderSettings();
      await testTranslation(false);
    } catch (error) { showToast(formatAgentError(error), "error"); }
    finally { saving = false; }
  });
  $("translatorTestButton").addEventListener("click", () => testTranslation(true));
  $("translatorReplaceButton").addEventListener("click", () => { editing = true; renderSettings(); $("translatorKeyInput").focus(); });
  $("translatorEditCancelButton").addEventListener("click", () => { editing = false; $("translatorKeyInput").value = ""; renderSettings(); });
  $("translatorForgetButton").addEventListener("click", async () => {
    if (saving || !config) return;
    saving = true;
    try {
      await invoke("credential_write", { name: "translator-key", value: null });
      config = null;
      editing = false;
      verified = null;
      renderSettings();
      showToast(t("Ключ переводчика удалён"));
    } catch (error) { showToast(formatAgentError(error), "error"); }
    finally { saving = false; }
  });
  // The AI Studio interface creates the service account, the roles and a scoped
  // API key with a single button; the console is only needed for the folder id.
  const openLink = url => invoke("open_catalog_link", { url }).catch(error => showToast(formatAgentError(error), "error"));
  $("translatorHelp").addEventListener("click", () => openLink("https://aistudio.yandex.cloud/platform/"));
  $("translatorConsoleLink").addEventListener("click", () => openLink("https://console.yandex.cloud/"));
  $("translatorDocsLink").addEventListener("click", () => openLink("https://aistudio.yandex.ru/ru/docs/ai-studio/operations/get-api-key"));

  const settingsView = $("settingsView");
  const loadWhenVisible = () => { if (settingsView.classList.contains("active")) load(); };
  new MutationObserver(loadWhenVisible).observe(settingsView, { attributes: true, attributeFilter: ["class"] });
  loadWhenVisible();
  register("modrinthTranslate", ["modrinthProjectSummary", "modrinthDescription"]);
  register("curseforgeTranslate", ["curseforgeDescription"]);
  register("githubTranslate", ["githubDescription"]);
}
