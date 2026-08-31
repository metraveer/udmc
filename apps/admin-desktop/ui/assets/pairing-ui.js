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
export function initPairing({ getConnection, onPaired, showToast, getBusy, setBusy }) {
  const form = $("pairForm");
  const inputs = () => form.querySelectorAll("input,button");
  let busy = false;

  const setLocalBusy = (value) => {
    busy = value;
    setBusy(value);
    inputs().forEach((input) => { input.disabled = value; });
  };
  const report = (error) => showToast(formatAppError(error), "error");
  const badge = (text, state) => {
    const element = $("pairAvailability");
    element.textContent = text;
    element.className = `state-badge ${state}`;
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
      if (state.unpaired) {
        badge(t("Ждёт привязки"), "warn");
        $("pairServerSummary").textContent = t("{0}, Minecraft {1}, {2}", state.packName || "UDMC", state.minecraftVersion || "?", state.loaderType || "?");
      } else {
        badge(t("Уже привязан"), "ok");
        $("pairServerSummary").textContent = t("Этот сервер уже привязан к панели. Чтобы привязать заново, включите resetPairing в config/udmc-sync.json и перезапустите сервер.");
      }
    } catch (error) {
      badge(t("Нет связи"), "error");
      $("pairServerSummary").textContent = formatAppError(error);
    }
  };

  const fetchByRcon = async () => {
    if (busy || getBusy()) return;
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) { report(new Error(t("RCON доступен только в установленном приложении UDMC Control."))); return; }
    const port = Number($("pairRconPort").value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { report(new Error(t("Укажите порт RCON от 1 до 65535."))); return; }
    setLocalBusy(true);
    try {
      const output = await invoke("rcon_execute", {
        host: $("pairRconHost").value.trim(),
        port,
        password: $("pairRconPassword").value,
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
      // The password was needed for this one command and has no reason to stay in memory.
      $("pairRconPassword").value = "";
      showToast(t("Код получен по RCON."), "success");
    } catch (error) {
      report(error);
    } finally {
      setLocalBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy || getBusy()) return;
    const code = $("pairCodeInput").value.trim();
    if (!code) { report(new Error(t("Введите код привязки."))); return; }
    setLocalBusy(true);
    try {
      const base = address();
      const project = await agentJson(`${base}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code })
      });
      $("pairCodeInput").value = "";
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

  form.addEventListener("submit", submit);
  $("pairFetchCodeButton").addEventListener("click", fetchByRcon);
  $("pairCheckButton").addEventListener("click", () => check().catch(report));

  return {
    /** Called when the pairing tab is opened: the address may have changed since last time. */
    async show() {
      try {
        const host = new URL(address()).hostname;
        if (!$("pairRconHost").value.trim()) $("pairRconHost").value = host;
      } catch { /* The address is validated where it is entered. */ }
      await check();
    }
  };
}
