import { t, getLocale } from "./i18n.js";
import { compatibleVersions, resolveMods, modSidePolicy } from "./modrinth.js";
import { catalogImageUrl, catalogLink, descriptionFragment } from "./catalog-content.js";
import { inspectFile } from "./file-intake.js";
import { loaderLabel, updatePlatformControls } from "./platform.js";
import { formatAgentError } from "./http.js";

const $ = (id) => document.getElementById(id);
const sizes = (n) => t("{0} МиБ", (n / 1024 / 1024).toFixed(1));
const sides = { client: t("Клиент"), server: t("Сервер"), both: t("Клиент + сервер") };
const node = (tag, text, className = "") => {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
};
const invoke = (name, args) => {
  if (!window.__TAURI__?.core?.invoke) throw new Error(t("Каталог доступен в Windows-приложении UDMC Control."));
  return window.__TAURI__.core.invoke(name, args);
};
const get = (path, query = {}) => invoke("modrinth_get", { path, query });

export function initModrinth({ getContext, getBusy, setBusy, upload, refresh, showToast }) {
  let plan = null;
  let offset = 0;
  let total = 0;
  let query = "";
  let context = null;
  let project = null;
  let lastSearch = "";
  let templates = [];
  let selectedVersions = [];
  let operation = 0;
  let writing = false;
  const cancelled = () => Object.assign(new Error("Cancelled"), { cancelled: true });
  const active = op => { if (op !== operation) throw cancelled(); };
  const report = (error) => { if (error?.cancelled) return; const message = formatAgentError(error); $("modrinthStatus").textContent = message; showToast(message, "error"); };
  const locked = (value, op = operation) => {
    if (op !== operation) return;
    setBusy(value);
    $("modrinthPanel").querySelectorAll("input,select,button").forEach((el) => { el.disabled = value; });
    $("modrinthPrevious").disabled = value || offset === 0;
    $("modrinthNext").disabled = value || offset + 12 >= total;
    $("modrinthInstall").disabled = value || !plan || !getContext()?.modValidation;
    $("modrinthMinecraft").disabled = value || Boolean(getContext());
    $("modrinthLoader").disabled = value || Boolean(getContext());
    $("modrinthCancel").disabled = writing;
    if (!value && project) $("modrinthResolve").disabled = !$("modrinthSide").value;
  };
  function clearSelection() {
    plan = null; project = null; selectedVersions = [];
    for (const name of ["modrinthSelection", "modrinthPlan", "modrinthDetails", "modrinthProgress"]) $(name).hidden = true;
    $("modrinthResults").hidden = false; $("modrinthPagination").hidden = false;
    $("modrinthDescription").replaceChildren(); $("modrinthGallery").replaceChildren();
    $("modrinthVersion").replaceChildren(); $("modrinthSide").replaceChildren();
    $("modrinthProjectSummary").textContent = ""; $("modrinthLicense").textContent = ""; $("modrinthSideHelp").textContent = "";
    $("modrinthInstall").disabled = true;
  }
  $("modrinthCancel").addEventListener("click", () => {
    if (writing) return;
    operation++; clearSelection(); locked(false);
    $("modrinthStatus").textContent = t("Выбор сброшен. Уже добавленные в черновик файлы сохранены.");
    $("modrinthQuery").focus();
  });
  const current = () => {
    const c = getContext();
    if (c && !["fabric", "neoforge"].includes(c.loader)) throw new Error(t("Каталог не поддерживает этот загрузчик."));
    if (c) {
      if (![...$("modrinthLoader").options].some(option => option.value === c.loader)) $("modrinthLoader").add(new Option(loaderLabel(c.loader), c.loader));
      $("modrinthLoader").value = c.loader;
      if (![...$("modrinthMinecraft").options].some(option => option.value === c.minecraft)) $("modrinthMinecraft").add(new Option(c.minecraft, c.minecraft));
      $("modrinthMinecraft").value = c.minecraft;
      return c;
    }
    const minecraft = $("modrinthMinecraft").value;
    if (!minecraft) throw new Error(t("Каталог доступен в Windows-приложении с готовыми профилями Minecraft."));
    const loader = $("modrinthLoader").value;
    if (!templates.some(t => t.minecraft === minecraft && t.loader === loader)) throw new Error(t("Выберите встроенный профиль каталога."));
    return { minecraft, loader, url: null, files: [], modValidation: false };
  };
  const unchanged = () => {
    if (JSON.stringify(current()) !== JSON.stringify(context)) throw new Error(t("Подключение или черновик изменились. Выполните поиск заново."));
  };
  const signature = () => JSON.stringify([current(), $("modrinthQuery").value.trim(), $("modrinthSort").value, $("modrinthCategory").value]);
  async function search(reset, quiet = false) {
    if (getBusy()) return;
    const op = ++operation;
    clearSelection(); locked(true);
    $("modrinthResults").replaceChildren(); total = 0; lastSearch = "";
    try {
      context = current();
      if (reset) { offset = 0; query = $("modrinthQuery").value.trim(); }
      $("modrinthPlatform").textContent = `${context.url ? t("Сервер") : t("Просмотр")} · ${loaderLabel(context.loader)} ${context.minecraft}`;
      $("modrinthStatus").textContent = t("Поиск в Modrinth...");
      // Modrinth models both loaders and content categories through the same facet.
      const facets = [["project_type:mod"], [`categories:${context.loader}`], [`versions:${context.minecraft}`]];
      if ($("modrinthCategory").value) facets.push([`categories:${$("modrinthCategory").value}`]);
      const response = await get("search", { query, index: $("modrinthSort").value, limit: "12", offset: String(offset), facets: JSON.stringify(facets) });
      active(op); unchanged(); total = response.total_hits;
      lastSearch = signature();
      $("modrinthResults").replaceChildren();
      for (const hit of response.hits.filter((h) => h.project_type === "mod")) {
        const row = node("article", "", "catalog-row");
        const copy = node("div", "", "catalog-copy");
        copy.append(node("strong", hit.title), node("p", hit.description), node("small", t("{0} · {1} скачиваний", hit.author, Number(hit.downloads).toLocaleString(getLocale()))));
        const icon = node("img", "", "catalog-icon"); icon.alt = ""; icon.loading = "lazy"; icon.referrerPolicy = "no-referrer";
        try { const url = new URL(hit.icon_url); if (url.protocol === "https:" && url.hostname === "cdn.modrinth.com") icon.src = url.href; } catch { /* Icons are optional metadata. */ }
        icon.addEventListener("error", () => { icon.hidden = true; });
        const choose = node("button", t("Выбрать"), "button subtle"); choose.type = "button";
        choose.addEventListener("click", () => select(hit));
        row.append(icon, copy, choose); $("modrinthResults").append(row);
      }
      $("modrinthStatus").textContent = total ? t("Найдено: {0}. Показаны {1}–{2}.{3}", total, offset + 1, Math.min(offset + 12, total), !context.url ? t(" Просмотр без подключения. Для добавления подключите агент сервера.") : !context.modValidation ? t(" Для добавления обновите серверный агент.") : "") : t("Для этой версии Minecraft ничего не найдено.");
    } catch (error) { if (error.cancelled) return; if (quiet) $("modrinthStatus").textContent = formatAgentError(error); else report(error); } finally { locked(false, op); }
  }
  async function select(hit) {
    if (getBusy()) return;
    const op = ++operation;
    clearSelection();
    locked(true); plan = null; project = null;
    $("modrinthPlan").hidden = true;
    $("modrinthResults").hidden = true; $("modrinthPagination").hidden = true;
    $("modrinthSelection").hidden = false;
    $("modrinthProjectTitle").textContent = hit.title;
    $("modrinthStatus").textContent = t("Загружаем сведения о моде...");
    $("modrinthSelection").scrollIntoView({ block: "start" });
    try {
      unchanged();
      const versions = compatibleVersions(await get(`project/${hit.project_id}/version`, { loaders: JSON.stringify([context.loader]), game_versions: JSON.stringify([context.minecraft]), include_changelog: "false" }), context.minecraft, context.loader);
      active(op); unchanged();
      if (!versions.length) throw new Error(t("Совместимых версий нет."));
      const detail = await get(`project/${hit.project_id}`);
      active(op); unchanged();
      project = { ...detail, project_id: hit.project_id };
      selectedVersions = versions;
      $("modrinthProjectTitle").textContent = hit.title;
      $("modrinthVersion").replaceChildren(...versions.map((v) => new Option(`${v.version_number} · ${v.version_type}`, v.id)));
      $("modrinthVersion").value = (versions.find((v) => v.version_type === "release") || versions[0]).id;
      updateSide(); renderProject();
      $("modrinthStatus").textContent = context.url ? t("Версия игры и загрузчик соответствуют серверу.") : t("Просмотр для выбранной версии игры и загрузчика.");
      $("modrinthSelection").hidden = false;
      $("modrinthSelection").scrollIntoView({ block: "nearest" });
    } catch (error) { if (op === operation) report(error); } finally { locked(false, op); }
  }
  function updateSide() {
    plan = null; $("modrinthPlan").hidden = true; $("modrinthInstall").disabled = true;
    $("modrinthSide").replaceChildren();
    try {
      const version = selectedVersions.find(v => v.id === $("modrinthVersion").value);
      const policy = modSidePolicy(version || {}, project || {});
      $("modrinthSide").replaceChildren(...policy.options.map(value => new Option(sides[value], value)));
      $("modrinthSide").value = policy.defaultSide;
      $("modrinthSideHelp").textContent = policy.explanation;
      $("modrinthResolve").disabled = false;
    } catch (error) { $("modrinthSideHelp").textContent = formatAgentError(error); $("modrinthResolve").disabled = true; }
  }
  function renderProject() {
    $("modrinthProjectSummary").textContent = project.description || "";
    $("modrinthLicense").textContent = project.license?.name || project.license?.id || "";
    $("modrinthDescription").replaceChildren(descriptionFragment(project.body || project.description));
    for (const img of $("modrinthDescription").querySelectorAll("img")) { img.referrerPolicy = "no-referrer"; img.loading = "lazy"; }
    $("modrinthGallery").replaceChildren();
    for (const entry of (project.gallery || []).slice(0, 24)) {
      const src = catalogImageUrl(entry.url);
      if (!src) continue;
      const button = node("button", "", "catalog-thumbnail"); button.type = "button";
      button.title = entry.title || project.title;
      const image = node("img", ""); image.src = src; image.alt = button.title; image.loading = "lazy"; image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => { button.hidden = true; });
      button.append(image); button.addEventListener("click", () => {
        $("catalogImagePreview").src = src; $("catalogImagePreview").alt = button.title;
        $("catalogImageTitle").textContent = button.title; $("catalogImageDialog").showModal();
      });
      $("modrinthGallery").append(button);
    }
    $("modrinthGallery").parentElement.hidden = !$("modrinthGallery").children.length;
    $("modrinthDetails").hidden = false;
  }
  $("modrinthProjectLink").addEventListener("click", () => {
    if (project) invoke("open_catalog_link", { url: `https://modrinth.com/mod/${encodeURIComponent(project.project_id)}` }).catch(report);
  });
  $("modrinthDescription").addEventListener("click", event => {
    const link = event.target.closest("a"); if (!link) return;
    event.preventDefault();
    const url = catalogLink(link.getAttribute("href"));
    if (url) invoke("open_catalog_link", { url }).catch(report);
  });
  $("catalogImageDialog").addEventListener("close", () => $("catalogImagePreview").removeAttribute("src"));
  $("modrinthSearchForm").addEventListener("submit", (e) => { e.preventDefault(); search(true); });
  $("modrinthMinecraft").addEventListener("change", () => search(true));
  $("modrinthLoader").addEventListener("change", () => {
    updatePlatformControls({ loader: $("modrinthLoader"), minecraft: $("modrinthMinecraft") }, templates);
    search(true);
  });
  $("modrinthSort").addEventListener("change", () => search(true));
  $("modrinthCategory").addEventListener("change", () => search(true));
  $("modrinthPrevious").addEventListener("click", () => { offset = Math.max(0, offset - 12); search(false); });
  $("modrinthNext").addEventListener("click", () => { offset += 12; search(false); });
  $("modrinthVersion").addEventListener("change", updateSide);
  $("modrinthSide").addEventListener("change", () => { plan = null; $("modrinthPlan").hidden = true; $("modrinthInstall").disabled = true; });
  $("modrinthResolve").addEventListener("click", async () => {
    if (getBusy() || !project) return;
    const op = ++operation;
    locked(true); plan = null; $("modrinthPlan").hidden = true;
    try {
      unchanged(); $("modrinthStatus").textContent = t("Проверка обязательных зависимостей...");
      const resolved = await resolveMods({ projectId: project.project_id, versionId: $("modrinthVersion").value, side: $("modrinthSide").value, minecraft: context.minecraft, loader: context.loader,
        get: async (...args) => { active(op); const data = await get(...args); active(op); return data; } });
      active(op); unchanged(); plan = resolved;
      $("modrinthPlanFiles").replaceChildren(...plan.nodes.map((entry) => {
        const row = node("div", "", "catalog-plan-row");
        const copy = node("div", ""); copy.append(node("strong", `${entry.project.title} ${entry.version.version_number}`), node("small", `mods/${entry.file.filename}`), node("small", entry.requiredBy.size ? t("Нужен для: {0}", [...entry.requiredBy].join(", ")) : t("Выбранный мод")));
        const side = node("span", sides[entry.side]); side.title = entry.sidePolicy.explanation;
        row.append(copy, side, node("span", sizes(entry.file.size))); return row;
      }));
      $("modrinthWarnings").replaceChildren(...plan.warnings.map((w) => node("p", w)));
      $("modrinthPlanSummary").textContent = t("{0} файлов · {1}", plan.nodes.length, sizes(plan.total));
      $("modrinthStatus").textContent = context.modValidation ? t("Зависимости подобраны. Публикация остаётся отдельным действием.") : t("Зависимости подобраны для просмотра. Для добавления подключите обновлённый серверный агент.");
      $("modrinthPlan").hidden = false;
      $("modrinthPlan").scrollIntoView({ block: "nearest" });
    } catch (error) { if (op === operation) { plan = null; report(error); } } finally { locked(false, op); }
  });
  $("modrinthInstall").addEventListener("click", async () => {
    if (getBusy() || !plan) return;
    const op = ++operation;
    locked(true);
    let uploaded = 0;
    $("modrinthProgress").hidden = false;
    $("modrinthProgress").max = plan.nodes.length * 2;
    $("modrinthProgress").value = 0;
    try {
      unchanged();
      if (!getContext()?.modValidation) throw new Error(t("Для добавления модов подключите обновлённый серверный агент."));
      const prepared = [];
      const ids = new Set();
      for (const entry of plan.nodes) {
        $("modrinthStatus").textContent = t("Скачивание и проверка: {0}", entry.project.title);
        const data = await invoke("modrinth_download", { url: entry.file.url, size: entry.file.size, sha512: entry.file.hashes.sha512 });
        active(op);
        const file = new File([new Uint8Array(data)], entry.file.filename, { type: "application/java-archive" });
        const metadata = await inspectFile(file, context.loader);
        active(op);
        if (metadata.inspectionError || !metadata.modId) throw new Error(metadata.inspectionError || t("В JAR нет ID мода."));
        if (metadata.sideKnown !== false && metadata.side !== "both" && metadata.side !== entry.side) throw new Error(t("{0}: назначение в JAR отличается от Modrinth.", file.name));
        for (const id of metadata.modIds) {
          if (ids.has(id)) throw new Error(t("Два файла содержат мод {0}. Импорт остановлен.", id));
          ids.add(id);
        }
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map((v) => v.toString(16).padStart(2, "0")).join("");
        active(op);
        const old = context.files.find((f) => f.path.toLowerCase() === `mods/${file.name}`.toLowerCase());
        if (old && (old.sha256 !== hash || old.side !== entry.side)) throw new Error(t("{0} уже есть в черновике с другим содержимым или назначением. Сначала разберите этот файл в разделе «Сборка».", file.name));
        prepared.push({ file, side: entry.side, skip: Boolean(old), source: { provider: "modrinth", projectId: entry.project.id, versionId: entry.version.id, environment: entry.sidePolicy.environment } });
        $("modrinthProgress").value++;
      }
      active(op); unchanged();
      writing = true; $("modrinthCancel").disabled = true;
      for (const entry of prepared) {
        $("modrinthStatus").textContent = t("Добавление в черновик: {0}", entry.file.name);
        if (!entry.skip) { await upload(entry.file, entry.side, entry.source); uploaded++; }
        $("modrinthProgress").value++;
      }
      $("modrinthStatus").textContent = t("Добавлено в черновик: {0}. Перед публикацией проверьте состав сборки.", uploaded);
      plan = null;
      $("modrinthPlan").hidden = true; $("modrinthProgress").hidden = true;
      showToast(t("Моды и зависимости добавлены в черновик"));
    } catch (error) {
      if (op !== operation) return;
      report(error);
      if (uploaded) $("modrinthStatus").textContent += t(" В черновике осталось добавленных файлов: {0}. Публикации не было.", uploaded);
      plan = null;
    } finally {
      if (uploaded) await refresh();
      if (op === operation) { writing = false; $("modrinthProgress").hidden = true; locked(false); }
    }
  });
  const ready = (async () => {
    if (!window.__TAURI__?.core?.invoke) return;
    try {
      const catalog = await invoke("generator_catalog");
      templates = catalog.templates;
      updatePlatformControls({ loader: $("modrinthLoader"), minecraft: $("modrinthMinecraft") }, templates);
    } catch (error) { $("modrinthStatus").textContent = formatAgentError(error); }
  })();
  return { onOpen: async (force = false) => {
    await ready;
    if (getBusy()) return;
    try { if (!force && lastSearch === signature()) return; } catch { /* Search displays the unavailable state. */ }
    await search(true, true);
  } };
}
