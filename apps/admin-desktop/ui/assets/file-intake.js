import { t } from "./i18n.js";
import { unzipSync, strFromU8 } from "../vendor/fflate.js";
import { parse as parseToml } from "../vendor/smol-toml/index.js";

const MAX_INSPECTION_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;

export function initialFileSettings(file) {
  const name = String(file.name || "").toLowerCase();
  if (name.endsWith(".jar")) return { root: "mods/", side: "both", inference: t("назначение пока не проверено") };
  if (name.endsWith(".zip")) return { root: "resourcepacks/", side: "client", inference: t("тип ZIP пока не проверен") };
  return { root: "config/", side: "both", inference: t("файл конфигурации") };
}

export async function inspectFile(file, loader = null) {
  const settings = initialFileSettings(file);
  const name = String(file.name || "").toLowerCase();
  if (!name.endsWith(".jar") && !name.endsWith(".zip")) return settings;
  if (file.size > MAX_INSPECTION_BYTES) {
    return { ...settings, ...(name.endsWith(".jar") ? { side: "", sideKnown: false } : {}), inference: t("большой архив: проверьте назначение вручную") };
  }

  try {
    const entries = [];
    const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter(entry) {
        entries.push(entry.name);
        return ["fabric.mod.json", "META-INF/neoforge.mods.toml"].includes(entry.name) && entry.originalSize <= MAX_METADATA_BYTES;
      }
    });

    if (entries.includes("udmc-bootstrap.json")) {
      return { ...settings, inspectionError: t("Это старый персональный файл UDMC со встроенными настройками. Мод давно один на всех, и в сборку он не добавляется - возьмите текущий на вкладке «Скачать мод».") };
    }

    if (name.endsWith(".jar")) {
      const loaders = [archive["fabric.mod.json"] && "fabric", archive["META-INF/neoforge.mods.toml"] && "neoforge"].filter(Boolean);
      if (loader && !loaders.includes(loader)) return { ...settings, inspectionError: t("JAR не содержит метаданных загрузчика {0}.", loader) };
      if (loaders.includes("neoforge") && loader !== "fabric" && (loader === "neoforge" || !loaders.includes("fabric"))) {
        const metadata = parseToml(strFromU8(archive["META-INF/neoforge.mods.toml"]));
        if (!Array.isArray(metadata.mods) || !metadata.mods.length || metadata.mods.length > 512) throw new Error("Invalid mod list");
        const modIds = metadata.mods.map(mod => mod.modId);
        if (modIds.includes("udmc_sync")) return { ...settings, inspectionError: t("Агент UDMC устанавливается отдельно от файлов сборки.") };
        if (modIds.some(id => typeof id !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(id)) || new Set(modIds).size !== modIds.length) throw new Error("Invalid mod IDs");
        if (!["javafml", "lowcodefml"].includes(metadata.modLoader)) return { ...settings, inspectionError: t("Проверка языкового загрузчика {0} пока не поддерживается.", metadata.modLoader || t("не указан")) };
        const declared = metadata.mods[0]?.version;
        return { root: "mods/", side: "", sideKnown: false, loaders, modId: modIds[0], modIds,
          modVersion: typeof declared === "string" && !declared.includes("${") ? declared : null,
          inference: t("NeoForge: выберите назначение файла") };
      }
      if (!archive["fabric.mod.json"]) {
        return { ...settings, inspectionError: t("В JAR нет доступных метаданных Fabric или NeoForge.") };
      }
      const metadata = JSON.parse(strFromU8(archive["fabric.mod.json"]));
      if (metadata.id === "udmc_sync") return { ...settings, inspectionError: t("Агент UDMC устанавливается отдельно от файлов сборки.") };
      const environment = metadata.environment || "*";
      if (!["*", "client", "server"].includes(environment)) {
        return { ...settings, inspectionError: t("В моде указано неизвестное окружение Fabric.") };
      }
      return {
        root: "mods/",
        side: environment === "*" ? "both" : environment,
        inference: environment === "*" ? t("Fabric: обе стороны") : environment === "client" ? t("Fabric: только клиент") : t("Fabric: только сервер"),
        modId: typeof metadata.id === "string" ? metadata.id : null,
        modIds: typeof metadata.id === "string" ? [metadata.id, ...(Array.isArray(metadata.provides) ? metadata.provides.filter(id => typeof id === "string") : [])] : [],
        modVersion: typeof metadata.version === "string" ? metadata.version : null, loaders, sideKnown: true
      };
    }

    if (entries.some((entry) => entry.startsWith("shaders/"))) {
      return { root: "shaderpacks/", side: "client", inference: t("шейдеры: каталог shaders") };
    }
    return {
      ...settings,
      inference: entries.includes("pack.mcmeta") ? t("ресурсы: pack.mcmeta") : t("тип ZIP не подтверждён: проверьте папку")
    };
  } catch {
    return { ...settings, inspectionError: t("Не удалось прочитать архив. Возможно, файл повреждён.") };
  }
}
