import { t } from "./i18n.js";
import { normalizeAddress } from "./connection.js";

export function encodeInvitation(url, code) {
  const normalized = normalizeAddress(url);
  if (!/^[a-f0-9]{64}$/.test(code)) throw new Error(t("Некорректный код приглашения."));
  const bytes = new TextEncoder().encode(JSON.stringify({ url: normalized, code }));
  return `UDMC1.${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function decodeInvitation(text) {
  const value = String(text || "").trim();
  if (!/^UDMC1\.[A-Za-z0-9_-]+$/.test(value) || value.length > 4096) throw new Error(t("Вставьте целиком приглашение, начинающееся с UDMC1."));
  try {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value.slice(6).replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0))));
    if (typeof data.url !== "string" || !/^[a-f0-9]{64}$/.test(data.code)) throw new Error();
    return { url: normalizeAddress(data.url), code: data.code };
  } catch { throw new Error(t("Приглашение повреждено или содержит недопустимый адрес.")); }
}

export function deviceSecret() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function requireSecureAccess(connection) {
  const url = new URL(normalizeAddress(connection.url));
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !connection.allowHttp) {
    throw new Error(t("Ключ не отправлен по HTTP. Используйте HTTPS или разрешите HTTP только для доверенной сети."));
  }
  return url;
}

export async function accessRequest(connection, pathname, { method = "GET", body, token = connection.token } = {}) {
  const base = requireSecureAccess(connection);
  const response = await fetch(new URL(pathname.replace(/^\/+/, ""), base), {
    method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { ...(token ? { "x-udmc-token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(t("Агент вернул некорректный ответ (HTTP {0}).", response.status)); }
  if (!response.ok) { const error = new Error(data.error || t("Ошибка HTTP {0}", response.status)); error.status = response.status; throw error; }
  return data;
}
