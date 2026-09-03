import { t } from "./i18n.js";
import { findInDraft, findOnServer, sideAfter } from "./draft-match.js";
import { inspectFile } from "./file-intake.js";
import { catalogLink, descriptionFragment } from "./catalog-content.js";
import { loaderLabel } from "./platform.js";
import { formatAgentError } from "./http.js";

const $ = id => document.getElementById(id);
const node = (tag, text, className = "") => {
  const value = document.createElement(tag); value.textContent = text; value.className = className; return value;
};
const sizes = n => t("{0} МиБ", (n / 1024 / 1024).toFixed(1));
const sides = { client: t("Клиент"), server: t("Сервер"), both: t("Клиент + сервер") };
const invoke = (name, args) => {
  if (!window.__TAURI__?.core?.invoke) throw new Error(t("Каталог доступен в Windows-приложении UDMC Control."));
  return window.__TAURI__.core.invoke(name, args);
};
export const releaseJars = release => (release.assets || []).filter(asset =>
  Number.isSafeInteger(asset.id) && asset.id > 0 && asset.state === "uploaded"
  && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 64 * 1024 * 1024
  && typeof asset.name === "string" && asset.name.length <= 200 && /^[^<>:"/\\|?*\x00-\x1f]+\.jar$/i.test(asset.name)
  && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(asset.name)
  && !/-(sources|javadoc|dev)\.jar$/i.test(asset.name));

export function initGithub({ getContext, getBusy, setBusy, upload, refresh, showToast, getServerFiles, removeFromServer }) {
  let operation = 0, writing = false, page = 1, hasMore = false, result = null, selected = null, prepared = null;
  const signature = () => JSON.stringify(getContext());
  const current = op => { if (op !== operation) throw Object.assign(new Error("Cancelled"), { cancelled: true }); };
  const status = text => { $("githubStatus").textContent = text; };
  function render() {
    const context = getContext();
    $("githubPlatform").textContent = context ? `${loaderLabel(context.loader)} ${context.minecraft}` : t("Просмотр без подключения");
    $("githubPanel").querySelectorAll("input,select,button").forEach(el => { el.disabled = getBusy(); });
    $("githubPrevious").disabled = getBusy() || page <= 1;
    $("githubNext").disabled = getBusy() || !hasMore;
    $("githubCancel").disabled = writing;
    $("githubSelection").hidden = !selected;
    $("githubPrepared").hidden = !prepared;
    $("githubInstall").disabled = getBusy() || !prepared || !context?.modValidation || !$("githubRights").checked || !$("githubSide").value;
    $("githubResults").hidden = Boolean(selected);
  }
  function clearSelection() {
    prepared = null; selected = null;
    $("githubRights").checked = false; $("githubSide").replaceChildren();
    $("githubDescription").replaceChildren(); $("githubAsset").replaceChildren();
    $("githubProgress").hidden = true;
  }
  function report(error) {
    if (error?.cancelled) return;
    const message = formatAgentError(error); status(message); showToast(message, "error");
  }
  async function search(nextPage = 1) {
    if (getBusy()) return;
    const op = ++operation;
    clearSelection(); setBusy(true); render(); status(t("Загрузка релизов GitHub..."));
    try {
      const value = await invoke("github_releases", { repository: $("githubRepository").value.trim(), page: nextPage });
      current(op);
      result = value; page = nextPage; hasMore = value.hasMore === true;
      $("githubRepository").value = value.repository;
      $("githubResults").replaceChildren();
      let count = 0;
      for (const release of (value.releases || []).filter(item => !item.draft && releaseJars(item).length)) {
        count++;
        const row = node("article", "", "catalog-row github-release-row"), copy = node("div", "", "catalog-copy");
        copy.append(node("strong", release.name || release.tag_name), node("small", `${release.prerelease ? t("Предварительная версия") : t("Релиз")} · ${releaseJars(release).length} JAR`));
        const choose = node("button", t("Выбрать"), "button subtle"); choose.type = "button";
        choose.addEventListener("click", () => select(release)); row.append(copy, choose); $("githubResults").append(row);
      }
      status(count ? t("Репозиторий: {0}. Страница {1}. Совместимость будет проверена по выбранному JAR.", value.repository, page)
        : t("На этой странице нет опубликованных JAR модов. Возможно, автор размещает файлы только на Modrinth или CurseForge."));
    } catch (error) { if (op === operation) { result = null; hasMore = false; $("githubResults").replaceChildren(); report(error); } }
    finally { if (op === operation) { setBusy(false); render(); } }
  }
  function select(release) {
    if (getBusy()) return;
    clearSelection(); selected = release;
    $("githubReleaseTitle").textContent = release.name || release.tag_name;
    $("githubAsset").replaceChildren(...releaseJars(release).map(asset => new Option(`${asset.name} · ${sizes(asset.size)}`, String(asset.id))));
    $("githubDescription").replaceChildren(descriptionFragment(release.body));
    $("githubLicense").textContent = result.license?.spdx_id && result.license.spdx_id !== "NOASSERTION" ? result.license.spdx_id : t("Лицензия не определена");
    status(t("Выберите JAR нужной версии Minecraft и загрузчика. Подготовка не отправляет файлы на сервер."));
    render(); $("githubSelection").scrollIntoView({ block: "start" });
  }
  $("githubSearchForm").addEventListener("submit", event => { event.preventDefault(); search(); });
  $("githubPrevious").addEventListener("click", () => search(page - 1));
  $("githubNext").addEventListener("click", () => search(page + 1));
  $("githubCancel").addEventListener("click", () => {
    if (writing) return;
    operation++; clearSelection(); setBusy(false); render(); status(t("Выбор отменён. Уже отправленные файлы остаются в черновике."));
  });
  $("githubAsset").addEventListener("change", () => { prepared = null; $("githubRights").checked = false; render(); });
  $("githubRights").addEventListener("change", render);
  $("githubSide").addEventListener("change", render);
  $("githubPrepare").addEventListener("click", async () => {
    if (getBusy() || !selected || !result) return;
    const asset = releaseJars(selected).find(value => String(value.id) === $("githubAsset").value);
    if (!asset) return;
    const op = ++operation, binding = signature(), context = getContext();
    prepared = null; $("githubRights").checked = false;
    setBusy(true); render(); $("githubProgress").hidden = false; status(t("Скачивание и проверка: {0}", asset.name));
    try {
      const data = await invoke("github_download", { repository: result.repository, assetId: asset.id });
      current(op);
      if (signature() !== binding) throw new Error(t("Подключение или черновик изменились. Подготовьте файл заново."));
      const file = new File([new Uint8Array(data)], asset.name, { type: "application/java-archive" });
      if (file.size !== asset.size) throw new Error(t("Размер файла отличается от выбранного релиза GitHub."));
      const metadata = await inspectFile(file, context?.loader);
      current(op);
      if (metadata.inspectionError || !metadata.modId) throw new Error(metadata.inspectionError || t("В JAR нет ID мода."));
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(v => v.toString(16).padStart(2, "0")).join("");
      current(op);
      if (asset.digest && asset.digest.toLowerCase() !== `sha256:${sha256}`) throw new Error(t("Файл GitHub изменился после выбора релиза. Повторите поиск."));
      const restricted = metadata.sideKnown && ["client", "server"].includes(metadata.side);
      $("githubSide").replaceChildren(...(restricted ? [metadata.side] : ["both", "client", "server"]).map(side => new Option(sides[side], side)));
      if (!metadata.sideKnown) { $("githubSide").prepend(new Option(t("Выберите назначение"), "")); $("githubSide").value = ""; }
      $("githubJarSummary").textContent = `${metadata.modIds.join(", ")} · ${sizes(file.size)} · ${metadata.inference}`;
      prepared = { file, sha256, binding, modIds: metadata.modIds, source: { provider: "github", projectId: result.repository, versionId: String(asset.id), environment: restricted ? `${metadata.side}_only` : metadata.sideKnown ? "jar_universal" : "manual" } };
      status(t("JAR прочитан. Зависимости и версии проверит серверный агент перед публикацией; GitHub не подбирает их автоматически."));
    } catch (error) { if (op === operation) report(error); }
    finally { if (op === operation) { $("githubProgress").hidden = true; setBusy(false); render(); } }
  });
  $("githubInstall").addEventListener("click", async () => {
    if (getBusy() || !prepared || !getContext()?.modValidation || !$("githubRights").checked || !$("githubSide").value) return;
    const entry = prepared, side = $("githubSide").value;
    let sent = false;
    try {
      if (signature() !== entry.binding) throw new Error(t("Подключение или черновик изменились. Подготовьте файл заново."));
      // The same mod already in the draft is replaced, not joined; the same mod outside the
      // pack on the server is taken off it on publish, with a backup. Both are said afterwards.
      const match = findInDraft(getContext().files, { modIds: entry.modIds || [], provider: "github", projectId: entry.source.projectId, path: `mods/${entry.file.name}`, sha256: entry.sha256 });
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
  $("githubProjectLink").addEventListener("click", () => {
    if (result) invoke("open_catalog_link", { url: `https://github.com/${result.repository}` }).catch(report);
  });
  $("githubDescription").addEventListener("click", event => {
    const link = event.target.closest("a"); if (!link) return;
    event.preventDefault(); const url = catalogLink(link.getAttribute("href"));
    if (url) invoke("open_catalog_link", { url }).catch(report);
  });
  render();
  return { onOpen: force => { render(); if (force && result && !getBusy()) return search(page); } };
}
