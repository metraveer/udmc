import { t } from "./i18n.js";

const $ = id => document.getElementById(id);
const DAY = 24 * 60 * 60 * 1000;
const SKIP_KEY = "udmc-skipped-app-version";

// Application updates arrive from the project's GitHub releases: the desktop shell
// verifies the signature before installing, so an unsigned or tampered package is refused.
export function initAppUpdates({ showToast, getBusy, storage = window.localStorage }) {
  const updater = window.__TAURI__?.updater;
  const relaunch = window.__TAURI__?.process?.relaunch;
  if (!updater?.check) return { check: () => {} };
  let found = null;
  let installing = false;

  const banner = $("appUpdateBanner");
  const setBusyState = state => {
    $("appUpdateInstall").disabled = state;
    $("appUpdateLater").disabled = state;
  };

  async function check({ silent = true } = {}) {
    if (installing || found) return;
    try {
      const update = await updater.check();
      if (!update?.available) {
        if (!silent) showToast(t("У вас последняя версия UDMC Control"));
        return;
      }
      if (silent && storage.getItem(SKIP_KEY) === update.version) return;
      found = update;
      $("appUpdateText").textContent = t("Доступна версия {0}. Обновление скачается и приложение перезапустится.", update.version);
      banner.hidden = false;
    } catch (error) {
      // A missing network or release is not worth interrupting server management.
      if (!silent) showToast(String(error?.message || error), "error");
    }
  }

  $("appUpdateInstall").addEventListener("click", async () => {
    if (!found || installing) return;
    if (getBusy?.()) { showToast(t("Дождитесь завершения операции с сервером и повторите."), "error"); return; }
    installing = true;
    setBusyState(true);
    $("appUpdateText").textContent = t("Загрузка обновления...");
    try {
      await found.downloadAndInstall(event => {
        if (event.event === "Progress" && event.data?.contentLength) {
          const percent = Math.round((event.data.chunkLength || 0) * 100 / event.data.contentLength);
          if (Number.isFinite(percent)) $("appUpdateText").textContent = t("Загрузка обновления: {0}%", percent);
        }
      });
      $("appUpdateText").textContent = t("Обновление установлено, перезапуск...");
      await relaunch?.();
    } catch (error) {
      installing = false;
      setBusyState(false);
      $("appUpdateText").textContent = t("Не удалось установить обновление: {0}", String(error?.message || error));
    }
  });
  $("appUpdateLater").addEventListener("click", () => {
    if (found?.version) { try { storage.setItem(SKIP_KEY, found.version); } catch { /* Skipping is a convenience. */ } }
    found = null;
    banner.hidden = true;
  });

  check();
  window.setInterval(() => check(), DAY);
  return { check };
}
