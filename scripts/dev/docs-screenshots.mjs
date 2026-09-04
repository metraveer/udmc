// The panel screenshots for README and docs, taken the same way every time: the debug build
// on a test profile, paired with the stand-in agent, 1264x821, seven screens. Usage:
//
//   node scripts/dev/mock-agent.mjs 46000 3
//   UDMC_TEST_PROFILE=shots WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 apps/admin-desktop/src-tauri/target/debug/udmc-control.exe
//   node scripts/dev/docs-screenshots.mjs docs/images [9333]
//
// UI_LANG=en takes the same screens in English, for a look after a locale change.
import { writeFileSync } from "node:fs";
import path from "node:path";
const OUT = process.argv[2] || ".qa/docs-shots";
const PORT = process.argv[3] || "9333";
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find(t => t.type === "page" && t.url.startsWith("http://tauri.localhost"));
if (!page) throw new Error("no tauri page: " + JSON.stringify(targets.map(t => t.url)));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
let nextId = 1; const pending = new Map(); const consoleErrors = [];
ws.onmessage = e => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); return; }
  if (m.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(m.params.type)) consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? "").join(" ")); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const evaljs = async expr => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval"); return r.result.value; };
const snap = async name => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); console.log("снимок:", name); };
const click = async selector => evaljs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "missing " + ${JSON.stringify(selector)}; el.click(); return "ok"; })()`);
const clickText = async (pattern, scope = "document") => evaljs(`(() => { const root = ${scope}; const el = [...root.querySelectorAll("button, a, [role=tab]")].find(el => ${pattern}.test((el.textContent || "").trim())); if (!el) return "missing"; el.click(); return el.textContent.trim(); })()`);
await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1264, height: 821, deviceScaleFactor: 1, mobile: false });

const waitConnected = async () => {
  for (let i = 0; i < 120; i++) {
    const s = await evaljs(`document.getElementById("statusBadge")?.textContent?.trim() || ""`).catch(() => "");
    if (s && !["Подключение...", "Connecting..."].includes(s)) return s;
    await sleep(250);
  }
  return "?";
};

const LANG = process.env.UI_LANG || "ru";
if (await evaljs(`document.documentElement.lang`) !== LANG) {
  await evaljs(`(() => { localStorage.setItem("udmc-language", ${JSON.stringify(LANG)}); return true; })()`);
  await send("Page.reload"); await sleep(1500);
}
const seeded = await evaljs(`localStorage.getItem("udmc-control-server-url")`);
if (seeded !== "http://127.0.0.1:46000") {
  await evaljs(`(() => { localStorage.setItem("udmc-control-server-url", "http://127.0.0.1:46000"); localStorage.setItem("udmc-allow-http-url", "http://127.0.0.1:46000"); return true; })()`);
  await send("Page.reload"); await sleep(1500);
}
// A fresh start against the agent as it is now, not what the page cached before.
await send("Page.reload"); await sleep(1500);
let status = await waitConnected();
console.log("статус:", status);
if (/Not connected|Не подключено/.test(status)) {
  await evaljs(`(() => { document.getElementById("serverProfileDialog").showModal(); return true; })()`);
  await sleep(300);
  await evaljs(`(() => { const input = document.getElementById("serverUrlInput"); input.value = "http://127.0.0.1:46000"; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  for (let i = 0; i < 40; i++) { if (!(await evaljs(`document.getElementById("pairEntry")?.hidden ?? true`))) break; await sleep(250); }
  await evaljs(`(() => { const code = document.getElementById("pairCodeInput"); code.value = "ABCD-EFGH-JKMN-PQRS"; code.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("pairButton").click(); return true; })()`);
  await sleep(1500);
  await evaljs(`(() => { document.getElementById("serverProfileDialog").close?.(); return true; })()`).catch(() => {});
  status = await waitConnected();
  console.log("после привязки:", status);
}
// Toasts from the pairing would sit in the corner of the first screenshot.
await evaljs(`(() => { document.getElementById("toastRegion")?.replaceChildren(); return true; })()`).catch(() => {});
await sleep(2500);

console.log("нав:", await click('[data-view="dashboard"]')); await sleep(1200);
await evaljs(`window.scrollTo(0, 0)`);
await snap("01-server.png");

console.log("нав:", await click('[data-view="overview"]')); await sleep(800);
console.log("вкладка:", await click('[data-build-tab="draft"]')); await sleep(800);
await snap("02-pack.png");

console.log("нав:", await click('[data-view="modrinth"]')); await sleep(800);
console.log("поиск:", await clickText("/^(Найти|Search)$/"));
for (let i = 0; i < 60; i++) { const n = await evaljs(`document.querySelectorAll("#modrinthResults .catalog-item, #modrinthResults article, #modrinthResults li").length`).catch(() => 0); if (n >= 5) break; await sleep(250); }
await sleep(1500);
await snap("03-catalog.png");

console.log("нав:", await click('[data-view="console"]')); await sleep(1500);
console.log("очистка:", await click("#clearConsoleButton")); await sleep(500);
for (const command of ["list", "time query daytime", "save-all"]) {
  console.log("команда:", await evaljs(`(() => { const input = document.getElementById("commandInput"); input.value = ${JSON.stringify(command)}; input.dispatchEvent(new Event("input", { bubbles: true })); const form = input.form || input.closest("form"); if (form) { form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); return "submitted"; } return "no form"; })()`));
  await sleep(900);
}
await sleep(800);
await evaljs(`(() => { document.getElementById("toastRegion")?.replaceChildren(); return true; })()`).catch(() => {});
await sleep(300);
await snap("04-console.png");

console.log("нав:", await click('[data-view="devices"]')); await sleep(1500);
await snap("05-devices.png");

console.log("нав:", await click('[data-view="settings"]')); await sleep(1200);
await evaljs(`window.scrollTo(0, 0)`);
await snap("06-settings.png");

console.log("нав:", await click('[data-view="dashboard"]')); await sleep(800);
await evaljs(`(() => { document.getElementById("serverProfileDialog").showModal(); return true; })()`);
await sleep(500);
console.log("вкладка диалога:", await click("#agentDeliveryTab")); await sleep(1500);
// The close button keeps focus after showModal(), and its tooltip would sit in the picture.
await evaljs(`(() => { document.activeElement?.blur?.(); return true; })()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 700 });
await sleep(600);
await snap("07-agents.png");
await evaljs(`(() => { document.getElementById("serverProfileDialog").close?.(); return true; })()`).catch(() => {});

console.log("версия в подвале:", await evaljs(`(document.querySelector(".app-version, #appVersion, footer")?.textContent || "").trim().slice(0, 40)`));
console.log("ошибки консоли:", consoleErrors.length ? consoleErrors.slice(0, 4) : "нет");
await send("Emulation.clearDeviceMetricsOverride");
ws.close();
