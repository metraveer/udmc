import { t } from "./i18n.js";
const REGISTRY = "udmc-server-profiles-v1";
const legacy = { id: "legacy", name: t("Мой сервер") };
export const validProfileId = value => value === "legacy" || typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

export function createProfileStore(storage, makeId = () => crypto.randomUUID()) {
  let state, problem = null;
  try {
    const raw = storage.getItem(REGISTRY);
    state = raw === null ? null : JSON.parse(raw);
    if (raw !== null && (!state || !Array.isArray(state.profiles) || !state.profiles.length || state.profiles.length > 64
      || state.profiles.some(p => !validProfileId(p.id) || typeof p.name !== "string" || !p.name.trim() || p.name.length > 80)
      || new Set(state.profiles.map(p => p.id)).size !== state.profiles.length
      || !state.profiles.some(p => p.id === state.active))) throw new Error("Invalid profile registry");
  } catch { state = null; problem = t("Список серверов повреждён или недоступен. Исходные данные не изменены. Подключение заблокировано до восстановления списка."); }
  state ||= { active: "legacy", profiles: [{ ...legacy }] };
  const writable = () => { if (problem) throw new Error(problem); };
  const save = next => { writable(); storage.setItem(REGISTRY, JSON.stringify(next)); state = next; };
  const name = value => {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 80) throw new Error(t("Название сервера: от 1 до 80 символов."));
    return value.trim();
  };
  const key = (key, profile = state.active) => profile === "legacy" || key === "udmc-device-name" ? key : `udmc-profile:${profile}:${key}`;
  const scopedStorage = profile => ({
    getItem: item => problem ? null : storage.getItem(key(item, profile)),
    setItem: (item, value) => { writable(); storage.setItem(key(item, profile), value); },
    removeItem: item => { writable(); storage.removeItem(key(item, profile)); }
  });
  return {
    error: () => problem,
    active: () => state.active,
    list: () => state.profiles.map(p => ({ ...p })),
    create(value) {
      if (state.profiles.length >= 64) throw new Error(t("Достигнут предел: 64 сервера."));
      const id = makeId();
      if (!validProfileId(id) || state.profiles.some(p => p.id === id)) throw new Error(t("Не удалось создать уникальный профиль."));
      save({ ...state, profiles: [...state.profiles, { id, name: name(value) }] });
      return id;
    },
    rename(id, value) {
      if (!state.profiles.some(p => p.id === id)) throw new Error(t("Сервер не найден."));
      save({ ...state, profiles: state.profiles.map(p => p.id === id ? { ...p, name: name(value) } : p) });
    },
    select(id) {
      if (!state.profiles.some(p => p.id === id)) throw new Error(t("Сервер не найден."));
      save({ ...state, active: id });
    },
    storage: {
      getItem: item => problem ? null : storage.getItem(key(item)),
      setItem: (item, value) => { writable(); storage.setItem(key(item), value); },
      removeItem: item => { writable(); storage.removeItem(key(item)); }
    },
    storageFor(profile) {
      if (!validProfileId(profile)) throw new Error(t("Профиль сервера недействителен."));
      return scopedStorage(profile);
    }
  };
}

export const serverProfiles = typeof window !== "undefined" ? createProfileStore(window.localStorage) : null;
const loadedProfile = serverProfiles?.active();
// Bind this document's callbacks to one profile until the reload completes.
export const profileStorage = serverProfiles?.storageFor(loadedProfile);

export function profileCommand(command, args = {}, profileId = loadedProfile) {
  if (!validProfileId(profileId)) throw new Error(t("Профиль сервера недействителен."));
  if (serverProfiles?.error() && ["credential_read", "credential_write", "generator_identity", "recover_identity", "generate_agents"].includes(command)) throw new Error(serverProfiles.error());
  if (profileId === "legacy") return args;
  if (["credential_read", "credential_write"].includes(command)) return { ...args, name: `profile:${profileId}:${args.name}` };
  if (["generator_identity", "recover_identity"].includes(command)) return { ...args, profileId };
  if (command === "generate_agents") return { ...args, request: { ...args.request, profileId } };
  return args;
}

export function profileInvoke(command, args = {}) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error(t("Учётные данные доступны в Windows-приложении UDMC Control."));
  return invoke(command, profileCommand(command, args));
}

export function initServerProfiles({ getBusy, hasLocalFiles, showToast, openSettings, beforeReload = () => {}, reload = () => window.location.reload() }) {
  const $ = id => document.getElementById(id);
  let target = null;
  const render = () => {
    $("serverProfileSelect").replaceChildren(...serverProfiles.list().map(p => new Option(p.name, p.id)));
    $("serverProfileSelect").value = serverProfiles.active();
    $("serverProfileName").value = serverProfiles.list().find(p => p.id === serverProfiles.active()).name;
  };
  function activate(id) {
    if (getBusy()) { render(); showToast(t("Дождитесь завершения текущей операции."), "error"); return; }
    if (id === serverProfiles.active()) return;
    target = id;
    if (hasLocalFiles()) { $("switchProfileDialog").showModal(); return; }
    try { beforeReload(); serverProfiles.select(id); reload(); }
    catch (error) { render(); showToast(error.message, "error"); }
  }
  $("serverProfileSelect").addEventListener("change", () => activate($("serverProfileSelect").value));
  $("addServerProfileButton").addEventListener("click", () => {
    if (getBusy()) return;
    $("newServerProfileName").value = ""; $("addProfileDialog").showModal(); $("newServerProfileName").focus();
  });
  $("addProfileForm").addEventListener("submit", event => {
    event.preventDefault(); if (getBusy()) return;
    try { const id = serverProfiles.create($("newServerProfileName").value); $("addProfileDialog").close(); activate(id); }
    catch (error) { showToast(error.message, "error"); }
  });
  $("serverProfileForm").addEventListener("submit", event => {
    event.preventDefault(); if (getBusy()) return;
    try { serverProfiles.rename(serverProfiles.active(), $("serverProfileName").value); render(); showToast(t("Название сервера сохранено")); }
    catch (error) { showToast(error.message, "error"); }
  });
  $("switchProfileForm").addEventListener("submit", event => {
    event.preventDefault(); if (getBusy() || !target) return;
    try { beforeReload(); serverProfiles.select(target); reload(); }
    catch (error) { render(); showToast(error.message, "error"); }
  });
  $("switchProfileDialog").addEventListener("close", () => { target = null; render(); });
  $("serverProfileSettingsButton").addEventListener("click", openSettings);
  $("serverProfileDialog").addEventListener("cancel", event => { if (getBusy()) event.preventDefault(); });
  render();
  if (serverProfiles.error()) {
    $("profileStorageError").textContent = serverProfiles.error(); $("profileStorageError").hidden = false;
    for (const control of [$("serverProfileSelect"), $("addServerProfileButton"), ...$("serverProfileForm").elements]) control.disabled = true;
  }
}
