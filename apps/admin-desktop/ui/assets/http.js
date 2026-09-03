import { t } from "./i18n.js";
export const REQUEST_TIMEOUT = 15000;
export const MUTATION_TIMEOUT = 60000;
export const UPLOAD_TIMEOUT = 300000;

const withDetails = (message, args) => args[0]
  ? `${message} ${t("Технические сведения: {0}", args[0])}`
  : message;

const agentErrorTranslators = Object.freeze({
  WORKSPACE_REQUIRED: () => t("Обновите UDMC Control и перечитайте данные сервера перед изменением."),
  WORKSPACE_STALE: () => t("Другой администратор изменил сервер. Обновите данные и проверьте изменения перед повтором."),
  WORKSPACE_LOCKED: args => t("Сейчас сервер редактирует другой администратор: {0}", args[0] || t("неизвестное устройство")),
  ACCESS_DEVICE_NOT_APPROVED: () => t("Доступ устройства не подтверждён или отозван. Проверьте раздел «Агент и доступ»."),
  ACCESS_RECOVERY_KEY_REQUIRED: () => t("Для восстановления владельца нужен ключ проекта из серверного JAR."),
  ACCESS_SEPARATE_DEVICE_KEY_REQUIRED: () => t("Для этого устройства нужен отдельный ключ."),
  ACCESS_DEVICE_KEY_USED: () => t("Этот ключ устройства уже используется."),
  ACCESS_INVITE_LIMIT: () => t("Уже создано 10 активных приглашений. Отзовите лишнее или дождитесь истечения срока."),
  ACCESS_INVITE_INVALID: () => t("Приглашение недействительно, уже использовано или истекло. Попросите владельца создать новое."),
  ACCESS_REQUEST_LIMIT: () => t("Слишком много ожидающих заявок. Владельцу нужно сначала их разобрать."),
  ACCESS_DEVICE_NOT_FOUND: () => t("Устройство не найдено. Запросите новое приглашение."),
  ACCESS_REQUEST_NOT_FOUND: () => t("Заявка на доступ не найдена."),
  ACCESS_REQUEST_NOT_PENDING: () => t("Заявка больше не ожидает подтверждения."),
  ACCESS_SELF_REVOKE: () => t("Нельзя отозвать текущее устройство в этом разделе."),
  ACCESS_REQUEST_RESOLVED: () => t("Заявка уже обработана или истекла."),
  ACCESS_ALREADY_REVOKED: () => t("Доступ уже не действует."),
  ACCESS_ACTION_INVALID: () => t("Неизвестное действие с доступом."),
  ACCESS_INVITE_NOT_FOUND: () => t("Приглашение не найдено."),
  ACCESS_OWNER_REQUIRED: () => t("Устройствами и приглашениями может управлять только владелец проекта."),
  ACCESS_DEVICE_KEY_INVALID: () => t("Нужен случайный 256-битный ключ устройства."),
  ACCESS_DEVICE_NAME_INVALID: () => t("Название устройства должно содержать от 1 до 64 символов без управляющих символов."),
  ACCESS_RATE_LIMIT: () => t("Слишком много попыток. Подождите минуту."),
  ACCESS_DEVICE_LIMIT: () => t("Достигнут предел 100 устройств. Отзовите неиспользуемые доступы."),
  ACCESS_REQUEST_BODY_REQUIRED: () => t("Заполните данные заявки на доступ."),
  ACCESS_DEVICE_BODY_REQUIRED: () => t("Заполните данные устройства."),
  ACCESS_INVITATION_BODY_REQUIRED: () => t("Заполните данные приглашения."),
  ACCESS_DECISION_BODY_REQUIRED: () => t("Заполните решение по заявке."),
  NOT_FOUND: () => t("Запрошенная функция отсутствует в этой версии агента."),
  MANIFEST_SIGNING_KEY_MISSING: () => t("На сервере отсутствует ключ подписи манифеста."),
  MINECRAFT_NOT_READY: () => t("Minecraft-сервер ещё не готов."),
  SERVER_COMMAND_INVALID: () => t("Команда имеет неверный формат."),
  REMOTE_POWER_DISABLED: () => t("Удалённое управление питанием отключено в настройках."),
  FILE_NOT_FOUND: () => t("Файл не найден на сервере."),
  UPLOAD_BUSY: () => t("Сервер принимает другой файл. Повторите загрузку чуть позже."),
  UPLOAD_TOO_LARGE: () => t("Файл больше допустимых 512 МиБ."),
  CLIENT_AGENT_NOT_READY: () => t("Клиентский агент ещё не подготовлен на сервере."),
  CLIENT_AGENT_POLICY_REQUIRED: () => t("Выберите правило допуска игроков без клиентского агента."),
  CATALOG_SOURCE_TOO_LARGE: () => t("Метаданные источника каталога слишком велики."),
  CATALOG_SOURCE_INVALID: () => t("Метаданные источника каталога некорректны."),
  SERVER_FILE_IMPORT_BODY_REQUIRED: () => t("Не заполнены данные для принятия серверного файла в сборку."),
  SERVER_FILE_REMOVAL_BODY_REQUIRED: () => t("Не заполнены данные для удаления серверного файла."),
  FILE_UPDATE_BODY_REQUIRED: () => t("Не заполнены новые параметры файла."),
  FILE_PATH_REQUIRED: () => t("Укажите путь файла."),
  OPERATION_UNKNOWN: () => t("Эта операция не поддерживается агентом."),
  DRAFT_STALE: () => t("Другой администратор изменил черновик. Проверьте обновлённый состав и подтвердите публикацию заново."),
  DRAFT_NO_CHANGES: () => t("В черновике нет изменений для публикации."),
  PUBLISH_BLOCKED_BY_VALIDATION: args => t("Публикация отклонена: проверка состава нашла проблемы ({0}). Откройте вкладку «Проверка» и исправьте состав.", args[0] || ""),
  PACK_VERSION_INVALID: () => t("Версия сборки может содержать только латинские буквы, цифры, точки, дефисы и знак + (до 64 символов)."),
  DRAFT_FILE_NOT_FOUND: args => t("Файл больше не находится в черновике: {0}", args[0] || ""),
  DRAFT_PATH_EXISTS: args => t("В черновике уже есть файл с таким путём: {0}", args[0] || ""),
  DRAFT_BLOB_MISSING: args => t("Данные файла черновика отсутствуют. Загрузите файл повторно: {0}", args[0] || ""),
  DRAFT_BLOB_HASH_MISMATCH: args => t("Данные файла черновика повреждены. Загрузите файл повторно: {0}", args[0] || ""),
  DRAFT_VALIDATION_FAILED: () => t("Не удалось проверить файлы черновика. Проверьте журнал сервера и повторите попытку."),
  UDMC_AGENT_PACK_FORBIDDEN: () => t("Синхронизаторы UDMC нельзя добавлять как обычные файлы сборки."),
  UDMC_AGENT_REMOVE_FORBIDDEN: () => t("Серверный агент UDMC нельзя удалить через сборку."),
  SERVER_FILE_CHANGED: () => t("Файл на сервере изменился. Обновите список файлов перед повтором."),
  SERVER_FILE_CHANGED_OR_MISSING: args => t("Файл на сервере изменился или исчез. Обновите список и подтвердите точный файл: {0}", args[0] || ""),
  SERVER_FILE_MISSING_OR_LARGE: () => t("Файл на сервере отсутствует или превышает допустимый размер."),
  SERVER_FILE_REMOVAL_PENDING: args => t("Сначала отмените запланированное удаление серверного файла: {0}", args[0] || ""),
  FILE_ALREADY_MANAGED: () => t("Этот файл уже управляется сборкой."),
  FILE_MANAGED_USE_DRAFT: () => t("Этот файл управляется сборкой. Удалите его во вкладке черновика."),
  FILE_BLOB_INVALID: () => t("Некорректный идентификатор файла."),
  FILE_SIDE_INVALID: args => t("Некорректное назначение файла: {0}", args[0] || ""),
  MANAGED_PATH_REQUIRED: () => t("Укажите путь файла внутри сборки."),
  MANAGED_PATH_RELATIVE: args => t("Путь должен быть относительным: {0}", args[0] || ""),
  MANAGED_PATH_ROOT: () => t("Путь должен начинаться с mods/, config/, resourcepacks/ или shaderpacks/."),
  MANAGED_PATH_UNSAFE: args => t("Путь содержит недопустимые символы или имя файла: {0}", args[0] || ""),
  MANAGED_PATH_SYMLINK: args => t("Путь не должен проходить через символическую ссылку: {0}", args[0] || ""),
  MANAGED_PATH_ESCAPE: args => t("Путь выходит за пределы папки игры: {0}", args[0] || ""),
  UDMC_SERVICE_FILE: () => t("Служебные файлы UDMC нельзя включать в сборку."),
  JSON_BODY_TOO_LARGE: () => t("Параметры запроса слишком велики."),
  AGENT_JAR_SIZE_INVALID: () => t("JAR агента пуст или превышает допустимый размер."),
  AGENT_ARCHIVE_INVALID: () => t("Архив агента имеет некорректную структуру."),
  AGENT_ARCHIVE_TOO_LARGE: () => t("Распакованный архив агента превышает допустимый размер."),
  AGENT_NOT_UPDATE_CAPABLE: () => t("Выбранный JAR не является обновляемым агентом UDMC."),
  AGENT_METADATA_INVALID: () => t("Метаданные агента отсутствуют или повреждены."),
  AGENT_PLATFORM_MISMATCH: () => t("Агент предназначен для другой версии Minecraft или загрузчика."),
  AGENT_VERSION_INVALID: () => t("Версия агента указана некорректно или отличается внутри пакета."),
  AGENT_DOWNGRADE_FORBIDDEN: () => t("Эта версия UDMC Control не может понизить версию работающего агента."),
  AGENT_SERVER_CONFIG_FORBIDDEN: () => t("Обновление серверного агента не должно содержать конфигурацию или секреты."),
  AGENT_BOOTSTRAP_INVALID: () => t("В клиентском агенте отсутствуют корректные данные подключения."),
  AGENT_BOOTSTRAP_MISMATCH: () => t("Клиентский агент создан для другого проекта или содержит запрещённые секреты."),
  AGENT_UPLOAD_TOO_LARGE: () => t("Пакет агента превышает допустимые 16 МиБ."),
  CLIENT_AGENT_FILE_INVALID: () => t("Некорректное имя файла клиентского агента."),
  AGENT_SIGNING_REQUIRED: () => t("Для раздачи агентов проект должен использовать цифровую подпись."),
  AGENT_BUNDLE_INVALID: () => t("Пакет обновления должен содержать клиентский и серверный агенты из UDMC Control."),
  AGENT_BUNDLE_VERSION_MISMATCH: () => t("Версии клиентского и серверного агентов в пакете не совпадают."),
  CLIENT_AGENT_UPLOAD_REQUIRED: () => t("Сначала загрузите клиентский агент, затем включайте обязательную проверку входа."),
  RCON_PORT_INVALID: () => t("Порт RCON должен быть от 1 до 65535."),
  RCON_PASSWORD_INVALID: () => t("Введите пароль RCON длиной до 1024 байт без нулевых символов."),
  RCON_COMMAND_INVALID: () => t("Введите одну команду длиной до 512 символов (1413 байт)."),
  RCON_CONNECT_FAILED: () => t("Не удалось подключиться к RCON. Проверьте адрес, порт и доступность сервера."),
  RCON_AUTH_FAILED: () => t("Сервер отклонил пароль RCON."),
  RCON_HANDSHAKE_FAILED: () => t("Сервер не подтвердил подключение RCON или прислал повреждённый ответ."),
  RCON_RESPONSE_FAILED: () => t("Не удалось полностью прочитать ответ RCON: соединение прервано, ответ повреждён или превышает 4 МиБ."),
  RCON_TIMEOUT: () => t("Сервер RCON не ответил за отведённое время."),
  RCON_HOST_INVALID: () => t("Укажите только домен или IP-адрес RCON без протокола и порта."),
  GENERATOR_IDENTITY_FAILED: args => withDetails(t("Не удалось загрузить или создать ключи проекта."), args),
  AGENT_PACKAGE_PREPARE_FAILED: args => withDetails(t("Не удалось подготовить пакет агентов."), args),
  AGENT_EXPORT_FAILED: args => withDetails(t("Не удалось создать серверный агент."), args),
  IDENTITY_RECOVERY_FAILED: args => withDetails(t("Не удалось восстановить доступ к проекту из серверного JAR."), args),
  CREDENTIAL_READ_FAILED: args => withDetails(t("Не удалось прочитать защищённые данные из хранилища Windows."), args),
  CREDENTIAL_WRITE_FAILED: args => withDetails(t("Не удалось сохранить защищённые данные в хранилище Windows."), args),
  DEPENDENCY_UNKNOWN: () => t("Эта ссылка на компонент не поддерживается."),
  DEPENDENCY_OPEN_FAILED: args => withDetails(t("Не удалось открыть страницу компонента."), args),
  CATALOG_LINK_INVALID: args => withDetails(t("Ссылка каталога недействительна или небезопасна."), args),
  CATALOG_LINK_OPEN_FAILED: args => withDetails(t("Не удалось открыть ссылку каталога."), args),
  MODRINTH_REQUEST_INVALID: () => t("Запрос к каталогу Modrinth недействителен."),
  MODRINTH_REQUEST_FAILED: args => withDetails(t("Не удалось получить данные от Modrinth."), args),
  MODRINTH_RATE_LIMITED: () => t("Modrinth временно ограничил частоту запросов. Подождите минуту."),
  MODRINTH_HTTP_FAILED: args => t("Modrinth вернул ошибку HTTP {0}.", args[0] || ""),
  MODRINTH_RESPONSE_TOO_LARGE: () => t("Ответ Modrinth превышает допустимый размер."),
  MODRINTH_RESPONSE_INVALID: args => withDetails(t("Modrinth вернул повреждённые данные каталога."), args),
  MODRINTH_DOWNLOAD_URL_INVALID: args => withDetails(t("Адрес загрузки Modrinth недействителен или ведёт не на официальный CDN."), args),
  MODRINTH_DOWNLOAD_INVALID: () => t("Для импорта нужен JAR до 64 МиБ с корректным SHA-512."),
  MODRINTH_FILE_INTEGRITY_FAILED: () => t("Файл Modrinth не прошёл проверку размера или SHA-512."),
  GAME_ADDRESS_INVALID: () => t("Игровой адрес должен быть вида host или host:port. Пустое значение убирает кнопку подключения."),
  FILE_NOT_IN_PACK: () => t("Этот файл не входит в сборку."),
  DETACH_SERVER_SIDE_ONLY: () => t("Без удаления из сборки можно вывести только файлы с назначением «Только сервер»: у игроков такой файл удалился бы из игры. Смените назначение на «Только сервер», опубликуйте, затем выведите файл."),
  CURSEFORGE_KEY_MISSING: () => t("Сначала сохраните ключ API CurseForge на вкладке каталога."),
  CURSEFORGE_KEY_INVALID: () => t("Ключ API CurseForge выглядит повреждённым. Скопируйте его точно из console.curseforge.com."),
  CURSEFORGE_UNAUTHORIZED: () => t("CurseForge отклонил запрос с этим ключом. Используйте ключ организации со страницы «API keys» консоли console.curseforge.com (не токен со старого сайта авторов); свежесозданный ключ может активироваться несколько минут — повторите позже."),
  CURSEFORGE_RATE_LIMITED: () => t("CurseForge временно ограничил этот ключ. Повторите позже."),
  CURSEFORGE_REQUEST_FAILED: args => withDetails(t("Не удалось получить данные от CurseForge."), args),
  CURSEFORGE_HTTP_FAILED: args => t("CurseForge вернул ошибку HTTP {0}.", args[0] || ""),
  CURSEFORGE_RESPONSE_INVALID: args => withDetails(t("CurseForge вернул повреждённые данные каталога."), args),
  CURSEFORGE_RESPONSE_TOO_LARGE: () => t("Ответ CurseForge превышает допустимый размер."),
  CURSEFORGE_REDIRECT_INVALID: () => t("CurseForge перенаправил загрузку за пределы официальных хостов."),
  CURSEFORGE_FILE_INVALID: () => t("Выберите опубликованный JAR мода до 64 МиБ."),
  CURSEFORGE_FILE_INTEGRITY_FAILED: () => t("Файл CurseForge не прошёл проверку размера или SHA-1."),
  CURSEFORGE_DISTRIBUTION_BLOCKED: () => t("Автор запретил раздачу этого файла через API. Установите его вручную со страницы CurseForge."),
  CURSEFORGE_LOADER_UNSUPPORTED: () => t("Каталог поддерживает только серверы Fabric и NeoForge."),
  CURSEFORGE_QUERY_INVALID: () => t("Некорректный поисковый запрос каталога."),
  CURSEFORGE_PAGE_INVALID: () => t("Некорректная страница каталога."),
  TRANSLATOR_KEY_MISSING: () => t("Сначала сохраните ключ API Яндекс Переводчика на странице «Настройки»."),
  TRANSLATOR_KEY_INVALID: () => t("Ключ API переводчика выглядит повреждённым. Скопируйте его точно из консоли Yandex Cloud."),
  TRANSLATOR_FOLDER_INVALID: () => t("Укажите идентификатор каталога Yandex Cloud точно как в консоли (например, b1g...)."),
  TRANSLATOR_TEXTS_INVALID: () => t("Описание слишком длинное или пустое для одного запроса перевода."),
  TRANSLATOR_TARGET_INVALID: () => t("Перевод поддерживает только русский и английский языки."),
  TRANSLATOR_UNAUTHORIZED: () => t("Яндекс отклонил ключ переводчика. Проверьте ключ API, идентификатор каталога и роль ai.translate.user у сервисного аккаунта."),
  TRANSLATOR_RATE_LIMITED: () => t("Квота переводчика временно исчерпана. Повторите позже."),
  TRANSLATOR_REQUEST_FAILED: args => withDetails(t("Не удалось связаться с сервисом Яндекс Переводчика."), args),
  TRANSLATOR_HTTP_FAILED: args => t("Яндекс Переводчик вернул ошибку HTTP {0}.", args[0] || ""),
  TRANSLATOR_RESPONSE_INVALID: args => withDetails(t("Переводчик вернул повреждённые данные."), args),
  GITHUB_REPOSITORY_INVALID: args => withDetails(t("Укажите публичный репозиторий GitHub в формате владелец/репозиторий."), args),
  GITHUB_REQUEST_FAILED: args => withDetails(t("Не удалось получить данные от GitHub."), args),
  GITHUB_RATE_LIMITED: () => t("GitHub временно ограничил или отклонил запрос. Закрытые репозитории не поддерживаются."),
  GITHUB_HTTP_FAILED: args => t("GitHub вернул ошибку HTTP {0}. Проверьте адрес репозитория и опубликованные релизы.", args[0] || ""),
  GITHUB_RESPONSE_TOO_LARGE: () => t("Ответ GitHub превышает допустимый размер."),
  GITHUB_REDIRECT_INVALID: () => t("GitHub перенаправил загрузку за пределы разрешённых официальных адресов."),
  GITHUB_RESPONSE_INVALID: args => withDetails(t("GitHub вернул повреждённые данные релизов."), args),
  GITHUB_PAGE_INVALID: () => t("Номер страницы релизов GitHub недействителен."),
  GITHUB_ASSET_INVALID: () => t("Выберите опубликованный JAR мода размером до 64 МиБ."),
  GITHUB_FILE_INTEGRITY_FAILED: () => t("Файл GitHub не прошёл проверку размера или SHA-256."),
  SERVER_FILE_MODIFIED: args => t("Файл {0} изменён на сервере вне UDMC, и публикация не станет перезаписывать чужие правки. Отмените изменение файла в черновике или заберите серверную версию под управление заново.", args[0] || "?"),
  SERVER_PATH_NOT_FILE: args => t("На сервере по пути {0} лежит не файл, а папка. Уберите её или снимите этот путь со сборки.", args[0] || "?"),
  PAIRING_CODE_INVALID: () => t("Код привязки не подходит к этому серверу. Сверьте его с консолью сервера или с файлом config/udmc-pairing.txt."),
  PAIRING_ALREADY_DONE: () => t("Этот сервер уже привязан. Код действует один раз; доступ для ещё одного компьютера выдаёт владелец приглашением."),
  PAIRING_RATE_LIMIT: () => t("Слишком много попыток привязки. Подождите минуту."),
  PROJECT_BACKUP_INVALID: () => t("Это не резервная копия проекта UDMC."),
  PROJECT_BACKUP_KEYS_MISMATCH: () => t("Ключи в этой резервной копии не принадлежат одному проекту."),
  SERVER_URL_INVALID: () => t("Укажите адрес, по которому игроки достигают этот сервер: http:// или https://, без логина и пароля."),
  AGENT_BOOTSTRAP_FORBIDDEN: () => t("Этот файл агента содержит встроенные настройки и не может быть установлен. Возьмите текущий на вкладке «Скачать мод»."),
  POWER_DELAY_INVALID: () => t("Задержка должна быть от 0 до 600 секунд."),
  INVALID_REQUEST: () => t("Агент отклонил запрос. Проверьте введённые данные."),
  INTERNAL_ERROR: () => t("Внутренняя ошибка агента. Проверьте журнал сервера.")
});

export function formatAppError(error) {
  const text = String(error?.message || error?.fallback || error || "");
  const args = Array.isArray(error?.args)
    ? error.args.slice(0, 8).map(value => ["string", "number", "boolean"].includes(typeof value) ? String(value) : "")
    : [];
  const translate = typeof error?.code === "string" && Object.hasOwn(agentErrorTranslators, error.code) ? agentErrorTranslators[error.code] : null;
  if (translate) {
    const message = translate(args);
    return error?.outcomeUnknown === true ? `${message} ${t("Команда могла выполниться. Проверьте состояние сервера перед повтором.")}` : message;
  }
  // Compatibility with agents released before structured API errors.
  if (text.includes("Invalid admin token")) return t("Неверный токен администратора.");
  if (text.includes("Draft has no changes")) return t("В черновике нет изменений для публикации.");
  if (text.includes("Invalid pack version")) return t("Версия сборки может содержать только латинские буквы, цифры, точки, дефисы и знак + (до 64 символов).");
  if (text.includes("A draft file already uses path")) return t("В черновике уже есть файл с таким путём.");
  if (text.includes("Draft blob")) return t("Не удалось проверить файлы черновика. Загрузите повреждённый файл повторно.");
  if (text.includes("UDMC service files")) return t("Служебные файлы UDMC нельзя включать в сборку.");
  if (text.includes("Unsafe managed path") || text.includes("Managed path is not safe")) return t("Путь содержит недопустимые символы или имя файла.");
  if (text.includes("Remote power actions are disabled")) return t("Удалённое управление питанием отключено в настройках.");
  if (text.includes("Minecraft server is not ready")) return t("Minecraft-сервер ещё не готов.");
  if (text.includes("Invalid server command")) return t("Команда имеет неверный формат.");
  if (text.includes("Failed to fetch") || text.includes("Load failed") || text.includes("NetworkError")) return t("Не удалось связаться с сервером.");
  return text;
}

export const formatAgentError = formatAppError;

export async function agentJson(url, options = {}, timeoutMs = options.method && options.method !== "GET" ? MUTATION_TIMEOUT : REQUEST_TIMEOUT) {
  const signal = AbortSignal.timeout(timeoutMs);
  const mutation = options.method && !["GET", "HEAD"].includes(options.method);
  let received = false;
  try {
    const response = await fetch(url, { ...options, cache: "no-store", redirect: "error", signal });
    let payload;
    try {
      const body = await response.text();
      payload = body ? JSON.parse(body) : {};
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected an object");
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = new Error(t("Агент вернул некорректный ответ (HTTP {0}).{1}", response.status, mutation ? t(" Обновите данные перед повтором операции.") : ""));
      failure.status = response.status;
      failure.outcomeUnknown = Boolean(mutation);
      throw failure;
    }
    received = true;
    if (!response.ok) {
      const error = new Error(typeof payload.error === "string" ? payload.error : t("Ошибка HTTP {0}", response.status));
      error.status = response.status;
      error.code = payload.code;
      error.args = Array.isArray(payload.args) ? payload.args : [];
      error.workspace = payload.workspace;
      throw error;
    }
    const revision = response.headers?.get?.("x-udmc-revision");
    if (revision) Object.defineProperty(payload, "workspaceRevision", { value: revision, enumerable: false });
    return payload;
  } catch (error) {
    if (signal.aborted || (!received && error?.name === "TypeError")) {
      const reason = signal.aborted ? t("Агент не ответил вовремя.") : t("Связь с агентом прервана.");
      const failure = new Error(`${reason}${mutation ? t(" Операция могла выполниться: обновите данные перед повтором.") : t(" Проверьте адрес и доступность сервера.")}`);
      failure.code = signal.aborted ? "TIMEOUT" : "NETWORK";
      failure.outcomeUnknown = Boolean(mutation);
      throw failure;
    }
    throw error;
  }
}
