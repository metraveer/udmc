import { t } from "./i18n.js";
import { loaderLabel, updatePlatformControls } from "./platform.js";
import { profileStorage as localStorage, profileCommand } from "./server-profiles.js";
import { formatAppError } from "./http.js";

const $ = (id) => document.getElementById(id);
const nativeInvoke = (name, args) => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error(t("Эта операция доступна в Windows-приложении UDMC Control."));
  return invoke(name, profileCommand(name, args));
};

/**
 * Handing out the mod. There is nothing to build any more: the panel carries the file it was
 * released with, one per game version, and saving it is a copy. The same file goes on the
 * server and to every player, so there is no wrong copy to give to the wrong person.
 */
export function initGenerator({ navigateTo, showToast, getBusy, setBusy: setAppBusy, onFieldsChanged = () => {},
  getServerPlatform = () => null }) {
  let catalog = [];
  let busy = false;
  const form = $("generatorForm");
  const fields = ["generatorLoader", "generatorMinecraft"];
  const persistSettings = (overrides = {}) => localStorage.setItem("udmc-generator-settings",
    JSON.stringify(Object.fromEntries(fields.map(id => [id, Object.hasOwn(overrides, id) ? overrides[id] : $(id).value]))));
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("udmc-generator-settings") || "null"); } catch { localStorage.removeItem("udmc-generator-settings"); }
  if (saved) for (const id of fields) if (typeof saved[id] === "string") $(id).value = saved[id];

  const report = (error) => showToast(formatAppError(error), "error");
  const setBusy = (value) => {
    busy = value;
    setAppBusy(value);
    form.querySelectorAll("input,select,button").forEach((input) => { input.disabled = value; });
    if (!value) syncLock();
    onFieldsChanged();
  };

  const setPlatform = (preferred = {}) => {
    const template = updatePlatformControls({ loader: $("generatorLoader"), minecraft: $("generatorMinecraft"), version: $("generatorLoaderVersion") }, catalog,
      { loader: preferred.generatorLoader, minecraft: preferred.generatorMinecraft });
    if (template) $("generatorJava").textContent = t("Java {0}+ на сервере и у игроков", template.java);
  };

  /**
   * The version is a choice only while nobody has answered it. A connected server has already
   * said which game it runs, and the file that goes into its mods folder is decided by that —
   * so there is nothing here to pick, and picking wrong is not a mistake worth allowing.
   */
  const serverPlatform = () => {
    const info = getServerPlatform();
    if (!info?.minecraft || !info?.loader) return null;
    return catalog.some(entry => entry.minecraft === info.minecraft && entry.loader === info.loader) ? info : null;
  };
  const syncLock = () => {
    const server = serverPlatform();
    if (server) setPlatform({ generatorLoader: server.loader, generatorMinecraft: server.minecraft });
    for (const id of ["generatorLoader", "generatorMinecraft"]) $(id).disabled = busy || Boolean(server);
    // The loader's own version is derived from the pair above, never chosen.
    $("generatorLoaderVersion").disabled = true;
  };
  $("generatorMinecraft").addEventListener("change", () => { setPlatform(); persistSettings(); });
  $("generatorLoader").addEventListener("change", () => { setPlatform(); persistSettings(); });
  document.querySelectorAll("[data-go-dependencies]").forEach((button) => button.addEventListener("click", () => navigateTo("dependencies")));
  document.querySelectorAll("[data-go-pack]").forEach((button) => button.addEventListener("click", () => navigateTo("overview")));
  document.querySelectorAll("[data-dependency]").forEach((button) => button.addEventListener("click", async () => {
    try { await nativeInvoke("open_dependency", { name: button.dataset.dependency }); } catch (error) { report(error); }
  }));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || getBusy()) return;
    if (!catalog.length) { navigateTo("dependencies"); showToast(t("В этой сборке нет встроенных агентов"), "error"); return; }
    setBusy(true);
    $("generatorResult").hidden = true;
    try {
      const template = catalog.find((entry) => entry.minecraft === $("generatorMinecraft").value && entry.loader === $("generatorLoader").value);
      if (!template) throw new Error(t("Для этого сочетания нет встроенного агента."));
      const result = await nativeInvoke("save_agent", {
        request: { templateId: template.id, loaderVersion: $("generatorLoaderVersion").value },
        dialogTitle: t("Выберите папку для мода UDMC")
      });
      if (!result) return;
      persistSettings();
      $("generatorResult").replaceChildren();
      const title = document.createElement("strong"); title.textContent = t("Мод сохранён");
      const path = document.createElement("code"); path.textContent = result.directory;
      const file = document.createElement("p"); file.textContent = result.file;
      const next = document.createElement("p");
      next.textContent = t("Положите этот файл в папку mods сервера и запустите его. Тот же файл раздайте игрокам — он один на всех.");
      $("generatorResult").append(title, path, file, next);
      $("generatorResult").hidden = false;
      $("generatorResult").scrollIntoView({ block: "nearest", behavior: "smooth" });
      showToast(t("Мод сохранён"));
    } catch (error) { report(error); } finally { setBusy(false); }
  });

  async function load() {
    const native = Boolean(window.__TAURI__?.core?.invoke);
    let status = { version: t("предпросмотр"), templates: 0, webview: false, credentialStore: false };
    if (native) {
      try {
        const result = await nativeInvoke("generator_catalog");
        catalog = result.templates;
        status = await nativeInvoke("dependency_status");
      } catch (error) { report(error); }
    }
    $("appVersion").textContent = `UDMC Control ${status.version}`;
    $("dependencyAppVersion").textContent = status.version;
    setPlatform(saved || {});
    syncLock();
    const rows = [
      ["app-window", "Microsoft Edge WebView2", t("Установщик загрузит среду, если её нет в Windows."), status.webview ? t("Работает") : t("Предпросмотр")],
      ["package", t("Шаблоны агентов"), catalog.length ? catalog.map((t) => `${loaderLabel(t.loader)} ${t.minecraft}`).join(" · ") : t("Нужна полная сборка Windows-приложения."), catalog.length ? t("Встроены") : t("Недоступны")],
      ["languages", "Fabric Resource Loader", t("Загрузка переводов игры. Небольшие модули Fabric включены в JAR; отдельно устанавливать их не нужно. Apache-2.0."), catalog.length ? t("Встроен") : t("Недоступно")],
      ["shield-check", t("Ed25519, SHA-256 и ZIP"), t("Проверка подписей и файлов сборки."), native ? t("Встроены") : t("В Windows-сборке")],
      ["terminal", "RCON", t("Без отдельной программы или Java на компьютере администратора."), native ? t("Встроен") : t("В Windows-сборке")],
      ["cloud-download", t("Modrinth и HTTPS"), t("Каталог модов, проверка SHA-512. Использует защищённые соединения Windows; нужен интернет."), native ? t("Встроен") : t("В Windows-сборке")],
      ["key-round", t("Хранилище Windows"), t("Ключи доступа к серверам и сохранённый пароль RCON."), status.credentialStore ? t("Подключено") : t("Недоступно")]
    ];
    $("bundledDependencies").replaceChildren();
    for (const [icon, name, text, state] of rows) {
      const row = document.createElement("article"); row.className = "dependency-row";
      const graphic = document.createElement("i"); graphic.dataset.lucide = icon;
      const copy = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = name;
      const detail = document.createElement("small"); detail.textContent = text; copy.append(title, detail);
      const badge = document.createElement("span"); badge.className = "state-badge neutral"; badge.textContent = state;
      row.append(graphic, copy, badge); $("bundledDependencies").append(row);
    }
    window.lucide?.createIcons();
    onFieldsChanged();
  }
  load().catch(report);
  return { templates: () => catalog, persistSettings, setPlatform, syncLock };
}
