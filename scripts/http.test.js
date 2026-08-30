import test from "node:test";
import assert from "node:assert/strict";
import { agentJson, formatAgentError, REQUEST_TIMEOUT, MUTATION_TIMEOUT, UPLOAD_TIMEOUT } from "../apps/admin-desktop/ui/assets/http.js";
import { agentStatusMessage, diagnosticMessage } from "../apps/admin-desktop/ui/assets/agent-messages.js";

test("all agent requests disable redirects and have bounded timeouts", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push(options);
    return new Response('{"ok":true}');
  });
  assert.deepEqual(await agentJson("https://example.com/health"), { ok: true });
  await agentJson("https://example.com/admin/publish", { method: "POST", body: "{}", headers: { "x-udmc-token": "test" } });
  await agentJson("https://example.com/admin/files", { method: "POST", body: "file" }, UPLOAD_TIMEOUT);
  for (const request of requests) {
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert.ok(request.signal instanceof AbortSignal);
  }
  assert.equal(requests[1].headers["x-udmc-token"], "test");
  assert.ok(REQUEST_TIMEOUT < MUTATION_TIMEOUT && MUTATION_TIMEOUT < UPLOAD_TIMEOUT);
});

test("agent service statuses use stable codes and retain old or future fallbacks", () => {
  assert.equal(agentStatusMessage({ code: "AGENT_UPDATE_FAILED", args: [], message: "Update failed" }), "Обновление агента завершилось ошибкой.");
  assert.equal(agentStatusMessage({ code: "FUTURE_STATUS", args: [], message: "Future explanation" }), "Future explanation");
  assert.equal(agentStatusMessage("Legacy explanation"), "Legacy explanation");
  assert.equal(diagnosticMessage({ side: "server", code: "DRAFT_BLOB_MISSING", args: ["mods/test.jar"], message: "Missing blob" }),
    "Данные файла черновика отсутствуют. Загрузите файл повторно: mods/test.jar");
});

test("HTTP errors preserve their status for stale drafts and revoked access", async t => {
  for (const status of [401, 403, 409, 413, 500]) {
    t.mock.method(globalThis, "fetch", async () => new Response('{"error":"Rejected"}', { status }));
    await assert.rejects(() => agentJson("https://example.com/"), e => e.status === status && e.message === "Rejected");
  }
});

test("structured agent errors preserve codes and literal parameters", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: "Another administrator is editing: Alice <Admin>",
    code: "WORKSPACE_LOCKED",
    args: ["Alice <Admin>"],
    workspace: { revision: "next" }
  }), { status: 423 }));
  await assert.rejects(() => agentJson("https://example.com/admin/files"), error => {
    assert.equal(error.status, 423);
    assert.equal(error.code, "WORKSPACE_LOCKED");
    assert.deepEqual(error.args, ["Alice <Admin>"]);
    assert.deepEqual(error.workspace, { revision: "next" });
    assert.equal(formatAgentError(error), "Сейчас сервер редактирует другой администратор: Alice <Admin>");
    return true;
  });
});

test("error localization is code-first and future or legacy agents keep their fallback", () => {
  assert.equal(formatAgentError(Object.assign(new Error("misleading fallback"), { code: "REMOTE_POWER_DISABLED", args: [] })),
    "Удалённое управление питанием отключено в настройках.");
  assert.equal(formatAgentError(Object.assign(new Error("Future explanation"), { code: "FUTURE_AGENT_ERROR", args: ["literal"] })), "Future explanation");
  assert.equal(formatAgentError(Object.assign(new Error("Prototype explanation"), { code: "__proto__", args: [] })), "Prototype explanation");
  assert.equal(formatAgentError(new Error("Draft has no changes.")), "В черновике нет изменений для публикации.");
  assert.equal(formatAgentError({ code: "PUBLISH_BLOCKED_BY_VALIDATION", args: [8], fallback: "Publication was refused." }),
    "Публикация отклонена: проверка состава нашла проблемы (8). Откройте вкладку «Проверка» и исправьте состав.");
  assert.equal(formatAgentError({ code: "RCON_TIMEOUT", args: [], fallback: "RCON timeout", outcomeUnknown: true }),
    "Сервер RCON не ответил за отведённое время. Команда могла выполниться. Проверьте состояние сервера перед повтором.");
  assert.equal(formatAgentError({ code: "MODRINTH_HTTP_FAILED", args: [429], fallback: "Modrinth HTTP 429" }),
    "Modrinth вернул ошибку HTTP 429.");
  assert.equal(formatAgentError({ code: "AGENT_EXPORT_FAILED", args: ["Access denied\nretry"], fallback: "Export failed" }),
    "Не удалось создать серверный агент. Технические сведения: Access denied\nretry");
});

test("malformed or non-object JSON responses are reported instead of accepted", async t => {
  for (const body of ["not json", "null", "[]", "42"]) {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    await assert.rejects(() => agentJson("https://example.com/"));
  }
});

test("a failed mutation is never automatically retried", async t => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { attempts++; throw new TypeError("Network failure"); });
  await assert.rejects(() => agentJson("https://example.com/", { method: "DELETE" }), e => e.code === "NETWORK" && e.outcomeUnknown);
  assert.equal(attempts, 1);
});

test("proxy HTML errors retain HTTP status so revoked access is cleared", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Forbidden</html>", { status: 403 }));
  await assert.rejects(() => agentJson("https://example.com/", { method: "POST" }), e => e.status === 403 && e.outcomeUnknown);
});

test("timeouts include response-body reading and report unknown mutation outcomes", async t => {
  const keepAlive = setTimeout(() => {}, 3000);
  t.after(() => clearTimeout(keepAlive));
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => ({
    ok: true, status: 200,
    text: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  }));
  await assert.rejects(() => agentJson("https://example.com/", { method: "POST" }, 15), e => e.code === "TIMEOUT" && e.outcomeUnknown);
});
