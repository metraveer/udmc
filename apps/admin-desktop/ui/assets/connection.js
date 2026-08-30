import { t } from "./i18n.js";
export function normalizeAddress(input) {
  let value = String(input || "").trim();
  if (!value) throw new Error(t("Введите адрес сервера."));
  const explicit = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  if (!explicit) {
    const direct = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[\da-f:]+\])(:\d+)?(\/|$)/i.test(value) || /:\d+(\/|$)/.test(value);
    value = `${direct ? "http" : "https"}://${value}`;
  }
  let url;
  try { url = new URL(value); } catch { throw new Error(t("Не удалось прочитать адрес. Пример: sync.example.com или 192.168.1.10:3077.")); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(t("Нужен HTTP/HTTPS-адрес без пароля, параметров и #."));
  }
  if (!explicit && url.protocol === "http:" && !url.port) url.port = "3077";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function connectionDefaults(input) {
  const url = new URL(normalizeAddress(input));
  return {
    url: url.href,
    apiHost: url.protocol === "https:" ? "127.0.0.1" : "0.0.0.0",
    apiPort: url.protocol === "https:" ? 3077 : Number(url.port || 80),
    local: ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    encrypted: url.protocol === "https:"
  };
}
