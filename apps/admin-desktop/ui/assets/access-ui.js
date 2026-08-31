import { t, getLocale } from "./i18n.js";
import { formatAgentError } from "./http.js";
import { accessRequest, decodeInvitation, encodeInvitation, deviceSecret, requireSecureAccess } from "./access-protocol.js";
import { profileStorage as localStorage, profileCommand } from "./server-profiles.js";

const $ = id => document.getElementById(id);
const node = (tag, text, className = "") => { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; };
const date = value => value ? new Date(value).toLocaleString(getLocale()) : t("Ещё не подключался");
// Optional fields must never reach the interface as "undefined" or as a sentence
// glued from an unrelated fallback ("Заявка до Ещё не подключался").
const stamp = value => value ? new Date(value).toLocaleString(getLocale()) : "";
const details = parts => parts.filter(part => part !== undefined && part !== null && part !== "").join(" · ");
const codeText = value => String(value || "").match(/.{1,4}/g)?.join(" ") || "";
const labels = { pending: t("Ждёт подтверждения"), approved: t("Разрешён"), rejected: t("Отклонён"), revoked: t("Доступ отозван"), expired: t("Заявка истекла") };
const actions = { address: t("Новый адрес"), connected: t("Подключение"), "owner-recovered": t("Владелец восстановлен"), invited: t("Создано приглашение"), requested: t("Заявка"), cancelled: t("Заявка отменена"), approve: t("Доступ разрешён"), reject: t("Заявка отклонена"), revoke: t("Доступ отозван"), "invite-revoked": t("Приглашение отозвано"), operation: t("Операция"), denied: t("Доступ отклонён") };
const invoke = (command, args) => {
  if (!window.__TAURI__?.core?.invoke) throw new Error(t("Ключи устройств сохраняются только в Windows-приложении UDMC Control."));
  return window.__TAURI__.core.invoke(command, profileCommand(command, args));
};
const readSecret = async name => { const value = await invoke("credential_read", { name }); return value ? JSON.parse(value) : null; };
const writeSecret = (name, value) => invoke("credential_write", { name, value: value ? JSON.stringify(value) : null });

export function initAccess({ getConnection, setConnection, replaceToken, getBusy, setBusy, navigateTo, showToast, refresh, onRole }) {
  let me = null, binding = "", pending = null, decision = null, refreshing = false, checking = false;
  let supported = false;
  const key = c => JSON.stringify([c.url, c.token]);
  const same = c => { try { return key(c) === key(getConnection()); } catch { return false; } };
  const report = error => showToast(formatAgentError(error), "error");
  function update(identity) {
    me = identity; binding = identity ? key(getConnection()) : ""; onRole(me);
    // The name is what the owner sees in their device list; an agent that does not send one
    // must not put the word "undefined" on screen in its place.
    const role = identity && (identity.role === "owner" ? t("Владелец") : t("Администратор"));
    $("connectionIdentity").textContent = identity ? [role, identity.name].filter(Boolean).join(" · ") : t("Не проверен");
    $("connectionIdentity").className = `state-badge ${identity ? "online" : "neutral"}`;
    $("inviteDeviceButton").disabled = !identity || identity.role !== "owner" || getBusy();
    $("deviceRequestCount").hidden = !identity?.pending;
    $("deviceRequestCount").textContent = String(identity?.pending || 0);
  }
  function reset() {
    update(null); supported = false; binding = "";
    $("deviceList").replaceChildren(); $("activeInvitesSection").hidden = true; $("accessAuditSection").hidden = true;
    $("devicesStatus").textContent = t("Подключитесь к агенту.");
    $("inviteDialog").close(); $("deviceDecisionDialog").close(); decision = null;
    $("inviteCode").value = "";
  }
  async function ensureDevice(enabled) {
    supported = enabled;
    if (!enabled) {
      update(null); $("connectionIdentity").textContent = t("Старый агент: без устройств");
      return;
    }
    const c = getConnection();
    if (binding === key(c) && me) return;
    let identity = await accessRequest(c, "/admin/access/me");
    if (!same(c)) throw new Error(t("Адрес подключения изменился."));
    if (identity.bootstrap) {
      if (getBusy()) throw new Error(t("Дождитесь завершения операции и повторите подключение."));
      setBusy(true);
      try {
        let device = await readSecret("access-device");
        if (device?.url !== c.url || device?.role !== "owner") device = { url: c.url, token: deviceSecret(), role: "owner" };
        const enroll = async () => {
          await writeSecret("access-device", device);
          return accessRequest(c, "/admin/access/owner", { method: "POST", body: { token: device.token, name: $("deviceNameInput").value.trim() } });
        };
        try { identity = await enroll(); }
        catch (error) {
          if (error.status !== 409) throw error;
          device.token = deviceSecret(); identity = await enroll();
        }
        if (!same(c)) throw new Error(t("Адрес подключения изменился."));
        await replaceToken(device.token);
      } finally { setBusy(false); }
    }
    update(identity);
  }
  function receive(identity) { if (supported && identity) update(identity); }
  function button(iconName, title, handler, danger = false) {
    const b = node("button", "", `icon-button${danger ? " access-danger" : ""}`); b.type = "button"; b.title = title; b.setAttribute("aria-label", title);
    const i = document.createElement("i"); i.dataset.lucide = iconName; b.append(i); b.addEventListener("click", handler); return b;
  }
  async function refreshDevices() {
    if (refreshing || getBusy()) return;
    if (!me || binding !== key(getConnection())) { $("devicesStatus").textContent = supported ? t("Подключитесь к агенту.") : t("Для списка устройств подключите обновлённый серверный агент."); return; }
    if (me.role !== "owner") { $("devicesStatus").textContent = t("Ваш доступ подтверждён. Список устройств и приглашения доступны владельцу проекта."); return; }
    refreshing = true; const c = getConnection();
    try {
      const result = await accessRequest(c, "/admin/access");
      if (!same(c)) return;
      update(result.me);
      const devices = [...result.devices].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt - a.createdAt);
      $("devicesStatus").textContent = t("Устройств: {0}. Ожидают решения: {1}.", devices.length, result.me.pending || 0);
      $("deviceList").replaceChildren(...devices.map(d => {
        const row = node("article", "", "device-row");
        const icon = document.createElement("i"); icon.dataset.lucide = d.role === "owner" ? "shield-check" : "monitor";
        const copy = node("div", "", "device-copy");
        copy.append(node("strong", `${d.name}${d.id === me.id ? t(" · этот компьютер") : ""}`),
          node("small", details([d.role === "owner" ? t("Владелец") : t("Администратор"), d.lastIp || d.requestIp, stamp(d.lastSeen || d.createdAt)])));
        if (d.status === "pending") {
          copy.append(node("code", codeText(d.verification), "verification-code"));
          if (d.expiresAt) copy.append(node("small", t("Заявка до {0}", stamp(d.expiresAt))));
        }
        // An unknown status from a newer agent shows its raw value instead of an empty pill.
        const state = node("span", d.active ? t("Активен") : labels[d.status] || String(d.status || t("Неизвестно")),
          `state-badge ${d.active ? "online" : d.status === "pending" ? "warning" : "neutral"}`);
        const controls = node("div", "", "device-controls");
        if (d.status === "pending") controls.append(button("check", t("Разрешить {0}", d.name), () => openDecision(d, "approve")), button("x", t("Отклонить {0}", d.name), () => openDecision(d, "reject"), true));
        if (d.status === "approved" && d.id !== me.id) controls.append(button("shield-off", t("Отозвать доступ {0}", d.name), () => openDecision(d, "revoke"), true));
        row.append(icon, copy, state, controls); return row;
      }));
      // An agent may omit optional collections: a missing field must not blank the page.
      const invitations = Array.isArray(result.invitations) ? result.invitations : [];
      const events = Array.isArray(result.events) ? result.events : [];
      $("activeInvitesSection").hidden = !invitations.length;
      $("activeInvites").replaceChildren(...invitations.map(invitation => {
        const row = node("div", "", "invitation-row");
        row.append(node("span", details([t("Приглашение {0}", String(invitation.id || "").slice(0, 8)), stamp(invitation.expiresAt) && t("до {0}", stamp(invitation.expiresAt))])), button("x", t("Отозвать приглашение"), async () => {
          if (getBusy() || !same(c)) return; setBusy(true);
          try { await accessRequest(c, "/admin/access/invitations/revoke", { method: "POST", body: { id: invitation.id } }); }
          catch (error) { report(error); } finally { setBusy(false); await refreshDevices(); }
        })); return row;
      }));
      $("accessAuditSection").hidden = !events.length;
      $("accessAudit").replaceChildren(...[...events].reverse().map(event => {
        const row = node("div", "", "audit-row");
        row.append(node("time", stamp(event.at)), node("div", details([actions[event.action] || event.action, event.name]), "audit-name"),
          node("small", details([event.ip, event.detail, ["operation", "denied"].includes(event.action) && event.status ? `HTTP ${event.status}` : ""]))); return row;
      }));
    } catch (error) { if (same(c)) $("devicesStatus").textContent = formatAgentError(error); }
    // Icons are created even after a partial failure: raw <i data-lucide> squares
    // used to stay on screen whenever anything above threw.
    finally { refreshing = false; window.lucide?.createIcons(); }
  }
  function openDecision(device, action) {
    if (getBusy()) return;
    decision = { device, action, connection: getConnection() };
    $("deviceDecisionTitle").textContent = action === "approve" ? t("Разрешить администратору доступ?") : action === "reject" ? t("Отклонить заявку?") : t("Отозвать доступ устройства?");
    $("deviceDecisionText").textContent = `${device.name} · ${device.lastIp || device.requestIp}. ${action === "approve" ? t("Сверьте код с человеком, которому вы отправили приглашение. Он сможет менять сборку и выполнять команды сервера.") : t("Это действие относится только к выбранному устройству. Пароль RCON не изменится.")}`;
    $("deviceDecisionCode").hidden = action !== "approve";
    $("deviceDecisionCode").textContent = codeText(device.verification);
    $("deviceApprovalCheck").hidden = action !== "approve";
    $("deviceApprovalConfirmed").checked = false;
    $("deviceDecisionConfirm").disabled = action === "approve";
    $("deviceDecisionConfirm").textContent = action === "approve" ? t("Разрешить") : action === "reject" ? t("Отклонить") : t("Отозвать доступ");
    $("deviceDecisionDialog").showModal();
  }
  $("deviceApprovalConfirmed").addEventListener("change", () => { $("deviceDecisionConfirm").disabled = !$("deviceApprovalConfirmed").checked; });
  $("deviceDecisionForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (getBusy() || !decision || !same(decision.connection)) return;
    if (decision.action === "approve" && !$("deviceApprovalConfirmed").checked) return;
    const selected = decision; setBusy(true); $("deviceDecisionConfirm").disabled = true;
    try {
      await accessRequest(selected.connection, "/admin/access/decision", { method: "POST", body: { id: selected.device.id, action: selected.action } });
      $("deviceDecisionDialog").close(); decision = null; showToast(t("Доступ устройства обновлён"));
    } catch (error) { report(error); }
    finally { setBusy(false); $("deviceDecisionConfirm").disabled = false; await refreshDevices(); }
  });
  $("inviteDeviceButton").addEventListener("click", async () => {
    if (getBusy() || me?.role !== "owner") return;
    setBusy(true); const c = getConnection();
    try {
      const invitation = await accessRequest(c, "/admin/access/invitations", { method: "POST", body: {} });
      if (!same(c)) return;
      $("inviteCode").value = encodeInvitation(c.url, invitation.code);
      $("inviteExpiry").textContent = t("Одно использование · до {0} · {1}", date(invitation.expiresAt), new URL(c.url).host);
      if (["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.url).hostname)) $("inviteExpiry").textContent += t(". Этот адрес работает только на этом ПК. Для друга подключитесь по доступному ему адресу и создайте новое приглашение.");
      $("inviteDialog").showModal();
    } catch (error) { report(error); } finally { setBusy(false); await refreshDevices(); }
  });
  $("copyInviteButton").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("inviteCode").value); showToast(t("Приглашение скопировано")); } catch (error) { report(error); }
  });
  $("inviteDialog").addEventListener("close", () => { $("inviteCode").value = ""; });

  function renderPending(status) {
    $("pendingRequest").hidden = !pending;
    if (!pending) return;
    $("pendingName").textContent = pending.name;
    $("pendingVerification").textContent = codeText(status?.verification);
    $("pendingDetails").textContent = status ? `${labels[status.status] || status.status}. ${status.status === "pending" ? t("Сообщите владельцу код проверки. Заявка до {0}.", date(status.expiresAt)) : ""}` : t("Проверяем, получил ли сервер заявку.");
    $("cancelAccessButton").textContent = !status || status.status === "pending" ? t("Отменить заявку") : t("Убрать заявку");
  }
  async function checkPending() {
    if (!pending || checking || getBusy()) return;
    const request = pending; checking = true;
    try {
      const status = await accessRequest(request, "/access/status");
      if (pending !== request) return;
      renderPending(status); request.status = status.status;
      if (status.status === "approved") {
        if (getBusy()) return;
        setBusy(true);
        try {
          await setConnection(request.url, request.token, request.allowHttp);
          await writeSecret("pending-access", null); pending = null; renderPending();
          $("invitationInput").value = "";
          $("joinStatus").textContent = t("Владелец подтвердил доступ.");
        } finally { setBusy(false); }
        await refresh(); navigateTo("dashboard"); showToast(t("Владелец подтвердил этот компьютер"));
      }
    } catch (error) { $("joinStatus").textContent = formatAgentError(error); }
    finally { checking = false; }
  }
  $("invitationInput").addEventListener("input", () => {
    try {
      const invitation = decodeInvitation($("invitationInput").value);
      if (getConnection().url !== invitation.url) { $("serverUrlInput").value = invitation.url; $("serverUrlInput").dispatchEvent(new Event("input")); }
    } catch { /* Partial invitation while typing. */ }
  });
  $("joinForm").addEventListener("submit", async event => {
    event.preventDefault(); if (getBusy()) return;
    setBusy(true);
    try {
      const invitation = decodeInvitation($("invitationInput").value);
      const c = getConnection();
      if (c.url !== invitation.url) throw new Error(t("Адрес выше отличается от адреса приглашения. Вставьте приглашение заново."));
      requireSecureAccess(c);
      if (pending && (pending.url !== invitation.url || pending.invite !== invitation.code)) throw new Error(t("Сначала отмените предыдущую заявку."));
      const request = pending || { url: invitation.url, token: deviceSecret(), name: $("deviceNameInput").value.trim(), invite: invitation.code, allowHttp: c.allowHttp };
      request.allowHttp = c.allowHttp;
      await writeSecret("pending-access", request);
      pending = request; renderPending();
      const status = await accessRequest(request, "/access/request", { method: "POST", token: null, body: { invite: request.invite, token: request.token, name: request.name } });
      renderPending(status); request.status = status.status;
      $("joinStatus").textContent = t("Заявка отправлена. Дождитесь решения владельца.");
    } catch (error) { $("joinStatus").textContent = formatAgentError(error); }
    finally { setBusy(false); }
  });
  $("checkAccessButton").addEventListener("click", checkPending);
  $("cancelAccessButton").addEventListener("click", async () => {
    if (!pending || getBusy() || checking) return;
    setBusy(true);
    try {
      if (!pending.status || pending.status === "pending") {
        try { await accessRequest(pending, "/access/cancel", { method: "POST" }); }
        catch (error) { if (error.status !== 401) throw error; }
      }
      await writeSecret("pending-access", null); pending = null; renderPending(); $("joinStatus").textContent = t("Заявка убрана.");
    } catch (error) { report(error); } finally { setBusy(false); }
  });
  const ready = (async () => {
    if (!window.__TAURI__?.core?.invoke) return;
    try {
      // Taken from Windows, not asked for: this only labels a row in the owner's device
      // list, and a field for it sat in the way of everything that actually needs deciding.
      $("deviceNameInput").value = await invoke("device_name", { fallback: t("Мой компьютер") });
      pending = await readSecret("pending-access"); renderPending();
      if (pending) { navigateTo("generator"); $("joinDialog").showModal(); }
    } catch (error) { report(error); }
  })();
  return { ready, ensureDevice, receive, reset, onOpen: refreshDevices, poll: async () => {
    await checkPending();
    if ($("devicesView").classList.contains("active")) await refreshDevices();
  } };
}
