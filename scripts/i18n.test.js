import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { parse } from "acorn";
import { JSDOM } from "jsdom";
import i18next from "i18next";
import { chooseLanguage } from "../apps/admin-desktop/ui/assets/i18n.js";
import { resources } from "../apps/admin-desktop/ui/locales/resources.js";
import { createAdmin, until, response } from "./test-support/admin-dom.js";
import { diagnosticMessage } from "../apps/admin-desktop/ui/assets/agent-messages.js";

const root = new URL("../apps/admin-desktop/ui/", import.meta.url);
test("game navigation retains Minecraft multiplayer permission and warning checks", async () => {
  const source = await readFile(new URL("../minecraft/udmc-sync-common/src/main/java/dev/udmc/sync/UdmcClientUi.java", import.meta.url), "utf8");
  assert.match(source, /if \(!Minecraft\.getInstance\(\)\.allowsMultiplayer\(\)\) return;/);
  assert.match(source, /options\.skipMultiplayerWarning\s*\? new JoinMultiplayerScreen\(parent\) : new SafetyScreen\(parent\)/);
  assert.match(source, /if \(Minecraft\.getInstance\(\)\.allowsMultiplayer\(\)\) return;\s*button\.active = false;/);
  assert.match(source, /displayed\.success && !Minecraft\.getInstance\(\)\.allowsMultiplayer\(\)\) restrictToMultiplayer\(primary\);/);
  assert.match(source, /restrictToMultiplayer\(connect\);/);
  assert.match(source, /if \(!minecraft\.options\.skipMultiplayerWarning\) \{\s*ClientPlatform\.open\(new SafetyScreen\(parent\)\);\s*return;\s*\}/);
  assert.match(source, /Tooltip\.create\(Component\.translatable\("title\.multiplayer\.disabled"\)\)/);
  assert.doesNotMatch(source, /skipMultiplayerWarning\s*=(?!=)/);
});

test("agent diagnostics accept only known codes and preserve literal parameters", () => {
  const args = ["mods/{0}%s<img>.jar", "MOD", "LIB", ">=2"];
  assert.equal(diagnosticMessage({ code: "udmc_sync.diagnostic.required", args }), "mods/{0}%s<img>.jar (MOD): нужна зависимость LIB >=2.");
  for (const issue of [{ code: "__proto__", args }, { code: "constructor", args }, { code: "udmc_sync.diagnostic.required", args: [] },
    { code: "udmc_sync.diagnostic.required", args: [null, "mod", "lib", "2"] }, { code: "future-code", args }]) {
    assert.equal(diagnosticMessage({ ...issue, message: "Original server explanation" }), "Original server explanation");
  }
});

test("both agent languages cover every Java message key and compile matching diagnostic parameters", async () => {
  const gameRoot = new URL("../minecraft/udmc-sync-common/src/main/", import.meta.url);
  const en = JSON.parse(await readFile(new URL("resources/assets/udmc_sync/lang/en_us.json", gameRoot), "utf8"));
  const ru = JSON.parse(await readFile(new URL("resources/assets/udmc_sync/lang/ru_ru.json", gameRoot), "utf8"));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  const java = new URL("java/dev/udmc/sync/", gameRoot);
  for (const file of await readdir(java)) if (file.endsWith(".java")) {
    const source = await readFile(new URL(file, java), "utf8");
    for (const match of source.matchAll(/"(udmc_sync\.(?:title|message|button|progress|error|conflict|diagnostic|login)\.[a-z_]+)"/g)) assert.ok(en[match[1]], `Missing game key: ${match[1]}`);
    if (["UdmcClientUi.java", "ClientModCheck.java", "ModSynchronizer.java", "ModMetadata.java"].includes(file)) assert.doesNotMatch(source, /[А-Яа-яЁё]/, file);
  }
  for (const file of ["PlayerListMixin.java", "ServerConfigVerifyMixin.java"]) {
    const source = await readFile(new URL(`java/dev/udmc/sync/mixin/${file}`, gameRoot), "utf8");
    assert.doesNotMatch(source, /Component\.literal\(|Download and installation instructions|client agent is/, file);
  }
  for (const key of Object.keys(en).filter(key => key.startsWith("udmc_sync.diagnostic."))) {
    assert.equal(resources.en.translation[key], en[key].replace(/%(\d+)\$s/g, (_, index) => `{${index - 1}}`));
    assert.equal(resources.ru.translation[key], ru[key].replace(/%(\d+)\$s/g, (_, index) => `{${index - 1}}`));
  }
});

test("English validation runs by itself, translates diagnostics and re-checks a changed draft", async t => {
  let revision = "rev-1";
  const app = await createAdmin(t, { language: "en", fetch: ({ url }) => {
    if (url.pathname === "/admin/validation") return revision === "rev-1"
      ? response({ revision, ok: false, checkedAt: "2026-08-28T12:00:00Z",
        issues: [{ side: "client", code: "udmc_sync.diagnostic.required", args: ["mods/<img>.jar", "MOD", "library", ">=2"], message: "legacy text" }] })
      : response({ revision, ok: true, checkedAt: "2026-08-28T12:05:00Z", issues: [] });
    if (url.pathname === "/admin/files" && revision !== "rev-1") return response({ revision, draft: app.manifest, files: [], changes: { dirty: false, total: 0 } });
  } });
  // No button press: the boot connection already validated the draft.
  await until(() => app.$("validationResult").querySelector(".validation-issue"));
  assert.match(app.$("validationResult").textContent, /mods\/<img>\.jar \(MOD\) requires library >=2/);
  assert.equal(app.$("validationResult").querySelector("img"), null);
  assert.match(app.$("validationResult").textContent, /Checked:/);
  revision = "rev-2"; app.click("refreshButton");
  // The changed revision re-checks automatically instead of showing a stale banner.
  await until(() => /No metadata issues found/.test(app.$("validationResult").textContent));
  assert.equal(app.$("validationResult").querySelector(".validation-issue"), null);
});

test("English API errors use stable codes and keep server-provided paths literal", async t => {
  const app = await createAdmin(t, { language: "en", fetch: ({ url }) => {
    if (url.pathname === "/admin/server/files") return response({
      error: "legacy fallback must not win",
      code: "SERVER_FILE_CHANGED_OR_MISSING",
      args: ["mods/<Admin>.jar"]
    }, 409);
  } });
  app.click("scanServerFilesButton");
  await until(() => app.$("toastRegion").textContent.includes("mods/<Admin>.jar"));
  assert.match(app.$("toastRegion").textContent, /The server file changed or disappeared/);
  assert.equal(app.$("toastRegion").querySelector("img"), null);
  assert.equal(app.errors.length, 0);
});
test("language follows the OS once and an explicit global choice wins", () => {
  for (const [preference, system, result] of [[null, "ru-RU", "ru"], [null, "en-GB", "en"], [null, "de-DE", "en"], ["en", "ru", "en"], ["ru", "en-US", "ru"], ["invalid", "ru-BY", "ru"]]) {
    assert.equal(chooseLanguage(preference, system), result);
  }
});

test("i18next handles English and Russian plural rules including 11, 21 and fractions", async () => {
  const engine = i18next.createInstance();
  await engine.init({ resources, lng: "en", showSupportNotice: false, interpolation: { prefix: "{", suffix: "}" } });
  assert.equal(engine.t("files", { count: 1 }), "1 file");
  assert.equal(engine.t("files", { count: 21 }), "21 files");
  await engine.changeLanguage("ru");
  for (const [count, expected] of [[1, "1 файл"], [2, "2 файла"], [5, "5 файлов"], [11, "11 файлов"], [21, "21 файл"], [22, "22 файла"], [1.5, "1.5 файла"]]) assert.equal(engine.t("files", { count }), expected);
});

test("all explicit UI messages and placeholders have both language resources", async () => {
  const used = new Set();
  let currentFile;
  const visit = (node, parent) => {
    if (node.type === "CallExpression" && node.callee.name === "t") {
      if (currentFile === "i18n.js" && node.arguments[0]?.type !== "Literal") {
        // The DOM adapter reads only explicitly annotated message keys.
      } else {
        assert.equal(node.arguments[0]?.type, "Literal", "translation keys must be explicit");
        used.add(node.arguments[0].value);
      }
    }
    if (node.type === "Literal" && typeof node.value === "string" && /[А-Яа-яЁё]/.test(node.value)) {
      assert.equal(parent?.callee?.name, "t", `Untranslated JavaScript: ${node.value}`);
    }
    for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) if (child?.type) visit(child, node);
  };
  for (const file of await readdir(new URL("assets/", root))) {
    if (!file.endsWith(".js")) continue;
    currentFile = file;
    visit(parse(await readFile(new URL(`assets/${file}`, root), "utf8"), { ecmaVersion: "latest", sourceType: "module" }));
  }
  const dom = new JSDOM(await readFile(new URL("index.html", root), "utf8"));
  for (const element of dom.window.document.querySelectorAll("*")) {
    for (const attribute of element.attributes) if (attribute.name.startsWith("data-i18n")) used.add(attribute.value);
    for (const node of element.childNodes) if (node.nodeType === 3 && /[А-Яа-яЁё]/.test(node.textContent) && element.closest("#languageSelect") === null) {
      assert.ok(element.hasAttribute("data-i18n"), `Untranslated HTML: ${node.textContent.trim()}`);
    }
  }
  dom.window.close();
  const placeholders = text => [...text.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
  for (const key of used) {
    assert.equal(typeof resources.ru.translation[key], "string", `Missing RU: ${key}`);
    assert.equal(typeof resources.en.translation[key], "string", `Missing EN: ${key}`);
    assert.doesNotMatch(resources.en.translation[key], /[А-Яа-яЁё]/);
    assert.deepEqual(placeholders(resources.en.translation[key]), placeholders(resources.ru.translation[key]), key);
  }
  assert.ok(used.size > 770);
});

test("English admin boot translates static, dynamic and command-reference text", async t => {
  const app = await createAdmin(t, { language: "en-US" });
  assert.equal(app.w.document.documentElement.lang, "en");
  assert.equal(app.$("viewTitle").textContent, "Server");
  assert.equal(app.$("statusBadge").textContent, "Server available");
  assert.equal(app.$("languageSelect").value, "en");
  assert.equal(app.$("draftStatusTitle").textContent, "Draft matches the published pack");
  app.w.document.querySelector('[data-view="console"]').click();
  await until(() => app.$("commandCatalog").textContent.includes("List players currently online."));
  app.edit("rcon");
  assert.equal(app.$("protectedSettingsDialog").querySelector("h2").textContent, "Change RCON connection");
  for (const el of app.w.document.querySelectorAll("[data-i18n]")) assert.doesNotMatch(el.textContent, /[А-Яа-яЁё]/, el.outerHTML);
  assert.equal(app.errors.length, 0);
});

test("manual language survives another server profile and preserves user names", async t => {
  const id = "11111111-1111-4111-8111-111111111111";
  const app = await createAdmin(t, { language: "en-US", connected: false, storage: {
    "udmc-language": "ru",
    "udmc-server-profiles-v1": JSON.stringify({ active: id, profiles: [{ id, name: "Мой мир" }] })
  } });
  assert.equal(app.w.document.documentElement.lang, "ru");
  assert.equal(app.$("languageSelect").value, "ru");
  assert.equal(app.$("serverProfileName").value, "Мой мир");
  assert.equal(app.saved()["udmc-language"], "ru");
  assert.equal(app.errors.length, 0);
});

test("language cannot change while protected settings are being edited", async t => {
  const app = await createAdmin(t, { language: "en" });
  app.edit("rcon");
  app.input("languageSelect", "ru");
  assert.equal(app.$("languageSelect").value, "en");
  assert.equal(app.saved()["udmc-language"], undefined);
  assert.match(app.$("toastRegion").textContent, /Wait for the current operation/);
});

test("changing language preserves the open view and is applied on WebView reload", async t => {
  const app = await createAdmin(t, { language: "ru" });
  app.w.document.querySelector('[data-view="overview"]').click();
  app.w.document.querySelector('[data-build-tab="published"]').click();
  app.input("languageSelect", "en");
  assert.equal(app.saved()["udmc-language"], "en");
  const session = Object.fromEntries(Array.from({ length: app.w.sessionStorage.length }, (_, i) => {
    const key = app.w.sessionStorage.key(i); return [key, app.w.sessionStorage.getItem(key)];
  }));
  const reopened = await createAdmin(t, { storage: app.saved(), session, language: "ru" });
  assert.equal(reopened.$("viewTitle").textContent, "Pack");
  assert.equal(reopened.w.document.querySelector('[data-build-tab="published"]').getAttribute("aria-selected"), "true");
  assert.equal(reopened.errors.length, 0);
  assert.ok(app.errors.every(error => error.message.includes("Not implemented: navigation")), "Only jsdom's expected reload limitation is allowed");
});

test("switching language asks before discarding local files and cancel keeps them", async t => {
  const app = await createAdmin(t, { language: "en" });
  Object.defineProperty(app.$("fileInput"), "files", { value: [new File(["enabled=true"], "settings.toml")] });
  app.$("fileInput").dispatchEvent(new app.w.Event("change", { bubbles: true }));
  await until(() => !app.$("uploadButton").disabled);
  app.input("languageSelect", "ru");
  assert.equal(app.$("languageDialog").open, true);
  assert.equal(app.saved()["udmc-language"], undefined);
  app.$("languageDialog").close();
  await until(() => app.$("languageSelect").value === "en");
  assert.match(app.$("stagedFileList").textContent, /settings.toml/);
});

test("offline language reload keeps unsaved pack fields and does not reopen server setup", async t => {
  const app = await createAdmin(t, { connected: false, language: "ru" });
  assert.equal(app.requests.length, 0, "An unconfigured app must not contact any default server");
  assert.equal(app.$("draftStatusTitle").textContent, "Черновик недоступен");
  assert.equal(app.$("publishOpenButton").disabled, true);
  assert.equal(app.$("restartServerButton").disabled, true);
  app.$("serverProfileDialog").close();
  app.w.document.querySelector('[data-view="overview"]').click();
  app.input("packNameInput", "Мой несохранённый мир");
  app.input("languageSelect", "en");
  const session = Object.fromEntries(Array.from({ length: app.w.sessionStorage.length }, (_, i) => {
    const key = app.w.sessionStorage.key(i); return [key, app.w.sessionStorage.getItem(key)];
  }));
  const reopened = await createAdmin(t, { connected: false, storage: app.saved(), session });
  assert.equal(reopened.$("serverProfileDialog").open, false);
  assert.equal(reopened.$("viewTitle").textContent, "Pack");
  assert.equal(reopened.$("packNameInput").value, "Мой несохранённый мир");
  assert.equal(reopened.$("draftStatusTitle").textContent, "Draft unavailable");
  assert.equal(reopened.$("publishOpenButton").disabled, true);
  assert.equal(reopened.$("restartServerButton").disabled, true);
  assert.equal(reopened.requests.length, 0);
});

test("language reload keeps an unsaved profile display name until it is saved", async t => {
  const app = await createAdmin(t, { language: "ru" });
  app.click("serverProfileSettingsButton");
  app.input("serverProfileName", "Прод сервер (переименован)");
  app.input("languageSelect", "en");
  const session = Object.fromEntries(Array.from({ length: app.w.sessionStorage.length }, (_, i) => {
    const key = app.w.sessionStorage.key(i); return [key, app.w.sessionStorage.getItem(key)];
  }));
  const reopened = await createAdmin(t, { storage: app.saved(), session });
  assert.equal(reopened.$("serverProfileDialog").open, true);
  assert.equal(reopened.$("serverProfileName").value, "Прод сервер (переименован)");
  reopened.submit("serverProfileForm");
  assert.match(reopened.$("toastRegion").textContent, /Server name saved/);
  reopened.input("languageSelect", "ru");
  const savedSession = Object.fromEntries(Array.from({ length: reopened.w.sessionStorage.length }, (_, i) => {
    const key = reopened.w.sessionStorage.key(i); return [key, reopened.w.sessionStorage.getItem(key)];
  }));
  const savedEntry = JSON.parse(Object.entries(savedSession).find(([key]) => key.startsWith("udmc-ui-session:"))[1]);
  assert.equal(savedEntry.profileNameDirty, false);
  const third = await createAdmin(t, { storage: reopened.saved(), session: savedSession, language: "ru" });
  assert.equal(third.$("serverProfileName").value, "Прод сервер (переименован)");
  assert.equal(third.$("serverProfileSelect").selectedOptions[0].textContent, "Прод сервер (переименован)");
});

test("the chosen catalog source survives a language reload", async t => {
  const app = await createAdmin(t, { session: { "udmc-ui-session:legacy": JSON.stringify({ view: "modrinth", catalog: "github" }) } });
  assert.equal(app.$("githubSourceTab").getAttribute("aria-selected"), "true");
  assert.equal(app.$("githubPanel").hidden, false);
});
