import { t, getLocale, countText } from "./i18n.js";
import { diagnosticMessage } from "./agent-messages.js";
import { formatAgentError } from "./http.js";
const descriptions = {
  help: t("Справка по командам и их аргументам."), list: t("Список игроков онлайн."),
  "save-all": t("Сохранить мир на диск. flush дожидается окончания записи."),
  "save-on": t("Включить автоматическое сохранение мира."), "save-off": t("Отключить автоматическое сохранение мира."),
  whitelist: t("Управление списком игроков с разрешённым входом."),
  time: t("Узнать или изменить игровое время."), weather: t("Изменить погоду в мире."),
  gamerule: t("Посмотреть или изменить правила мира."), difficulty: t("Узнать или изменить сложность."),
  gamemode: t("Изменить игровой режим игрока."), defaultgamemode: t("Установить режим для новых игроков."),
  say: t("Отправить сообщение всем игрокам от имени сервера."), tell: t("Отправить личное сообщение игроку."),
  msg: t("Отправить личное сообщение игроку."), tellraw: t("Отправить сообщение в JSON-формате."),
  kick: t("Отключить игрока от сервера."), ban: t("Запретить игроку вход на сервер."),
  pardon: t("Снять блокировку игрока."), banlist: t("Показать список блокировок."),
  "ban-ip": t("Запретить подключения с IP-адреса."), "pardon-ip": t("Снять блокировку IP-адреса."),
  op: t("Выдать права оператора."), deop: t("Забрать права оператора."),
  stop: t("Сохранить мир и остановить сервер."), reload: t("Перезагрузить datapack-ресурсы. Не перезагружает JAR-моды."),
  tp: t("Телепортировать сущность или игрока."), teleport: t("Телепортировать сущность или игрока."),
  give: t("Выдать предметы игроку."), clear: t("Удалить предметы из инвентаря."),
  kill: t("Уничтожить выбранные сущности."), fill: t("Заполнить область блоками."),
  setblock: t("Установить блок по координатам."), clone: t("Скопировать область мира."),
  execute: t("Выполнить команду с условиями, позицией или от имени сущности."),
  effect: t("Управление эффектами сущностей."), enchant: t("Наложить зачарование на предмет."),
  experience: t("Управление опытом игроков."), xp: t("Управление опытом игроков."),
  scoreboard: t("Управление счётом, целями и показателями."), team: t("Управление командами игроков."),
  datapack: t("Включить, отключить или перечислить datapack-пакеты."),
  worldborder: t("Настроить границу мира."), seed: t("Показать seed мира."),
  spawnpoint: t("Задать точку возрождения игрока."), setworldspawn: t("Задать общую точку появления."),
  tick: t("Управление скоростью тиков и паузой симуляции."),
  perf: t("Записать диагностический профиль производительности.")
};
const risky = new Set(["stop", "save-off", "op", "deop", "ban", "ban-ip", "kill", "clear", "fill", "clone", "setblock", "datapack"]);
const $ = (id) => document.getElementById(id);

export function initServerTools({ adminGet, adminJson, refresh, showToast, getBusy, setBusy, getBinding, getRevision, insertCommand, removeServerFile, removeManagedFile, onValidation, getDirty }) {
  let commands = [];
  let commandRequest = 0;
  let inventoryRequest = 0;
  let inventoryBinding = null;
  const validationRequest = { draft: 0, server: 0 };
  const validationState = { draft: null, server: null };
  let validationSupported = false;
  let draftValidatedRevision = null;
  let serverValidatedSequence = null;
  let draftValidationTimer = null;
  const report = (error) => showToast(formatAgentError(error), "error");
  const notifyValidation = () => onValidation?.({ supported: validationSupported, draft: validationState.draft, server: validationState.server });
  function reset() {
    commandRequest++; validationRequest.draft++; validationRequest.server++; commands = [];
    clearTimeout(draftValidationTimer);
    $("commandCatalogSource").textContent = t("Нет данных сервера");
    $("commandCatalog").textContent = t("Подключите UDMC Agent, чтобы получить команды этого сервера.");
    resetInventory();
    validationState.draft = validationState.server = null;
    validationSupported = false;
    draftValidatedRevision = null;
    serverValidatedSequence = null;
    renderValidation();
    notifyValidation();
  }
  // The composition check runs by itself: a changed draft revision re-checks the
  // draft, a new published release re-checks the server. The button only re-runs.
  function receiveRevision(revision) {
    if (!validationSupported || revision == null || revision === draftValidatedRevision) return;
    clearTimeout(draftValidationTimer);
    draftValidationTimer = setTimeout(() => {
      draftValidatedRevision = revision;
      runValidation("draft");
    }, 400);
  }
  function syncStatus(status, manifest) {
    const supported = status?.capabilities?.modValidation === true;
    if (supported !== validationSupported) {
      validationSupported = supported;
      if (!supported) { validationState.draft = validationState.server = null; }
      renderValidation();
      notifyValidation();
    }
    if (!supported) return;
    const sequence = manifest?.releaseSequence;
    if (sequence != null && sequence !== serverValidatedSequence) {
      serverValidatedSequence = sequence;
      runValidation("server");
    }
  }
  function renderValidation() {
    const target = $("validationTarget").value;
    const state = validationState[target];
    const box = $("validationResult");
    box.replaceChildren();
    if (!validationSupported) { box.textContent = t("Сервер не поддерживает проверку состава. Обновите UDMC Agent."); return; }
    if (!state) { box.textContent = t("Проверка ещё не выполнялась."); return; }
    if (state.pending) { box.textContent = t("Проверяем метаданные модов..."); return; }
    if (state.error) { box.textContent = state.error; return; }
    const summary = document.createElement("strong");
    summary.textContent = state.ok ? t("В метаданных проблем не найдено") : t("Найдено проблем: {0}", state.issues.length);
    box.append(summary);
    if (!getDirty?.()) {
      const same = document.createElement("p"); same.className = "muted-copy";
      same.textContent = t("Черновик сейчас совпадает с сервером, поэтому оба варианта состава дают одинаковый результат.");
      box.append(same);
    }
    const checkedAt = new Date(state.checkedAt);
    if (Number.isFinite(checkedAt.getTime())) {
      const when = document.createElement("p"); when.className = "security-note";
      when.textContent = t("Проверено: {0}. Изменения файлов вне UDMC требуют новой проверки.", checkedAt.toLocaleString(getLocale()));
      box.append(when);
    }
    for (const issue of state.issues) {
      const item = document.createElement("div"); item.className = "validation-issue";
      const side = document.createElement("span"); side.className = "state-badge neutral"; side.textContent = issue.side === "client" ? t("Клиент") : t("Сервер");
      const message = document.createElement("p"); message.textContent = diagnosticMessage(issue);
      item.append(side, message); box.append(item);
    }
  }
  async function runValidation(target, manual = false) {
    if (!validationSupported) { if (manual) renderValidation(); return; }
    const binding = getBinding(), request = ++validationRequest[target];
    validationState[target] = { pending: true };
    renderValidation();
    notifyValidation();
    try {
      const result = await adminGet(`/admin/validation?target=${target}`);
      if (binding !== getBinding() || request !== validationRequest[target]) return;
      validationState[target] = { ok: result.ok, issues: Array.isArray(result.issues) ? result.issues : [], checkedAt: result.checkedAt };
      if (target === "draft" && result.revision != null) draftValidatedRevision = result.revision;
    } catch (error) {
      if (binding !== getBinding() || request !== validationRequest[target]) return;
      validationState[target] = { error: formatAgentError(error) };
      if (manual) report(error);
    }
    renderValidation();
    notifyValidation();
  }
  function ensureValidation() {
    if (validationSupported && !validationState[$("validationTarget").value]) runValidation($("validationTarget").value);
  }
  function showValidation(target) {
    $("validationTarget").value = target;
    renderValidation();
    ensureValidation();
  }
  function resetInventory() { inventoryRequest++; inventoryBinding = null; $("serverInventory").replaceChildren(); }
  function ensureInventory() {
    if (inventoryBinding !== getBinding()) loadInventory(false);
  }
  function renderCommands() {
    const query = $("commandSearch").value.toLowerCase().trim();
    const filtered = commands.filter((command) => `${command.name} ${descriptions[command.name] || ""}`.toLowerCase().includes(query));
    $("commandCatalog").replaceChildren();
    for (const command of filtered) {
      const item = document.createElement("details"); item.className = "command-item";
      const summary = document.createElement("summary");
      const name = document.createElement("strong"); name.textContent = `/${command.name}`;
      const description = document.createElement("span"); description.textContent = descriptions[command.name] || t("Команда сервера или мода. Описание не предоставлено сервером.");
      summary.append(name, description); item.append(summary);
      for (const usage of command.usage || [command.name]) {
        const row = document.createElement("div"); row.className = "command-syntax";
        const syntax = document.createElement("code"); syntax.textContent = usage;
        const insert = document.createElement("button"); insert.className = "icon-button compact-icon"; insert.type = "button";
        insert.title = t("Вставить в консоль без выполнения"); insert.setAttribute("aria-label", t("Вставить {0}", command.name));
        const icon = document.createElement("i"); icon.dataset.lucide = "corner-left-up"; insert.append(icon);
        insert.addEventListener("click", () => insertCommand(usage));
        row.append(syntax, insert); item.append(row);
      }
      if (risky.has(command.name)) {
        const warning = document.createElement("p"); warning.className = "command-risk";
        warning.textContent = t("Меняет мир, доступ игроков или состояние сервера. Проверьте аргументы перед выполнением."); item.append(warning);
      }
      $("commandCatalog").append(item);
    }
    if (!filtered.length) $("commandCatalog").textContent = commands.length ? t("Команды не найдены") : t("Нет данных команд сервера");
    window.lucide?.createIcons();
  }
  async function refreshCommands(manual = false) {
    const request = ++commandRequest;
    const binding = getBinding();
    try {
      const data = await adminGet("/admin/server/commands");
      if (request !== commandRequest || binding !== getBinding()) return;
      commands = data.commands.filter((command) => typeof command.name === "string" && Array.isArray(command.usage));
      commands.sort((a, b) => a.name.localeCompare(b.name));
      $("commandCatalogSource").textContent = `${data.source === "development" ? t("Тестовый API") : t("Команды UDMC-сервера")} · Minecraft ${data.minecraftVersion} · ${commands.length}`;
      renderCommands();
    } catch (error) {
      if (request !== commandRequest || binding !== getBinding()) return;
      commands = [];
      $("commandCatalogSource").textContent = t("Сервер не предоставил справочник");
      $("commandCatalog").textContent = t("Обновите UDMC Agent и проверьте подключение. Для RCON без агента справка доступна командой help.");
      if (manual) report(error);
    }
  }
  $("commandSearch").addEventListener("input", renderCommands);
  $("refreshCommandsButton").addEventListener("click", () => refreshCommands(true));
  async function loadInventory(manual) {
    if (manual && getBusy()) return;
    const binding = getBinding(), request = ++inventoryRequest;
    inventoryBinding = binding;
    if (manual) setBusy(true);
    $("scanServerFilesButton").disabled = true;
    if (!manual) $("serverInventory").replaceChildren(Object.assign(document.createElement("p"), { className: "muted-copy", textContent: t("Запрашиваем файлы сервера...") }));
    try {
      const inventory = await adminGet("/admin/server/files");
      if (binding !== getBinding() || request !== inventoryRequest) return;
      $("serverInventory").replaceChildren();
      const scope = document.createElement("p"); scope.className = "muted-copy";
      scope.textContent = t("Файлы опубликованной сборки здесь не показываются - они живут на вкладках «Черновик» и «Опубликовано». Тут только то, что попало на сервер мимо UDMC. Взяли файл под управление и передумали? Пока не опубликовано, на вкладке «Черновик» нажмите «Отменить изменение» - файл вернётся сюда. Назначение «Только сервер» игрокам не раздаётся.");
      $("serverInventory").append(scope);
      const note = document.createElement("p"); note.className = "security-note";
      note.textContent = inventory.files.length ? t("Проверьте назначение. Конфиги могут содержать пароли. Принятие добавит файл в черновик; управление начнётся после публикации.") : t("Все файлы в доступных папках сервера уже управляются сборкой. Здесь появится то, что положат на сервер вручную.");
      $("serverInventory").append(note);
      const picked = new Map();
      const bulkBar = document.createElement("div"); bulkBar.className = "inventory-bulk"; bulkBar.hidden = true;
      const bulkCount = document.createElement("strong");
      const bulkRemove = document.createElement("button"); bulkRemove.type = "button"; bulkRemove.className = "button danger-outline"; bulkRemove.id = "serverBulkRemove";
      bulkRemove.textContent = t("Удалить выбранные с сервера");
      const bulkClear = document.createElement("button"); bulkClear.type = "button"; bulkClear.className = "text-button"; bulkClear.textContent = t("Снять выбор");
      bulkBar.append(bulkCount, bulkRemove, bulkClear);
      if (inventory.files.length) $("serverInventory").append(bulkBar);
      const checkboxes = [];
      const renderBulk = () => {
        bulkBar.hidden = picked.size === 0;
        bulkCount.textContent = t("Выбрано: {0}", picked.size);
      };
      bulkClear.addEventListener("click", () => { picked.clear(); for (const box of checkboxes) box.checked = false; renderBulk(); });
      bulkRemove.addEventListener("click", () => {
        if (getBusy() || !picked.size) return;
        if (binding !== getBinding() || request !== inventoryRequest) { showToast(t("Список файлов устарел. Проверьте сервер заново."), "error"); return; }
        openBulkRemoval([...picked.values()]);
      });
      if (inventory.truncated) {
        const limit = document.createElement("p"); limit.textContent = t("Показаны первые 1000 файлов."); $("serverInventory").append(limit);
      }
      for (const file of inventory.files) {
        const row = document.createElement("div"); row.className = "inventory-row";
        const pick = document.createElement("input"); pick.type = "checkbox"; pick.className = "inventory-pick";
        pick.setAttribute("aria-label", t("Выбрать для удаления: {0}", file.path));
        pick.disabled = file.removalPending;
        pick.addEventListener("change", () => { if (pick.checked) picked.set(file.path, file); else picked.delete(file.path); renderBulk(); });
        checkboxes.push(pick);
        const copy = document.createElement("div");
        const name = document.createElement("strong"); name.textContent = file.path;
        const size = document.createElement("small"); size.textContent = t("{0} КиБ · вне сборки", (file.size / 1024).toFixed(1));
        copy.append(name, size);
        const side = document.createElement("select"); side.setAttribute("aria-label", t("Назначение {0}", file.path));
        side.add(new Option(t("Только сервер"), "server")); side.add(new Option(t("Клиент + сервер"), "both")); side.add(new Option(t("Только клиент"), "client"));
        const button = document.createElement("button"); button.type = "button"; button.className = "button subtle"; button.textContent = t("Под управление");
        button.title = t("UDMC начнёт обновлять файл и раздавать его по выбранному назначению");
        button.disabled = file.removalPending; side.disabled = file.removalPending;
        if (file.removalPending) size.textContent += t(" · удаление в черновике");
        button.addEventListener("click", async () => {
          if (getBusy()) return;
          if (binding !== getBinding() || request !== inventoryRequest) { showToast(t("Список файлов устарел. Проверьте сервер заново."), "error"); return; }
          setBusy(true); button.disabled = true;
          try {
            await adminJson("/admin/server/files/import", { path: file.path, sha256: file.sha256, side: side.value });
            if (binding !== getBinding()) return;
            row.remove();
            await refresh();
            showToast(t("Файл добавлен в черновик"));
          } catch (error) { button.disabled = false; report(error); } finally { setBusy(false); }
        });
        const actions = document.createElement("div"); actions.className = "row-actions";
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "icon-button compact-icon";
        remove.disabled = file.removalPending; remove.title = t("Удалить с сервера после публикации"); remove.setAttribute("aria-label", t("Удалить с сервера: {0}", file.path));
        const trash = document.createElement("i"); trash.dataset.lucide = "trash-2"; remove.append(trash);
        remove.addEventListener("click", () => {
          if (getBusy()) return;
          if (binding !== getBinding() || request !== inventoryRequest) { showToast(t("Список устарел. Запросите файлы снова."), "error"); return; }
          removeServerFile(file);
        });
        actions.append(button, remove);
        row.append(pick, copy, side, actions); $("serverInventory").append(row);
      }
      window.lucide?.createIcons();
    } catch (error) {
      if (binding === getBinding() && request === inventoryRequest) {
        inventoryBinding = null;
        $("serverInventory").replaceChildren(Object.assign(document.createElement("p"), { className: "muted-copy", textContent: formatAgentError(error) }));
        if (manual) report(error);
      }
    } finally { if (manual) setBusy(false); $("scanServerFilesButton").disabled = false; }
  }
  let bulkFiles = [];
  let bulkKind = "unmanaged";
  function openBulkRemoval(files, kind = "unmanaged") {
    bulkFiles = files;
    bulkKind = kind;
    $("bulkRemoveTitle").textContent = kind === "managed"
      ? t("Удалить из сборки: {0}?", countText("files", files.length))
      : t("Удалить с сервера: {0}?", countText("files", files.length));
    $("bulkRemoveText").textContent = kind === "managed"
      ? t("Файлы будут помечены на удаление в черновике. С сервера и у игроков они исчезнут после публикации; только что добавленные просто уберутся из черновика.")
      : t("Удаление попадёт в черновик и применится к серверу после публикации, с резервными копиями. Личные файлы игроков не затрагиваются.");
    const list = $("bulkRemoveList");
    list.replaceChildren(...files.slice(0, 12).map(file => Object.assign(document.createElement("code"), { textContent: file.path })));
    if (files.length > 12) list.append(Object.assign(document.createElement("span"), { textContent: t("...и ещё {0}", countText("files", files.length - 12)) }));
    $("bulkRemoveDialog").showModal();
  }
  $("bulkRemoveForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (getBusy() || !bulkFiles.length) return;
    const binding = getBinding();
    const files = bulkFiles;
    const kind = bulkKind;
    setBusy(true);
    $("bulkRemoveConfirm").disabled = true;
    try {
      for (const file of files) {
        if (binding !== getBinding()) throw new Error(t("Подключение изменилось. Проверьте список заново."));
        if (kind === "managed") await removeManagedFile(file);
        else await adminJson("/admin/server/files/remove", { path: file.path, sha256: file.sha256 });
      }
      $("bulkRemoveDialog").close();
      bulkFiles = [];
      showToast(kind === "managed"
        ? t("Помечено на удаление: {0}. Применится при публикации.", countText("files", files.length))
        : t("Удаление добавлено в черновик: {0}. Применится после публикации.", countText("files", files.length)));
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
      $("bulkRemoveConfirm").disabled = false;
      await refresh();
      if (kind !== "managed" && binding === getBinding()) loadInventory(false);
    }
  });
  $("scanServerFilesButton").addEventListener("click", () => loadInventory(true));
  $("validateModsButton").addEventListener("click", () => { if (!getBusy()) runValidation($("validationTarget").value, true); });
  $("validationTarget").addEventListener("change", renderValidation);
  return { refreshCommands, reset, resetInventory, receiveRevision, syncStatus, ensureValidation, ensureInventory, showValidation, openBulkRemoval };
}
