import i18next from "../vendor/i18next.js";
import { resources } from "../locales/resources.js";

export const LANGUAGE_KEY = "udmc-language";
export function chooseLanguage(preference, systemLanguage) {
  if (["ru", "en"].includes(preference)) return preference;
  return /^ru(?:-|$)/i.test(systemLanguage || "") ? "ru" : "en";
}
function initialLanguage() {
  if (typeof window === "undefined") return "ru";
  let preference;
  try { preference = window.localStorage.getItem(LANGUAGE_KEY); } catch { /* Read-only storage: use the system language. */ }
  return chooseLanguage(preference, window.navigator.language);
}
const language = initialLanguage();
const engine = i18next.createInstance();
engine.init({
  lng: language, supportedLngs: ["ru", "en"], fallbackLng: "en", resources,
  initAsync: false, showSupportNotice: false, keySeparator: false, nsSeparator: false,
  // Strings go to textContent/attributes; the two static HTML messages have no parameters.
  interpolation: { prefix: "{", suffix: "}", escapeValue: false, skipOnVariables: true },
  returnNull: false
});
export const getLanguage = () => language;
export const getLocale = () => language === "ru" ? "ru-RU" : "en-US";
export function t(source, ...values) {
  return engine.t(source, { ...Object.fromEntries(values.map((value, index) => [String(index), String(value)])), defaultValue: source, nest: false });
}
export const countText = (key, count) => engine.t(key, { count });
export function translateDocument(root = document) {
  root.documentElement.lang = language;
  for (const element of root.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const attribute of ["title", "aria-label", "placeholder"]) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
  }
}
export function initLanguage({ getBusy, hasLocalFiles, showToast, beforeReload = () => {}, reload = () => window.location.reload() }) {
  const select = document.getElementById("languageSelect"), dialog = document.getElementById("languageDialog");
  select.value = language;
  let pending = null;
  function apply() {
    if (getBusy() || !pending) return;
    try {
      beforeReload();
      window.localStorage.setItem(LANGUAGE_KEY, pending);
      reload();
    } catch { showToast(t("Не удалось сохранить язык. Проверьте доступ к локальному хранилищу."), "error"); select.value = language; }
  }
  select.addEventListener("change", () => {
    pending = ["ru", "en"].includes(select.value) ? select.value : null;
    if (getBusy()) { select.value = language; showToast(t("Дождитесь завершения текущей операции."), "error"); return; }
    if (!pending || pending === language) return;
    if (hasLocalFiles()) dialog.showModal(); else apply();
  });
  document.getElementById("languageForm").addEventListener("submit", event => { event.preventDefault(); apply(); });
  dialog.addEventListener("close", () => { pending = null; select.value = language; });
}
