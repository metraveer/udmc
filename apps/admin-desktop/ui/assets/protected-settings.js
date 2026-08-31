import { t } from "./i18n.js";
import { normalizeAddress, connectionDefaults } from "./connection.js";
import { updatePlatformControls } from "./platform.js";
import { formatAppError } from "./http.js";

export const protectedGroups = {
  connection: {
    title: t("Изменить адрес UDMC"),
    warning: t("При смене адреса подключение будет сброшено. Проверьте, что новый адрес доступен панели и игрокам. Уже выданные JAR сохранят старый адрес до их замены."),
    fields: [["serverUrlInput", t("Адрес UDMC")], ["allowHttpConnection", t("Доверенная сеть: разрешить HTTP без шифрования")]]
  },
  token: {
    title: t("Изменить ключ подключения"),
    warning: t("Неверный ключ лишит эту панель доступа. Ключи проекта на сервере не меняются. Для другого администратора используйте приглашение владельца."),
    fields: [["tokenInput", t("Ключ владельца или устройства")]]
  },
  platform: {
    title: t("Изменить совместимость агентов"),
    warning: t("Другой Minecraft может потребовать другой Java, загрузчика и модов. Это настройка новых JAR, а не обновление существующей игры или сервера."),
    fields: [["generatorLoader", t("Загрузчик")], ["generatorMinecraft", "Minecraft"], ["generatorLoaderVersion", t("Версия загрузчика")]]
  },
  rcon: {
    title: t("Изменить подключение RCON"),
    warning: t("Параметры должны совпадать с server.properties. Изменение адреса направит будущие команды на другой сервер. RCON не шифруется: используйте доверенную сеть или VPN."),
    fields: [["rconEnabledInput", t("Использовать RCON для консоли")], ["rconHostInput", t("Домен или IP")], ["rconPortInput", t("Порт")], ["rconPasswordInput", t("Пароль RCON")], ["rememberRconPasswordInput", t("Запомнить пароль в Windows")]]
  }
};

const validPort = value => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t("Порт должен быть целым числом от 1 до 65535."));
  return String(port);
};

export function validateProtectedValues(group, input, { serverUrl, templates = [] } = {}) {
  if (!Object.hasOwn(protectedGroups, group)) throw new Error(t("Неизвестная настройка."));
  const values = Object.fromEntries(protectedGroups[group].fields.map(([id]) => [id, input[id]]));
  if (group === "connection") {
    values.serverUrlInput = normalizeAddress(values.serverUrlInput);
    const defaults = connectionDefaults(values.serverUrlInput);
    values.allowHttpConnection = !defaults.encrypted && values.allowHttpConnection === true;
    if (!defaults.local && !defaults.encrypted && !values.allowHttpConnection) throw new Error(t("Для этого адреса нужен HTTPS или явное разрешение HTTP в доверенной сети."));
    if (!defaults.encrypted && [25565, 25575].includes(defaults.apiPort)) throw new Error(t("Укажите порт UDMC, а не стандартный порт Minecraft или RCON."));
  } else if (group === "token") {
    values.tokenInput = String(values.tokenInput || "").trim();
    if (!/^[\x21-\x7e]{1,1024}$/.test(values.tokenInput)) throw new Error(t("Введите ключ подключения без пробелов и переносов строк."));
  } else if (group === "platform") {
    const template = templates.find(t => t.minecraft === values.generatorMinecraft && t.loader === values.generatorLoader);
    if (!template) throw new Error(t("Выберите версию из встроенного каталога агентов."));
    values.generatorLoader = template.loader;
    values.generatorLoaderVersion = template.loaderVersion;
  } else if (group === "rcon") {
    values.rconEnabledInput = values.rconEnabledInput === true;
    values.rememberRconPasswordInput = values.rememberRconPasswordInput === true;
    values.rconHostInput = String(values.rconHostInput || "").trim();
    values.rconPortInput = validPort(values.rconPortInput);
    values.rconPasswordInput = String(values.rconPasswordInput || "");
    if (values.rconEnabledInput) {
      const host = values.rconHostInput;
      if (!host || /[\s/\\?#@]/.test(host) || host.includes("://") || (host.includes(":") && !/^\[[\da-f:]+\]$/i.test(host))) throw new Error(t("Введите домен или IP без протокола и порта. Порт задаётся отдельно."));
      if (!values.rconPasswordInput) throw new Error(t("Введите пароль RCON."));
    }
  }
  return values;
}

export function initProtectedSettings({ getBusy, getBinding, getContext, onApply, canEdit = () => true, showToast }) {
  const $ = id => document.getElementById(id);
  const dialog = $("protectedSettingsDialog");
  const form = $("protectedSettingsForm");
  const container = $("protectedSettingsFields");
  let editing = null;
  let saving = false;
  let controls = {};
  const read = source => Object.fromEntries(Object.entries(source).map(([id, control]) => [id, control.type === "checkbox" ? control.checked : control.value]));
  const current = group => read(Object.fromEntries(protectedGroups[group].fields.map(([id]) => [id, $(id)])));
  const fingerprint = values => JSON.stringify(values);
  function syncLocks() {
    for (const [group, definition] of Object.entries(protectedGroups)) {
      for (const [id] of definition.fields) {
        const control = $(id);
        control.dataset.protectedSetting = group;
        if (control.tagName === "SELECT" || control.type === "checkbox") control.disabled = true;
        else control.readOnly = true;
      }
    }
    document.querySelectorAll("[data-edit-setting]").forEach(button => {
      const group = button.dataset.editSetting || "connection";
      button.disabled = saving || getBusy() || !canEdit(group);
    });
  }
  function updateDraft() {
    if (!editing) return;
    const field = id => controls[id];
    if (editing.group === "platform") {
      updatePlatformControls({ loader: field("generatorLoader"), minecraft: field("generatorMinecraft"), version: field("generatorLoaderVersion") }, getContext().templates);
      field("generatorLoaderVersion").disabled = true;
    }
    if (editing.group === "rcon") for (const [id, control] of Object.entries(controls)) {
      if (id !== "rconEnabledInput") control.disabled = !field("rconEnabledInput").checked;
    }
    const changed = fingerprint(read(controls)) !== editing.original;
    $("protectedSettingsApply").disabled = saving || !changed;
  }
  function open(group, preset = {}) {
    if (getBusy() || saving || dialog.open || !canEdit(group)) return;
    const definition = protectedGroups[group];
    editing = { group, original: fingerprint(current(group)), binding: getBinding() };
    $("protectedSettingsTitle").textContent = definition.title;
    $("protectedSettingsWarning").textContent = definition.warning;
    $("protectedSettingsError").textContent = "";
    controls = {};
    container.replaceChildren(...definition.fields.map(([id, title]) => {
      const original = $(id);
      const control = original.cloneNode(true);
      control.id = `edit-${id}`;
      control.removeAttribute("data-protected-setting");
      control.disabled = false; control.readOnly = false;
      if (["tokenInput", "rconPasswordInput"].includes(id)) control.type = "password";
      control.value = Object.hasOwn(preset, id) ? preset[id] : original.value;
      control.checked = Object.hasOwn(preset, id) ? preset[id] : original.checked;
      control.autocomplete = "off";
      const label = document.createElement("label");
      label.className = control.type === "checkbox" ? "check-row" : "field";
      const text = document.createElement("span"); text.textContent = title;
      label.append(...(control.type === "checkbox" ? [control, text] : [text, control]));
      controls[id] = control;
      return label;
    }));
    updateDraft(); dialog.showModal();
    Object.values(controls).find(control => !control.disabled)?.focus();
  }
  form.addEventListener("input", event => {
    $("protectedSettingsError").textContent = "";
    if (editing?.group === "connection" && event.target === controls.serverUrlInput) controls.allowHttpConnection.checked = false;
    updateDraft();
  });
  form.addEventListener("change", updateDraft);
  $("protectedSettingsCancel").addEventListener("click", () => { if (!saving) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    for (const control of Object.values(controls)) if (control.type === "password") control.value = "";
    container.replaceChildren(); controls = {}; editing = null;
    $("protectedSettingsError").textContent = "";
    syncLocks();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!editing || saving || getBusy()) return;
    const { group, original, binding } = editing;
    try {
      if (!canEdit(group) || binding !== getBinding() || fingerprint(current(group)) !== original) throw new Error(t("Настройки изменились, пока окно было открыто. Закройте его и проверьте актуальные значения."));
      const values = validateProtectedValues(group, read(controls), getContext());
      if (fingerprint(values) === original) { dialog.close(); return; }
      saving = true; syncLocks();
      form.querySelectorAll("input,select,button").forEach(control => { control.disabled = true; });
      await onApply(group, values);
      dialog.close(); showToast(group === "rcon" ? t("Настройки RCON сохранены") : t("Настройки применены"));
    } catch (error) { $("protectedSettingsError").textContent = formatAppError(error); }
    finally {
      saving = false;
      form.querySelectorAll("input,select,button").forEach(control => { control.disabled = false; });
      updateDraft(); syncLocks();
    }
  });
  document.querySelectorAll("[data-edit-setting]").forEach(button => button.addEventListener("click", () => open(button.dataset.editSetting)));
  syncLocks();
  return { syncLocks, isEditing: () => dialog.open, open };
}
