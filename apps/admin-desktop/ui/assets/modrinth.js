import { t } from "./i18n.js";
const id = (value) => {
  if (typeof value !== "string" || !/^[a-z\d_-]{1,128}$/i.test(value)) throw new Error(t("Modrinth вернул некорректный ID."));
  return value;
};

export function modSide(version, project) {
  return modSidePolicy(version, project).defaultSide;
}

export function modSidePolicy(version, project) {
  const projectEnvironments = Array.isArray(project.environment) ? [...new Set(project.environment)] : [project.environment];
  const environment = typeof version.environment === "string" && version.environment !== "unknown" ? version.environment
    : projectEnvironments.length === 1 ? projectEnvironments[0] : null;
  const policies = {
    client_only: ["client", ["client"], t("Работает только на клиенте. На сервер устанавливать не нужно.")],
    server_only: ["server", ["server"], t("Работает на сервере. Игрокам этот мод не требуется.")],
    dedicated_server_only: ["server", ["server"], t("Только выделенный сервер, не клиент и не одиночная игра.")],
    client_and_server: ["both", ["both"], t("Автор требует установку и на сервер, и всем игрокам.")],
    client_only_server_optional: ["client", ["client", "both"], t("Обязателен игрокам; на сервере даёт дополнительные возможности, но не обязателен.")],
    server_only_client_optional: ["server", ["server", "both"], t("Обязателен серверу; у игроков даёт дополнительные возможности, но не обязателен.")],
    client_or_server: ["server", ["client", "server", "both"], t("Работает на любой стороне. Для общего сервера по умолчанию выбран только сервер.")],
    client_or_server_prefers_both: ["both", ["client", "server", "both"], t("Работает на любой стороне, но автор рекомендует установить на обе.")],
    legacy_optional: ["both", ["client", "server", "both"], t("По данным автора обе стороны необязательны. Проверьте описание мода.")]
  };
  if (environment === "singleplayer_only") throw new Error(t("{0}: только одиночная игра.", project.title));
  let key = policies[environment] ? environment : null;
  if (!key) {
    const c = project.client_side, s = project.server_side;
    if (c === "unsupported" && ["required", "optional"].includes(s)) key = "server_only";
    else if (s === "unsupported" && ["required", "optional"].includes(c)) key = "client_only";
    else if (c === "required" && s === "required") key = "client_and_server";
    else if (c === "required" && s === "optional") key = "client_only_server_optional";
    else if (c === "optional" && s === "required") key = "server_only_client_optional";
    else if (c === "optional" && s === "optional") key = "legacy_optional";
  }
  if (!key) throw new Error(t("{0}: автор не указал назначение этой версии. Автоматический импорт остановлен.", project.title));
  const [defaultSide, options, explanation] = policies[key];
  return { defaultSide, options: [...options], explanation, environment: key };
}

export function primaryJar(version) {
  const files = version.files || [];
  const file = files.find((f) => f.primary) || files[0];
  if (!file || !/^[^<>:"/\\|?*\x00-\x1f]+\.jar$/i.test(file.filename)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(file.filename)
      || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 64 * 1024 * 1024
      || !/^[a-f\d]{128}$/i.test(file.hashes?.sha512 || "")
      || ["sources-jar", "dev-jar", "javadoc-jar"].includes(file.file_type)) {
    throw new Error(t("{0}: нужен обычный JAR до 64 МиБ с SHA-512.", version.name));
  }
  const url = new URL(file.url);
  if (url.protocol !== "https:" || url.hostname !== "cdn.modrinth.com" || url.port || url.username || url.password
    || url.search || url.hash || !url.pathname.startsWith("/data/") || !url.pathname.toLowerCase().endsWith(".jar")) {
    throw new Error(t("Ссылка на мод не ведёт на официальный CDN Modrinth."));
  }
  return file;
}

export function compatibleVersions(versions, minecraft, loader) {
  return versions.filter((v) => v.game_versions?.includes(minecraft) && v.loaders?.includes(loader)
    && ["listed", "archived"].includes(v.status || "listed"))
    .sort((a, b) => String(b.date_published).localeCompare(String(a.date_published)));
}

export async function resolveMods({ projectId, versionId, minecraft, loader, side: selectedSide, get }) {
  if (!["fabric", "neoforge"].includes(loader)) throw new Error(t("Для этого загрузчика импорт пока не поддерживается."));
  const nodes = new Map();
  const cache = new Map();
  const pending = new Set();
  const warnings = new Set();
  const read = async (path, query = {}) => {
    const key = path + JSON.stringify(query);
    if (!cache.has(key)) cache.set(key, await get(path, query));
    return cache.get(key);
  };
  const versions = async (project) => compatibleVersions(await read(`project/${id(project)}/version`, {
    loaders: JSON.stringify([loader]), game_versions: JSON.stringify([minecraft]), include_changelog: "false"
  }), minecraft, loader);
  async function visit(projectId, pinned, requestedSide = "both", parent = null) {
    let version = pinned ? await read(`version/${id(pinned)}`) : null;
    projectId = id(projectId || version?.project_id);
    if (pending.has(projectId)) throw new Error(t("Циклические зависимости: требуется ручная проверка сборки."));
    if (nodes.size >= 48 && !nodes.has(projectId)) throw new Error(t("Слишком много зависимостей. Импорт ограничен 48 модами."));
    const project = await read(`project/${projectId}`);
    if (project.project_type !== "mod") throw new Error(t("{0}: импортируются только моды.", project.title));
    if (!version) version = (await versions(projectId)).find((v) => v.version_type === "release");
    if (!version || version.project_id !== projectId || !compatibleVersions([version], minecraft, loader).length) {
      throw new Error(t("{0}: нет подходящей версии для {1} {2}.", project.title, loader, minecraft));
    }
    const sidePolicy = modSidePolicy(version, project);
    let side = sidePolicy.defaultSide;
    if (!parent && selectedSide) {
      if (!sidePolicy.options.includes(selectedSide)) throw new Error(t("{0}: выбранное назначение не разрешено автором.", project.title));
      side = selectedSide;
    } else if (parent && sidePolicy.options.includes(requestedSide)) side = requestedSide;
    if (parent && requestedSide !== "both" && side !== "both" && side !== requestedSide) {
      throw new Error(t("{0}: зависимость недоступна на стороне {1}.", project.title, requestedSide));
    }
    if (parent && side === "both" && requestedSide !== "both") warnings.add(t("{0}: автор требует обе стороны, хотя {1} нужен только на стороне {2}.", project.title, parent, requestedSide));
    let node = nodes.get(projectId);
    if (node) {
      if (node.version.id !== version.id) throw new Error(t("{0}: зависимости требуют разные версии. Импорт остановлен.", project.title));
      if (node.side === side || node.side === "both") { if (parent) node.requiredBy.add(parent); return; }
      node.side = "both";
    } else {
      node = { project, version, file: primaryJar(version), side, sidePolicy, requiredBy: new Set(parent ? [parent] : []) };
      nodes.set(projectId, node);
    }
    pending.add(projectId);
    for (const dep of version.dependencies || []) {
      if (dep.dependency_type === "required") {
        if (!dep.project_id && !dep.version_id) throw new Error(t("{0}: обязательная зависимость находится вне Modrinth.", project.title));
        await visit(dep.project_id, dep.version_id, node.side, project.title);
      } else if (dep.dependency_type === "optional") warnings.add(t("{0}: необязательные дополнения не устанавливаются.", project.title));
    }
    if (version.version_type !== "release") warnings.add(t("{0}: выбрана {1}-версия.", project.title, version.version_type));
    pending.delete(projectId);
  }
  await visit(projectId, versionId);
  for (const node of nodes.values()) for (const dep of node.version.dependencies || []) {
    if (dep.dependency_type !== "incompatible") continue;
    const conflict = [...nodes.values()].find((n) => (dep.version_id ? n.version.id === dep.version_id : n.project.id === dep.project_id)
      && (n.side === "both" || node.side === "both" || n.side === node.side));
    if (conflict) throw new Error(t("{0} несовместим с {1}.", node.project.title, conflict.project.title));
    warnings.add(t("{0}: автор указал несовместимые моды. Состав сборки будет проверен перед публикацией.", node.project.title));
  }
  const paths = new Set();
  let total = 0;
  for (const node of nodes.values()) {
    const path = node.file.filename.toLowerCase();
    if (paths.has(path)) throw new Error(t("Совпадающие имена файлов: {0}", node.file.filename));
    paths.add(path); total += node.file.size;
  }
  if (total > 256 * 1024 * 1024) throw new Error(t("Одна операция импорта ограничена 256 МиБ."));
  return { nodes: [...nodes.values()], warnings: [...warnings], total };
}
