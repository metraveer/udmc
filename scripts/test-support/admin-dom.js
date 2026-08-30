import { readFile } from "node:fs/promises";
import { SourceTextModule } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM, VirtualConsole } from "jsdom";
import { webcrypto } from "node:crypto";

const uiRoot = new URL("../../apps/admin-desktop/ui/", import.meta.url);
const html = await readFile(new URL("index.html", uiRoot), "utf8");
const templates = JSON.parse(await readFile(new URL("../../minecraft/agent-catalog.json", import.meta.url), "utf8"));
export const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export async function until(check, message = "UI did not settle") {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error(message);
    await delay(5);
  }
}

// Execute the actual ES modules in a separate DOM realm. No real network or Windows credentials.
export async function createAdmin(t, { native, fetch, storage = {}, session = {}, secrets = {}, connected = true, language = "ru-RU",
  platform = { version: "26.2", loader: { type: "fabric", version: "0.19.3" } } } = {}) {
  const dom = new JSDOM(html, { url: "https://udmc.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.defineProperty(w.navigator, "language", { value: language });
  const errors = [];
  dom.virtualConsole.on("jsdomError", e => errors.push(e));
  const $ = id => w.document.getElementById(id);
  Object.assign(w, { TextEncoder, TextDecoder, AbortSignal, AbortController, File, Blob, structuredClone });
  Object.defineProperty(w.crypto, "subtle", { value: webcrypto.subtle });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  // jsdom does not implement dialog modality; layout and Escape are checked in Windows separately.
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    w.queueMicrotask(() => this.dispatchEvent(new w.Event("close")));
  };
  w.lucide = { createIcons() {} };
  const intervals = [];
  const setInterval = w.setInterval.bind(w);
  w.setInterval = (callback, delay) => { intervals.push({ callback, delay }); return setInterval(callback, delay); };
  const vault = new Map(Object.entries(secrets));
  if (connected && !vault.has("admin-connection")) vault.set("admin-connection", JSON.stringify({ url: "https://agent.test/", token: "test-key" }));
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  for (const [key, value] of Object.entries(session)) w.sessionStorage.setItem(key, value);
  const invocations = [], requests = [];
  const manifest = { schemaVersion: 1, releaseSequence: 1, pack: { id: "udmc-main", name: "Test pack", version: "1.0.0" }, minecraft: platform, files: [] };
  const identity = { id: "test-owner", role: "owner", name: "Test PC" };
  w.__TAURI__ = { core: { invoke: async (name, args = {}) => {
    invocations.push({ name, args });
    const override = await native?.(name, args);
    if (override !== undefined) return override;
    if (name === "credential_read") return vault.get(args.name) || null;
    if (name === "credential_write") { args.value === null ? vault.delete(args.name) : vault.set(args.name, args.value); return null; }
    if (name === "generator_catalog") return { templates };
    if (name === "dependency_status") return { version: "test", templates: templates.length, webview: true, credentialStore: true };
    if (name === "device_name") return "Test PC";
    if (name === "modrinth_get" && args.path === "search") return { hits: [], total_hits: 0 };
    throw new Error(`Unexpected native command: ${name}`);
  } } };
  w.fetch = async (url, options = {}) => {
    const request = { url: new URL(url), options };
    requests.push(request);
    const override = await fetch?.(request);
    if (override !== undefined) return override;
    if (!connected) return response({ error: "No test server" }, 503);
    const path = request.url.pathname;
    if (path === "/health") return response({ ok: true, accessControl: true });
    if (path === "/admin/access/me") return response(identity);
    if (path === "/manifest") return response(manifest);
    if (path === "/admin/status") return response({ state: "online", minecraftVersion: manifest.minecraft.version, loader: manifest.minecraft.loader, players: { online: 0, max: 20, names: [] }, performance: { tps: 20 }, access: identity, capabilities: { commands: true, modValidation: true, powerActions: false } });
    if (path === "/admin/files" && (!options.method || options.method === "GET")) return response({ revision: "rev-1", draft: manifest, files: [], changes: { added: 0, updated: 0, removed: 0, total: 0, dirty: false } });
    if (path === "/admin/server/commands") return response({ commands: [{ name: "list", usage: ["list"] }], source: "server", minecraftVersion: "26.2" });
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  };
  const context = dom.getInternalVMContext();
  const modules = new Map();
  const load = url => {
    if (!url.href.startsWith(uiRoot.href)) throw new Error("Test module escaped the UI directory");
    if (!modules.has(url.href)) modules.set(url.href, readFile(url, "utf8").then(source => new SourceTextModule(source, { context, identifier: url.href })));
    return modules.get(url.href);
  };
  const entry = await load(new URL("assets/admin.js", uiRoot));
  await entry.link((specifier, parent) => load(new URL(specifier, parent.identifier)));
  await entry.evaluate();
  // Boot is done once the status resolved and dependency_status filled the version
  // line (its value is a test parameter, so only the placeholder is rejected here).
  await until(() => !["Подключение...", "Проверка компонентов", "Connecting...", "Checking components"].includes($("statusBadge").textContent)
    && $("appVersion").textContent.trim().length > "UDMC Control".length);
  return {
    w, $, vault, requests, invocations, manifest, errors,
    runInterval(delay) { for (const timer of intervals.filter(timer => timer.delay === delay)) timer.callback(); },
    input(id, value) { const el = $(id); el.value = value; el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); },
    click(id) { $(id).click(); },
    edit(group) { w.document.querySelector(`[data-edit-setting="${group}"]`).click(); },
    submit(id) { $(id).dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); },
    saved() { return Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => { const key = w.localStorage.key(i); return [key, w.localStorage.getItem(key)]; })); }
  };
}
