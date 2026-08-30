import { t } from "./i18n.js";
import { formatAppError } from "./http.js";

const diagnostics = {
  "udmc_sync.diagnostic.duplicate": [2, args => t("udmc_sync.diagnostic.duplicate", ...args)],
  "udmc_sync.diagnostic.nested_versions": [2, args => t("udmc_sync.diagnostic.nested_versions", ...args)],
  "udmc_sync.diagnostic.embedded": [2, args => t("udmc_sync.diagnostic.embedded", ...args)],
  "udmc_sync.diagnostic.required": [4, args => t("udmc_sync.diagnostic.required", ...args)],
  "udmc_sync.diagnostic.optional": [4, args => t("udmc_sync.diagnostic.optional", ...args)],
  "udmc_sync.diagnostic.incompatible": [3, args => t("udmc_sync.diagnostic.incompatible", ...args)],
  "udmc_sync.diagnostic.cycle": [1, args => t("udmc_sync.diagnostic.cycle", ...args)],
  "udmc_sync.diagnostic.overwrite": [1, args => t("udmc_sync.diagnostic.overwrite", ...args)],
  "udmc_sync.diagnostic.side": [3, args => t("udmc_sync.diagnostic.side", args[0], side(args[1]), side(args[2]))],
  "udmc_sync.diagnostic.inspect": [2, args => t("udmc_sync.diagnostic.inspect", ...args)]
};
const side = value => value === "client" ? t("Клиент") : value === "server" ? t("Сервер") : value;
const statuses = Object.freeze({
  AGENT_UPDATE_PACKAGED_REQUIRED: () => t("Для удалённого обновления запустите сервер с готовым серверным JAR UDMC."),
  AGENT_UPDATE_INTERRUPTED: () => t("Процесс обновления агента был прерван."),
  AGENT_UPDATE_FAILED: () => t("Обновление агента завершилось ошибкой."),
  AGENT_UPDATE_STATUS_INVALID: () => t("Сохранённое состояние обновления агента повреждено.")
});

export function diagnosticMessage(issue) {
  const spec = Object.hasOwn(diagnostics, issue?.code) ? diagnostics[issue.code] : null;
  if (spec && Array.isArray(issue.args) && issue.args.length === spec[0]
    && issue.args.every(value => typeof value === "string" && value.length <= 16384)) return spec[1](issue.args);
  // API-style validation issues share the same stable codes as command errors.
  if (typeof issue?.code === "string") return formatAppError(issue);
  // Older agents retain their literal explanation.
  return typeof issue?.message === "string" ? issue.message : t("Сервер вернул некорректный ответ.");
}

export function agentStatusMessage(status, fallback = "") {
  const translate = status && typeof status.code === "string" && Object.hasOwn(statuses, status.code)
    ? statuses[status.code]
    : null;
  if (translate) return translate();
  if (typeof status === "string") return status;
  return typeof status?.message === "string" ? status.message : fallback;
}
