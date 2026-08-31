import { t } from "./i18n.js";
import { formatAgentError } from "./http.js";
import { agentStatusMessage } from "./agent-messages.js";
export function initAgentUpdates({ getContext, getBinding, getRevision, getBusy, setBusy, adminGet, adminJson, adminRaw, invoke, showToast, onState, requestRestart, getTemplates = () => [] }) {
  const $ = id => document.getElementById(id);
  let current = null, binding = null, checking = false, attempted = false, policySaving = false, addressDirty = false;
  let confirmed = null;
  let appVersion = null; // the agent version this Control builds, from dependency_status
  const parse = value => String(value || "").split(".").map(part => Number.parseInt(part, 10) || 0);
  // "Newer available" is a version comparison, not the agent's canUpdate flag: that
  // flag only says remote updates are possible at all.
  const newerAvailable = () => {
    if (!appVersion || !current?.currentVersion) return false;
    const [mine, theirs] = [parse(appVersion), parse(current.currentVersion)];
    for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
      if ((mine[i] || 0) !== (theirs[i] || 0)) return (mine[i] || 0) > (theirs[i] || 0);
    }
    return false;
  };
  // The mod for the game this server runs. One file per version, chosen by the server's
  // own answer rather than by anything the administrator has to keep in step by hand.
  const getTemplate = () => getTemplates().find(entry =>
    entry.minecraft === current?.minecraftVersion && entry.loader === current?.loaderType) || null;
  const fingerprint = () => JSON.stringify([getBinding(), getRevision(), current?.client, current?.update]);
  const pending = () => ["scheduled", "waiting"].includes(current?.update?.state);
  function render() {
    const ready = Boolean(getContext()?.agentProtocol);
    $("agentDeliverySection").hidden = !ready;
    $("agentDeliveryEmpty").hidden = ready;
    $("agentDeliveryStatus").textContent = !current ? t("Проверка агентов...")
      : current.client ? (newerAvailable()
        ? t("Агент на сервере: {0}, клиент для скачивания: {1}. В приложении есть {2} - нажмите «Обновить агенты».", current.currentVersion, current.client.version, appVersion)
        : t("Агент на сервере: {0}, клиент для скачивания: {1}. Это последняя версия из этого приложения.", current.currentVersion, current.client.version))
        : t("Клиентский JAR ещё не загружен на сервер.");
    $("agentDownloadUrl").textContent = current?.client ? current.downloadUrl : "";
    $("agentDownloadUrl").hidden = !current?.client;
    $("copyAgentDownloadButton").disabled = !current?.client;
    $("agentClientUploadButton").hidden = Boolean(current?.client);
    $("agentClientUploadButton").disabled = !current?.signed || getBusy();
    $("agentUpdateButton").disabled = !current?.canUpdate || !current?.signed || getBusy() || pending();
    // Update-and-restart needs the same rights plus remote power actions: when the
    // server forbids them the button stays grey and says why on hover.
    const powerAllowed = getContext()?.capabilities?.powerActions === true;
    const restartButton = $("agentUpdateRestartButton");
    restartButton.disabled = $("agentUpdateButton").disabled || !powerAllowed;
    restartButton.title = !powerAllowed
      ? t("Остановка и перезапуск из панели выключены. Включите их на странице «Сервер» в блоке «Действия сервера».")
      : pending() ? t("Обновление уже подготовлено: остановите или перезапустите сервер, чтобы оно применилось.")
        : t("Подготовит обновление и сразу предложит перезапуск с предупреждением игроков.");
    // Keep the switch where the player put it until the server answers, so it does not
    // flick back to the old value for the length of the request.
    if (!policySaving) $("requireClientAgent").checked = current?.requireClient === true;
    $("requireClientAgent").disabled = !current?.client || getBusy();
    if (!addressDirty && document.activeElement !== $("gameAddressInput")) $("gameAddressInput").value = current?.gameAddress || "";
    $("gameAddressInput").disabled = !current || getBusy();
    $("agentPolicySave").disabled = !current || getBusy();
    const state = current?.update?.state;
    $("agentUpdateState").textContent = pending() ? t("Обновление {0} подготовлено. Остановите Minecraft-сервер; JAR заменится после выхода процесса. Затем запустите сервер.", current.update.version)
      : state === "applied" ? t("Обновление {0} применено: файл заменён, сервер начнёт использовать его после перезапуска процесса. Резервная копия: {1}.", current.update.version, current.update.backup)
        : ["failed", "interrupted"].includes(state) ? t("Обновление не завершено: {0}. Проверьте udmc-sync/agent-update/helper.log и повторите. Если сбой повторяется (хостинг жёстко завершает процессы), замените серверный JAR вручную через «Создать JAR» - ключи и настройки сохранятся.", agentStatusMessage(current.update, t("процесс обновления прерван")))
          : agentStatusMessage(current?.updateReason);
    // A pre-0.10.0 agent still updates through the killable external helper: after a
    // failure the panel route cannot succeed there, so offer the one-time manual path.
    $("agentManualUpdateButton").hidden = !["failed", "interrupted"].includes(state);
    // "Applied" means the file is already swapped but the running process still uses the
    // old one: that is awaiting a restart, and it clears itself once versions match.
    const appliedAwaitingRestart = state === "applied" && current?.update?.version
      && current.update.version !== current.currentVersion;
    const awaitingRestart = pending() || Boolean(appliedAwaitingRestart);
    onState?.({ canUpdate: Boolean(current?.canUpdate && current?.signed && newerAvailable() && !awaitingRestart),
      pending: awaitingRestart,
      failed: ["failed", "interrupted"].includes(state) && newerAvailable(),
      version: current?.currentVersion || null, available: appVersion });
  }
  async function load(auto = false) {
    const context = getContext();
    if (!context?.agentProtocol || checking) return;
    if (!appVersion) {
      try { appVersion = (await invoke("dependency_status"))?.version || null; } catch { appVersion = null; }
    }
    if (binding !== getBinding()) { binding = getBinding(); current = null; attempted = false; addressDirty = false; }
    const started = binding;
    checking = true;
    try {
      const result = await adminGet("/admin/agents");
      if (started !== getBinding()) return;
      current = result; render();
      if (auto && !attempted && !result.client && result.signed && !getBusy()) {
        attempted = true;
        await upload(false);
      }
    } catch (error) { if (started === getBinding()) { $("agentDeliveryStatus").textContent = formatAgentError(error); } }
    finally { checking = false; }
  }
  // Returns whether the package really reached the server: the caller decides about
  // a follow-up restart from this, not from a guessed state transition.
  async function upload(update) {
    if (getBusy() || !current) return false;
    const started = getBinding();
    setBusy(true); render();
    $("agentDeliveryProgress").hidden = false;
    $("agentDeliveryStatus").textContent = update ? t("Подготовка обновления агентов...") : t("Подготовка клиентского JAR...");
    try {
      // One file for both roles now, chosen by the game version this server runs.
      const template = getTemplate();
      if (!template) throw new Error(t("В этой сборке Control нет мода для версии, на которой работает сервер."));
      const result = await invoke("prepare_agent_package", {
        request: { templateId: template.id, loaderVersion: template.loaderVersion }, update
      });
      if (started !== getBinding()) return;
      const bytes = Uint8Array.from(atob(result.bytes), char => char.charCodeAt(0));
      if (bytes.length !== result.size || bytes.length > 16 * 1024 * 1024) throw new Error(t("Некорректный пакет агента"));
      $("agentDeliveryStatus").textContent = t("Отправка на сервер...");
      const response = await adminRaw(`/admin/agents/${update ? "update" : "client"}`, new Blob([bytes]), { "content-type": "application/octet-stream" });
      if (started !== getBinding()) return false;
      current = response;
      showToast(update ? t("Агенты подготовлены к обновлению. Серверу и игрокам нужен перезапуск.") : t("Клиентский JAR доступен для игроков"));
      return true;
    } catch (error) {
      if (started === getBinding()) {
        showToast(formatAgentError(error), "error");
        try {
          const latest = await adminGet("/admin/agents");
          if (started === getBinding()) current = latest;
        } catch { /* Keep the last known state visible. */ }
      }
      return false;
    } finally {
      if (started === getBinding()) { $("agentDeliveryProgress").hidden = true; setBusy(false); render(); }
    }
  }
  $("agentClientUploadButton").addEventListener("click", () => upload(false));
  let restartAfterUpdate = false;
  const openUpdateConfirm = withRestart => {
    if (getBusy() || !current || pending()) return;
    restartAfterUpdate = withRestart;
    confirmed = fingerprint();
    $("agentUpdateConfirmRestart").hidden = !withRestart;
    $("agentUpdateConfirmSubmit").textContent = withRestart ? t("Обновить и перезапустить") : t("Подготовить обновление");
    $("agentUpdateConfirmDialog").showModal();
  };
  $("agentUpdateButton").addEventListener("click", () => openUpdateConfirm(false));
  $("agentUpdateRestartButton").addEventListener("click", () => openUpdateConfirm(true));
  $("agentUpdateConfirmForm").addEventListener("submit", async event => {
    event.preventDefault();
    const valid = confirmed !== null && confirmed === fingerprint();
    const withRestart = restartAfterUpdate;
    $("agentUpdateConfirmDialog").close(); confirmed = null;
    if (!valid) { showToast(t("Настройки изменились, пока окно было открыто. Закройте его и проверьте актуальные значения."), "error"); return; }
    // Restart only after the package actually reached the server. The agent may either
    // stage it for shutdown or swap the file in place ("applied"): both need a restart.
    const delivered = await upload(true);
    if (withRestart && delivered) requestRestart?.();
    else if (withRestart) showToast(t("Обновление не передано на сервер, перезапуск отменён."), "error");
  });
  $("agentUpdateConfirmDialog").addEventListener("close", () => { confirmed = null; });
  // A switch applies the moment it is flipped. The save button sits next to the address
  // field, so it read as the address's button: the login rule looked switched on and
  // then came back off after the next reload, because nothing had been sent.
  async function savePolicy(message) {
    if (getBusy() || !current) return;
    const started = getBinding();
    // Read the form before redrawing it: the redraw restores server values into the
    // fields, and the address the administrator just typed would be sent as the old one.
    const payload = { requireClient: $("requireClientAgent").checked, gameAddress: $("gameAddressInput").value.trim() };
    policySaving = true; setBusy(true); render();
    try {
      const value = await adminJson("/admin/agents/settings", payload);
      if (started === getBinding()) { current = value; addressDirty = false; showToast(message); }
    } catch (error) { showToast(formatAgentError(error), "error"); }
    finally { policySaving = false; if (started === getBinding()) { setBusy(false); render(); } }
  }
  // A rejected address stays in the field so it can be corrected, instead of snapping
  // back to the last accepted one.
  $("gameAddressInput").addEventListener("input", () => { addressDirty = true; });
  $("requireClientAgent").addEventListener("change", () => savePolicy($("requireClientAgent").checked
    ? t("Теперь войти можно только с клиентским UDMC")
    : t("Теперь войти можно и без клиентского UDMC")));
  $("agentPolicyForm").addEventListener("submit", event => { event.preventDefault(); savePolicy(t("Игровой адрес сохранён")); });
  $("agentManualUpdateButton").addEventListener("click", () => {
    document.querySelector('[data-agent-mode="create"]')?.click();
    document.querySelector('[data-agent-panel="create"]')?.scrollIntoView({ block: "start" });
    showToast(t("Сформируйте JAR в этом же профиле: ключи и настройки сервера сохранятся. Затем остановите сервер, замените udmc-sync-server.jar в mods и запустите."));
  });
  $("copyAgentDownloadButton").addEventListener("click", async () => {
    if (!current?.client) return;
    try { await navigator.clipboard.writeText(current.downloadUrl); showToast(t("Ссылка скопирована")); }
    catch (error) { showToast(formatAgentError(error), "error"); }
  });
  return { connected: () => load(true), refresh: () => load(false), render,
    invalidateConfirmation: () => { confirmed = null; $("agentUpdateConfirmDialog").close(); },
    reset: () => { current = null; binding = null; attempted = false; confirmed = null; $("agentUpdateConfirmDialog").close(); render(); } };
}
