import { t } from "./i18n.js";
import { normalizeAddress, connectionDefaults } from "./connection.js";
import { loaderLabel, updatePlatformControls } from "./platform.js";
import { profileStorage as localStorage, profileCommand } from "./server-profiles.js";
import { formatAppError } from "./http.js";

const $ = (id) => document.getElementById(id);
const nativeInvoke = (name, args) => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error(t("Эта операция доступна в Windows-приложении UDMC Control."));
  return invoke(name, profileCommand(name, args));
};

export function initGenerator({ navigateTo, showToast, onConnection, getConnection, getBusy, setBusy: setAppBusy, onFieldsChanged = () => {} }) {
  let catalog = [];
  let identityPackId = null;
  let busy = false;
  const form = $("generatorForm");
  const fields = ["generatorPackId", "generatorApiHost", "generatorApiPort", "generatorPortOverride", "generatorLoader", "generatorMinecraft"];
  const persistSettings = (overrides = {}) => localStorage.setItem("udmc-generator-settings", JSON.stringify(Object.fromEntries(fields.map(id => [id, Object.hasOwn(overrides, id) ? overrides[id] : $(id).type === "checkbox" ? $(id).checked : $(id).value]))));
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("udmc-generator-settings") || "null"); } catch { localStorage.removeItem("udmc-generator-settings"); }
  if (saved) for (const id of fields) {
    if (typeof saved[id] === "string" && $(id).type !== "checkbox") $(id).value = saved[id];
    if (typeof saved[id] === "boolean" && $(id).type === "checkbox") $(id).checked = saved[id];
  }
  const updateAddress = (reset = false) => {
    try {
      const defaults = connectionDefaults(getConnection().url);
      if (reset) {
        $("generatorApiHost").value = defaults.apiHost;
        $("generatorApiPort").value = defaults.apiPort;
        $("generatorPortOverride").checked = false;
      }
      if (!$("generatorPortOverride").checked) $("generatorApiPort").value = defaults.apiPort;
      $("generatorApiPortField").hidden = !$("generatorPortOverride").checked;
      $("generatorApiPort").required = $("generatorPortOverride").checked;
      $("generatorConnectionSummary").textContent = defaults.local
        ? t("Этот адрес работает только на одном компьютере. Для других игроков нужен внешний адрес или адрес VPN.")
        : defaults.encrypted ? t("Адрес выше → HTTPS-прокси → агент на порту {0}.", $("generatorApiPort").value)
          : t("Адрес выше → агент на порту {0}. HTTP не шифрует данные.", $("generatorApiPort").value);
    } catch { $("generatorConnectionSummary").textContent = t("Введите адрес, чтобы определить сетевые настройки."); }
  };
  if (saved?.generatorApiPort && !Object.hasOwn(saved, "generatorPortOverride")) {
    try { $("generatorPortOverride").checked = Number(saved.generatorApiPort) !== connectionDefaults(getConnection().url).apiPort; } catch { /* Address is validated on submission. */ }
  }
  updateAddress(!saved);
  $("serverUrlInput").addEventListener("input", () => updateAddress(true));
  $("serverUrlInput").addEventListener("change", () => updateAddress());
  $("generatorApiPort").addEventListener("input", () => updateAddress());
  $("generatorPortOverride").addEventListener("change", () => updateAddress());
  const report = (error) => showToast(formatAppError(error), "error");
  const setBusy = (value) => {
    busy = value;
    setAppBusy(value);
    form.querySelectorAll("input,select,button").forEach((input) => { input.disabled = value; });
    onFieldsChanged();
  };
  const showIdentity = (identity, packId) => {
    identityPackId = packId;
    $("generatorToken").value = identity.token;
    $("generatorFingerprint").textContent = identity.fingerprint;
    $("generatorIdentity").hidden = false;
  };
  const prepare = async () => {
    const packId = $("generatorPackId").value.trim();
    const identity = await nativeInvoke("generator_identity", { packId });
    showIdentity(identity, packId);
    return identity;
  };
  const setPlatform = (preferred = {}) => {
    const template = updatePlatformControls({ loader: $("generatorLoader"), minecraft: $("generatorMinecraft"), version: $("generatorLoaderVersion") }, catalog,
      { loader: preferred.generatorLoader, minecraft: preferred.generatorMinecraft });
    if (template) {
      $("generatorJava").textContent = t("Java {0}+ на сервере и у игроков", template.java);
    }
  };
  $("generatorMinecraft").addEventListener("change", setPlatform);
  $("generatorLoader").addEventListener("change", setPlatform);
  $("generatorPackId").addEventListener("input", () => {
    identityPackId = null;
    $("generatorToken").value = "";
    $("generatorIdentity").hidden = true;
    $("generatorResult").hidden = true;
  });
  $("prepareIdentityButton").addEventListener("click", async () => {
    if (busy || getBusy()) return;
    setBusy(true);
    try { await prepare(); } catch (error) { report(error); } finally { setBusy(false); }
  });
  $("copyGeneratorToken").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("generatorToken").value); showToast(t("Токен скопирован")); } catch (error) { report(error); }
  });
  $("recoverIdentityButton").addEventListener("click", async () => {
    if (busy || getBusy()) return;
    setBusy(true);
    try {
      const result = await nativeInvoke("recover_identity", {
        dialogTitle: t("Выберите серверный JAR UDMC"),
        dialogFilter: t("Серверный JAR UDMC")
      });
      if (result) {
        $("generatorPackId").value = result.packId;
        $("packNameInput").value = result.packName;
        $("generatorPackNameLabel").textContent = result.packName;
        await onConnection(result.serverUrl, result.token, result.allowInsecureHttp);
        if (["127.0.0.1", "0.0.0.0"].includes(result.apiHost)) $("generatorApiHost").value = result.apiHost;
        if (Number.isInteger(result.apiPort)) $("generatorApiPort").value = result.apiPort;
        $("generatorPortOverride").checked = Number(result.apiPort) !== connectionDefaults(result.serverUrl).apiPort;
        const recoveredTemplate = catalog.find((template) => template.id === result.templateId);
        if (recoveredTemplate) setPlatform({ generatorLoader: recoveredTemplate.loader, generatorMinecraft: recoveredTemplate.minecraft });
        showIdentity(result, result.packId);
        updateAddress();
        persistSettings();
        showToast(t("Ключи проекта восстановлены"));
      }
    } catch (error) { report(error); } finally { setBusy(false); }
  });
  document.querySelectorAll("[data-go-dependencies]").forEach((button) => button.addEventListener("click", () => navigateTo("dependencies")));
  document.querySelectorAll("[data-go-pack]").forEach((button) => button.addEventListener("click", () => navigateTo("overview")));
  $("packNameInput").addEventListener("input", () => { $("generatorPackNameLabel").textContent = $("packNameInput").value; });
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
      const serverUrl = normalizeAddress(getConnection().url);
      updateAddress();
      const request = {
        packId: $("generatorPackId").value.trim(), packName: $("packNameInput").value.trim() || t("Основная сборка"), serverUrl,
        apiHost: $("generatorApiHost").value, apiPort: Number($("generatorApiPort").value),
        templateId: template.id, loaderVersion: $("generatorLoaderVersion").value,
        allowInsecureHttp: getConnection().allowHttp
      };
      const result = await nativeInvoke("generate_agents", {
        request,
        dialogTitle: t("Выберите папку для серверного JAR UDMC")
      });
      if (!result) return;
      if (identityPackId !== request.packId) await prepare();
      persistSettings();
      $("generatorResult").replaceChildren();
      const title = document.createElement("strong"); title.textContent = t("Серверный JAR готов");
      const path = document.createElement("code"); path.textContent = result.directory;
      const files = document.createElement("p"); files.textContent = result.serverFile;
      const connection = document.createElement("p"); connection.textContent = t("Ключ сохранён. Установите этот JAR на сервер и подключитесь. Клиентский JAR передастся автоматически; ссылка для игроков появится здесь.");
      await onConnection(request.serverUrl, $("generatorToken").value, request.allowInsecureHttp);
      $("generatorResult").append(title, path, files, connection);
      $("generatorResult").hidden = false;
      $("generatorResult").scrollIntoView({ block: "nearest", behavior: "smooth" });
      showToast(t("Серверный JAR сформирован"));
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
    $("generatorAvailability").textContent = catalog.length ? t("Профилей: {0}", catalog.length) : native ? t("Шаблоны не включены") : t("Нужно Windows-приложение");
    $("generatorAvailability").className = `state-badge ${catalog.length ? "online" : "warning"}`;
    setPlatform(saved || {});
    const rows = [
      ["app-window", "Microsoft Edge WebView2", t("Установщик загрузит среду, если её нет в Windows."), status.webview ? t("Работает") : t("Предпросмотр")],
      ["package", t("Шаблоны агентов"), catalog.length ? catalog.map((t) => `${loaderLabel(t.loader)} ${t.minecraft}`).join(" · ") : t("Нужна полная сборка Windows-приложения."), catalog.length ? t("Встроены") : t("Недоступны")],
      ["languages", "Fabric Resource Loader", t("Загрузка переводов игры. Небольшие модули Fabric включены в JAR; отдельно устанавливать их не нужно. Apache-2.0."), catalog.length ? t("Встроен") : t("Недоступно")],
      ["shield-check", t("Ed25519, SHA-256 и ZIP"), t("Подпись обновлений, проверка файлов и генерация JAR."), native ? t("Встроены") : t("В Windows-сборке")],
      ["terminal", "RCON", t("Без отдельной программы или Java на компьютере администратора."), native ? t("Встроен") : t("В Windows-сборке")],
      ["cloud-download", t("Modrinth и HTTPS"), t("Каталог модов, проверка SHA-512. Использует защищённые соединения Windows; нужен интернет."), native ? t("Встроен") : t("В Windows-сборке")],
      ["key-round", t("Хранилище Windows"), t("Ключи проектов, токены и сохранённый пароль RCON."), status.credentialStore ? t("Подключено") : t("Недоступно")]
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
  return { templates: () => catalog, persistSettings, setPlatform };
}
