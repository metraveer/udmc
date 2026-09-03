import { t, getLocale } from "./i18n.js";
import { findInDraft, findOnServer, sideAfter } from "./draft-match.js";
import { inspectFile } from "./file-intake.js";
import { catalogLink, descriptionFragment } from "./catalog-content.js";
import { loaderLabel } from "./platform.js";
import { formatAgentError } from "./http.js";
import { profileInvoke } from "./server-profiles.js";

const $ = id => document.getElementById(id);
const node = (tag, text, className = "") => {
  const value = document.createElement(tag); value.textContent = text; value.className = className; return value;
};
const sizes = n => t("{0} МиБ", (n / 1024 / 1024).toFixed(1));
const sides = { client: t("Клиент"), server: t("Сервер"), both: t("Клиент + сервер") };
const releaseTypes = { 1: t("Релиз"), 2: t("Бета"), 3: t("Альфа") };
const invoke = (name, args) => {
  if (!window.__TAURI__?.core?.invoke) throw new Error(t("Каталог доступен в Windows-приложении UDMC Control."));
  return window.__TAURI__.core.invoke(name, args);
};

export function initCurseforge({ getContext, getBusy, setBusy, upload, refresh, showToast, getServerFiles, removeFromServer }) {
  const readSecret = name => profileInvoke("credential_read", { name });
  const writeSecret = (name, value) => profileInvoke("credential_write", { name, value });
  let operation = 0, writing = false, page = 1, hasMore = false, apiKey = null, keyLoaded = false;
  let result = null, selected = null, files = null, prepared = null;
  const signature = () => JSON.stringify(getContext());
  const current = op => { if (op !== operation) throw Object.assign(new Error("Cancelled"), { cancelled: true }); };
  const status = text => { $("curseforgeStatus").textContent = text; };
  function render() {
    const context = getContext();
    $("curseforgePlatform").textContent = context ? `${loaderLabel(context.loader)} ${context.minecraft}` : t("Просмотр без подключения");
    $("curseforgeKeySetup").hidden = Boolean(apiKey);
    $("curseforgeCatalog").hidden = !apiKey;
    $("curseforgePanel").querySelectorAll("input,select,button").forEach(el => { el.disabled = getBusy(); });
    $("curseforgePrevious").disabled = getBusy() || page <= 1;
    $("curseforgeNext").disabled = getBusy() || !hasMore;
    $("curseforgeCancel").disabled = writing;
    $("curseforgeSelection").hidden = !selected;
    $("curseforgePrepared").hidden = !prepared;
    $("curseforgeInstall").disabled = getBusy() || !prepared || !context?.modValidation || !$("curseforgeRights").checked || !$("curseforgeSide").value;
    $("curseforgeResults").hidden = Boolean(selected);
  }
  function clearSelection() {
    prepared = null; selected = null; files = null;
    $("curseforgeRights").checked = false; $("curseforgeSide").replaceChildren();
    $("curseforgeDescription").replaceChildren(); $("curseforgeFile").replaceChildren();
    $("curseforgeProgress").hidden = true;
  }
  function report(error) {
    if (error?.cancelled) return;
    const message = formatAgentError(error); status(message); showToast(message, "error");
  }
  async function loadKey() {
    if (keyLoaded) return;
    keyLoaded = true;
    try { apiKey = (await readSecret("curseforge-api-key")) || null; }
    catch { apiKey = null; }
    render();
    if (apiKey) status(t("Введите название мода или откройте популярные."));
  }
  async function search(nextPage = 1) {
    if (getBusy() || !apiKey) return;
    const op = ++operation;
    clearSelection(); setBusy(true); render(); status(t("Загрузка каталога CurseForge..."));
    try {
      const context = getContext();
      const value = await invoke("curseforge_search", {
        key: apiKey, query: $("curseforgeQuery").value.trim(), page: nextPage,
        gameVersion: context?.minecraft || null, loader: context?.loader || null
      });
      current(op);
      result = value; page = nextPage; hasMore = value.hasMore === true;
      $("curseforgeResults").replaceChildren();
      for (const entry of value.mods || []) {
        const row = node("article", "", "catalog-row"), copy = node("div", "", "catalog-copy");
        const icon = document.createElement("img");
        icon.className = "catalog-icon"; icon.alt = ""; icon.loading = "lazy"; icon.referrerPolicy = "no-referrer";
        if (typeof entry.logoUrl === "string") icon.src = entry.logoUrl; else icon.hidden = true;
        icon.addEventListener("error", () => { icon.hidden = true; });
        copy.append(node("strong", entry.name), node("small", entry.summary || ""));
        copy.append(node("small", t("Загрузок: {0}", Number(entry.downloads || 0).toLocaleString(getLocale()))));
        if (entry.distributionAllowed) {
          const choose = node("button", t("Выбрать"), "button subtle"); choose.type = "button";
          choose.addEventListener("click", () => select(entry));
          row.append(icon, copy, choose);
        } else {
          copy.append(node("small", t("Автор запретил раздачу через API: установка недоступна."), "file-error"));
          row.append(icon, copy);
        }
        $("curseforgeResults").append(row);
      }
      status(value.mods?.length
        ? t("Найдено: {0}. Показаны {1}–{2}.{3}", value.total, (page - 1) * 20 + 1, (page - 1) * 20 + value.mods.length,
          !getContext()?.url ? t(" Просмотр без подключения. Для добавления подключите агент сервера.") : !getContext()?.modValidation ? t(" Для добавления обновите серверный агент.") : "")
        : t("Для этой версии Minecraft ничего не найдено."));
    } catch (error) { if (op === operation) { result = null; hasMore = false; $("curseforgeResults").replaceChildren(); report(error); } }
    finally { if (op === operation) { setBusy(false); render(); } }
  }
  async function select(entry) {
    if (getBusy() || !apiKey) return;
    const op = ++operation;
    clearSelection(); selected = entry; setBusy(true); render(); status(t("Загрузка файлов мода..."));
    try {
      const context = getContext();
      const value = await invoke("curseforge_files", {
        key: apiKey, modId: entry.id,
        gameVersion: context?.minecraft || null, loader: context?.loader || null
      });
      current(op);
      files = (value.files || []).filter(file => file.downloadable);
      $("curseforgeModTitle").textContent = entry.name;
      $("curseforgeFile").replaceChildren(...files.map(file =>
        new Option(`${file.displayName || file.fileName} · ${releaseTypes[file.releaseType] || t("Файл")} · ${sizes(file.size)}`, String(file.id))));
      $("curseforgeDescription").replaceChildren(descriptionFragment(value.description));
      if (!files.length) status(t("У этого мода нет подходящих файлов для вашей версии и загрузчика, либо автор запретил раздачу через API."));
      else status(t("Выберите файл. Обязательных зависимостей у файла: {0}. CurseForge не устанавливает их автоматически: проверка состава укажет недостающие.", files[0].requiredDependencies));
      render(); $("curseforgeSelection").scrollIntoView({ block: "start" });
    } catch (error) { if (op === operation) { clearSelection(); report(error); } }
    finally { if (op === operation) { setBusy(false); render(); } }
  }
  $("curseforgeKeyForm").addEventListener("submit", async event => {
    event.preventDefault(); if (getBusy()) return;
    const value = $("curseforgeKeyInput").value.trim();
    if (!value) return;
    setBusy(true);
    try {
      await writeSecret("curseforge-api-key", value);
      apiKey = value; $("curseforgeKeyInput").value = "";
      showToast(t("Ключ CurseForge сохранён в защищённом хранилище Windows"));
    } catch (error) { report(error); return; }
    finally { setBusy(false); render(); }
    await search();
  });
  $("curseforgeKeyHelp").addEventListener("click", () => {
    invoke("open_catalog_link", { url: "https://console.curseforge.com/" }).catch(report);
  });
  $("curseforgeForgetKey").addEventListener("click", async () => {
    if (getBusy() || !apiKey) return;
    setBusy(true);
    try {
      await writeSecret("curseforge-api-key", null);
      apiKey = null; operation++; clearSelection(); result = null; $("curseforgeResults").replaceChildren();
      status(t("Ключ удалён. Сохраните новый ключ, чтобы пользоваться каталогом."));
    } catch (error) { report(error); }
    finally { setBusy(false); render(); }
  });
  $("curseforgeSearchForm").addEventListener("submit", event => { event.preventDefault(); search(); });
  $("curseforgePrevious").addEventListener("click", () => search(page - 1));
  $("curseforgeNext").addEventListener("click", () => search(page + 1));
  $("curseforgeCancel").addEventListener("click", () => {
    if (writing) return;
    operation++; clearSelection(); setBusy(false); render(); status(t("Выбор отменён. Уже отправленные файлы остаются в черновике."));
  });
  $("curseforgeFile").addEventListener("change", () => {
    prepared = null; $("curseforgeRights").checked = false;
    const file = files?.find(value => String(value.id) === $("curseforgeFile").value);
    if (file) status(t("Выберите файл. Обязательных зависимостей у файла: {0}. CurseForge не устанавливает их автоматически: проверка состава укажет недостающие.", file.requiredDependencies));
    render();
  });
  $("curseforgeRights").addEventListener("change", render);
  $("curseforgeSide").addEventListener("change", render);
  $("curseforgePrepare").addEventListener("click", async () => {
    if (getBusy() || !selected || !files) return;
    const file = files.find(value => String(value.id) === $("curseforgeFile").value);
    if (!file) return;
    const op = ++operation, binding = signature(), context = getContext();
    prepared = null; $("curseforgeRights").checked = false;
    setBusy(true); render(); $("curseforgeProgress").hidden = false; status(t("Скачивание и проверка: {0}", file.fileName));
    try {
      const data = await invoke("curseforge_download", { key: apiKey, modId: selected.id, fileId: file.id });
      current(op);
      if (signature() !== binding) throw new Error(t("Подключение или черновик изменились. Подготовьте файл заново."));
      const blob = new File([new Uint8Array(data)], file.fileName, { type: "application/java-archive" });
      if (blob.size !== file.size) throw new Error(t("Размер файла отличается от каталога CurseForge."));
      const metadata = await inspectFile(blob, context?.loader);
      current(op);
      if (metadata.inspectionError || !metadata.modId) throw new Error(metadata.inspectionError || t("В JAR нет ID мода."));
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(v => v.toString(16).padStart(2, "0")).join("");
      current(op);
      const restricted = metadata.sideKnown && ["client", "server"].includes(metadata.side);
      $("curseforgeSide").replaceChildren(...(restricted ? [metadata.side] : ["both", "client", "server"]).map(side => new Option(sides[side], side)));
      if (!metadata.sideKnown) { $("curseforgeSide").prepend(new Option(t("Выберите назначение"), "")); $("curseforgeSide").value = ""; }
      $("curseforgeJarSummary").textContent = `${metadata.modIds.join(", ")} · ${sizes(blob.size)} · ${metadata.inference}`;
      prepared = { file: blob, sha256, binding, modIds: metadata.modIds, source: { provider: "curseforge", projectId: String(selected.id), versionId: String(file.id), environment: restricted ? `${metadata.side}_only` : metadata.sideKnown ? "jar_universal" : "manual" } };
      status(t("JAR прочитан. Зависимости и версии проверит серверный агент перед публикацией."));
    } catch (error) { if (op === operation) report(error); }
    finally { if (op === operation) { $("curseforgeProgress").hidden = true; setBusy(false); render(); } }
  });
  $("curseforgeInstall").addEventListener("click", async () => {
    if (getBusy() || !prepared || !getContext()?.modValidation || !$("curseforgeRights").checked || !$("curseforgeSide").value) return;
    const entry = prepared, side = $("curseforgeSide").value;
    let sent = false;
    try {
      if (signature() !== entry.binding) throw new Error(t("Подключение или черновик изменились. Подготовьте файл заново."));
      // The same mod already in the draft is replaced, not joined; the same mod outside the
      // pack on the server is taken off it on publish, with a backup. Both are said afterwards.
      const match = findInDraft(getContext().files, { modIds: entry.modIds || [], provider: "curseforge", projectId: entry.source.projectId, path: `mods/${entry.file.name}`, sha256: entry.sha256 });
      const kept = match ? sideAfter(match.file.side, side) : side;
      const same = Boolean(match?.same && kept === match.file.side);
      const replace = match && !same && match.file.path.toLowerCase() !== `mods/${entry.file.name}`.toLowerCase() ? match.file.path : null;
      const server = findOnServer(await getServerFiles(), { modIds: entry.modIds || [] });
      writing = true; setBusy(true); render(); status(t("Отправка в черновик: {0}", entry.file.name));
      if (!same) { await upload(entry.file, kept, entry.source, replace); sent = true; }
      if (server && !server.removalPending) { await removeFromServer(server.path, server.sha256); sent = true; }
      prepared = null;
      status(same ? t("Этот файл уже есть в черновике.") : [t("Файл добавлен в черновик. Проверьте зависимости во вкладке «Проверка» перед публикацией."),
        replace ? t("Заменён {0}.", replace) : "", server && !server.removalPending ? t("Будет удалён с сервера при публикации: {0}.", server.path) : ""].filter(Boolean).join(" "));
      showToast(sent ? t("Черновик обновлён. Публикации не было.") : t("Черновик не изменился: этот файл уже там."));
    } catch (error) { report(error); }
    finally {
      try { if (sent) await refresh(); } finally { writing = false; setBusy(false); render(); }
    }
  });
  $("curseforgeModLink").addEventListener("click", () => {
    const url = selected && catalogLink(selected.websiteUrl);
    if (url) invoke("open_catalog_link", { url }).catch(report);
  });
  $("curseforgeDescription").addEventListener("click", event => {
    const link = event.target.closest("a"); if (!link) return;
    event.preventDefault(); const url = catalogLink(link.getAttribute("href"));
    if (url) invoke("open_catalog_link", { url }).catch(report);
  });
  render();
  return { onOpen: force => { render(); loadKey().then(() => { if (force && result && !getBusy()) return search(page); }); } };
}
