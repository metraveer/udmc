import { t } from "./i18n.js";
import { agentJson, formatAppError } from "./http.js";

const $ = (id) => document.getElementById(id);

// What the agent prints for `/udmc pair`, in one line so a panel can read it back.
const CODE = /\b([2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3})\b/;
const API_PORT = /API port (\d{1,5})\b/;

/**
 * Claiming a server. The owner types a code, or hands over an RCON password once and lets the
 * panel read the code itself. Nothing here is generated locally: the project already exists on
 * the server, and pairing only decides which panel gets to manage it.
 */
export function initPairing({ getConnection, onPaired, showToast, getBusy, setBusy, addressChosen = () => true,
  adminGet = null, isOwner = () => false, consoleUsable = () => true }) {
  const section = $("pairSection");
  // The explanation the question mark carries while a code is still wanted.
  const codeHint = section.querySelector(".hint").dataset.hint;
  const inputs = () => section.querySelectorAll("input,button");
  let busy = false;
  // A project saved from a server that is gone. Held until the code is entered: restoring is
  // the same act as claiming, and the code is what says this server may be spoken for.
  let restoring = null;
  // Set when the owner asks for the field back, or when reading the code over the console has
  // just failed: the way in must not disappear with the thing that did not work.
  let manualEntry = false;
  let paired = false;
  const invoke = (name, args) => {
    const call = window.__TAURI__?.core?.invoke;
    if (!call) throw new Error(t("Эта операция доступна в Windows-приложении UDMC Control."));
    return call(name, args);
  };

  const setLocalBusy = (value) => {
    busy = value;
    setBusy(value);
    inputs().forEach((input) => { input.disabled = value; });
    syncButton();
  };

  /** The console password doubles as a way in: with it the panel can read the code itself. */
  const rconReady = () => Boolean(window.__TAURI__?.core?.invoke
    && $("rconHostInput").value.trim() && $("rconPasswordInput").value && consoleUsable());

  /**
   * There is one button because there is one intention. Which of the two former buttons to
   * press was a question about the panel's plumbing, not about the server.
   */
  const syncButton = () => {
    // Either the panel can fetch the code itself, or someone types it in. Showing both at once
    // was the question this used to ask instead of answering. Once the server is claimed there
    // is nothing to ask at all, and the field gives way to what it was asking for.
    const viaRcon = rconReady() && !manualEntry && !paired;
    const code = $("pairCodeInput").value.trim();
    $("pairedSummary").hidden = !paired;
    $("pairRconButton").hidden = !viaRcon;
    $("pairManualButton").hidden = !viaRcon;
    $("pairEntry").hidden = viaRcon || paired;
    $("pairButton").hidden = viaRcon || paired || !code;
    $("pairButton").disabled = busy || getBusy();
    $("pairRconButton").disabled = busy || getBusy();
    // A project is put back onto a server that has not been claimed yet; there is nowhere to
    // put it once one is.
    $("pairRestoreButton").disabled = busy || getBusy() || section.hidden || paired;
    $("pairFieldLabel").textContent = paired ? t("Состояние привязки") : t("Код привязки");
    section.querySelector(".hint").dataset.hint = paired
      ? t("Сервер уже под управлением этой панели. Код привязки тратится один раз: второй раз он не понадобится и не сработает.")
      : codeHint;
  };
  const report = (error) => showToast(formatAppError(error), "error");
  /**
   * The one thing on this tab that says where the server stands. What used to be a paragraph
   * under it is the explanation it carries: read on hover, out of the way the rest of the time.
   */
  const badge = (text, state, hint = "") => {
    const element = $("pairAvailability");
    element.textContent = text;
    element.className = `state-badge ${state}`;
    if (hint) element.setAttribute("data-hint", hint); else element.removeAttribute("data-hint");
  };

  const address = () => {
    const { url } = getConnection();
    if (!url) throw new Error(t("Сначала укажите адрес UDMC на вкладке «Подключение»."));
    return url.replace(/\/+$/, "");
  };

  /** Tells the owner whether this server is still waiting before they go hunting for a code. */
  const check = async () => {
    let base;
    try { base = address(); } catch { badge(t("Адрес не задан"), "neutral"); return; }
    badge(t("Проверка"), "neutral");
    try {
      const state = await agentJson(`${base}/pair`);
      // A claimed server still has something to say here: which project this panel is holding.
      section.hidden = false;
      paired = !state.unpaired;
      if (paired) {
        badge(t("Привязан"), "online", t("Панель управляет этим проектом."));
        $("pairedSummary").value = [state.packName || "UDMC",
          state.minecraftVersion ? `Minecraft ${state.minecraftVersion}` : "", state.loaderType]
          .filter(Boolean).join(" · ");
      } else {
        badge(t("Ждёт привязки"), "warning attention",
          t("Сервер «{0}» (Minecraft {1}, {2}) ещё никем не занят. Введите его код, чтобы взять под управление.",
            state.packName || "UDMC", state.minecraftVersion || "?", state.loaderType || "?"));
      }
      syncButton();
    } catch (error) {
      // A server that cannot be reached might be anything; do not put a form in the way.
      section.hidden = true;
    }
  };

  const fetchByRcon = async () => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) { report(new Error(t("RCON доступен только в установленном приложении UDMC Control."))); return false; }
    // The same RCON connection the console uses. One server, one password, entered once.
    const port = Number($("rconPortInput").value);
    const password = $("rconPasswordInput").value;
    if (!$("rconHostInput").value.trim() || !password) {
      report(new Error(t("Заполните подключение RCON выше: адрес и пароль из server.properties.")));
      return false;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { report(new Error(t("Укажите порт RCON от 1 до 65535."))); return false; }
    setLocalBusy(true);
    try {
      const output = await invoke("rcon_execute", {
        host: $("rconHostInput").value.trim(),
        port,
        password,
        command: "udmc pair"
      });
      const code = CODE.exec(output);
      if (!code) {
        // Either this is not a UDMC server, or it is already paired and said so.
        throw new Error(/already paired/i.test(output)
          ? t("Сервер уже привязан к панели.")
          : t("Сервер не выдал код. Ответ: {0}", output.trim().slice(0, 200) || t("пусто")));
      }
      $("pairCodeInput").value = code[1];
      const apiPort = API_PORT.exec(output);
      $("pairApiPort").textContent = apiPort ? t("Агент слушает порт {0}", apiPort[1]) : "";
      return true;
    } catch (error) {
      report(error);
      return false;
    } finally {
      setLocalBusy(false);
    }
  };

  /** Reads the code over the console and claims the server with it. */
  const pairByRcon = async () => {
    if (busy || getBusy()) return;
    if (!await fetchByRcon()) {
      // The console did not give it up; the field is the way that is left.
      manualEntry = true;
      syncButton();
      $("pairCodeInput").focus();
      return;
    }
    await submit();
  };

  const submit = async () => {
    if (busy || getBusy()) return;
    const code = $("pairCodeInput").value.trim();
    if (!code) { report(new Error(t("Введите код привязки."))); return; }
    setLocalBusy(true);
    try {
      const base = address();
      const project = await agentJson(`${base}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(restoring ? { code, project: restoring } : { code })
      });
      $("pairCodeInput").value = "";
      badge(t("Привязан"), "online");
      restoring = null;
      $("pairRestoreState").textContent = "";
      $("pairFingerprint").textContent = project.fingerprint || "";
      $("pairResult").hidden = false;
      $("pairResultSummary").textContent = t("Привязан проект «{0}», Minecraft {1}, {2}.",
        project.packName || project.packId || "UDMC", project.minecraftVersion || "?", project.loaderType || "?");
      await onPaired(project);
      showToast(t("Сервер привязан."), "success");
      await check();
    } catch (error) {
      report(error);
    } finally {
      setLocalBusy(false);
    }
  };

  /** Loads a saved project so the next pairing puts it back instead of keeping the new one. */
  const loadBackup = async () => {
    if (busy || getBusy()) return;
    try {
      const text = await invoke("read_project_backup", { dialogTitle: t("Выберите файл резервной копии проекта") });
      if (!text) return;
      const project = JSON.parse(text);
      if (!project || typeof project !== "object" || project.format !== "udmc-project-backup-1") {
        throw new Error(t("Это не файл резервной копии проекта UDMC."));
      }
      restoring = project;
      $("pairRestoreState").textContent = t("Будет восстановлен проект «{0}»", project.packName || project.packId || "UDMC");
      // The next step is the code of the server this project is going onto, and that is on the
      // page behind this dialog.
      $("backupDialog").close();
      showToast(t("Копия проекта загружена. Введите код привязки нового сервера."));
    } catch (error) { report(error); }
  };

  /** Asks the server for its project, keys included, and writes it where the owner chooses. */
  const saveBackup = async () => {
    if (busy || getBusy() || !adminGet) return;
    setLocalBusy(true);
    try {
      const project = await adminGet("/admin/project/backup");
      const saved = await invoke("save_project_backup", {
        content: JSON.stringify(project, null, 2),
        fileName: `udmc-${project.packId || "project"}-backup.json`,
        dialogTitle: t("Куда сохранить копию проекта")
      });
      if (!saved) return;
      $("projectBackupState").textContent = saved;
      showToast(t("Копия проекта сохранена."));
    } catch (error) { report(error); } finally { setLocalBusy(false); }
  };

  $("pairButton").addEventListener("click", () => { submit().catch(report); });
  $("pairRconButton").addEventListener("click", () => { pairByRcon().catch(report); });
  $("pairManualButton").addEventListener("click", () => {
    manualEntry = true;
    syncButton();
    $("pairCodeInput").focus();
  });
  $("pairCodeInput").addEventListener("input", syncButton);
  $("pairCodeInput").addEventListener("keydown", event => {
    if (event.key !== "Enter" || !$("pairCodeInput").value.trim()) return;
    event.preventDefault();
    submit().catch(report);
  });
  $("pairRestoreButton").addEventListener("click", loadBackup);
  $("projectBackupButton").addEventListener("click", saveBackup);

  return {
    /** Called when the pairing tab is opened: the address may have changed since last time. */
    async show() {
      // A panel that has never been pointed at a server has only a placeholder address, and
      // reaching out to whatever that happens to be is not this program's business.
      if (!addressChosen()) { section.hidden = true; return; }
      await check();
      syncButton();
    },
    /** The console password may have arrived since; the button follows what it can do now. */
    sync: syncButton,
    /** Only the owner holds the signing key, so only the owner can be handed a copy of it. */
    syncOwner() {
      $("projectBackupButton").disabled = !isOwner();
    }
  };
}
