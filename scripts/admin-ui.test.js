import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAdmin, deferred, response, until } from "./test-support/admin-dom.js";
import { zipSync, strToU8 } from "fflate";

test("the complete admin UI boots with native catalog and a connected server", async t => {
  const ui = await createAdmin(t);
  assert.equal(ui.$("statusBadge").textContent, "Сервер доступен");
  assert.equal(ui.$("generatorMinecraft").options.length, 3);
  assert.ok([...ui.w.document.querySelectorAll("[data-protected-setting]")].every(e => e.disabled || e.readOnly));
  assert.equal(ui.errors.length, 0);
});

test("a saved address without a trailing slash restores only its matching credentials", async t => {
  const ui = await createAdmin(t, { secrets: { "admin-connection": JSON.stringify({ url: "https://agent.test", token: "test-key" }) } });
  assert.equal(ui.$("serverUrlInput").value, "https://agent.test/");
  assert.equal(ui.$("tokenInput").value, "test-key");
  assert.equal(ui.$("statusBadge").textContent, "Сервер доступен");
  const other = await createAdmin(t, { secrets: { "admin-connection": JSON.stringify({ url: "https://agent.test", token: "old-key" }) }, storage: { "udmc-control-server-url": "https://other.test/" } });
  assert.equal(other.$("tokenInput").value, "");
  assert.ok(!other.requests.some(r => r.options.headers?.authorization?.includes("old-key")));
});

test("damaged profiles show a recovery error without reading Windows credentials", async t => {
  const raw = "{broken";
  const ui = await createAdmin(t, { connected: false, storage: { "udmc-server-profiles-v1": raw } });
  assert.equal(ui.$("profileStorageError").hidden, false);
  assert.equal(ui.$("serverProfileSelect").disabled, true);
  assert.equal(ui.invocations.filter(call => call.name === "credential_read").length, 0);
  assert.equal(ui.$("tokenInput").value, "");
  assert.equal(ui.saved()["udmc-server-profiles-v1"], raw);
});

test("a pending server command blocks duplicate commands and language changes", async t => {
  const gate = deferred();
  const ui = await createAdmin(t, { fetch: ({ url }) => url.pathname === "/admin/server/command" ? gate.promise : undefined });
  ui.input("commandInput", "list"); ui.submit("commandForm");
  await until(() => ui.requests.some(r => r.url.pathname === "/admin/server/command"));
  ui.input("commandInput", "list"); ui.submit("commandForm");
  ui.input("languageSelect", "en");
  assert.equal(ui.$("commandInput").value, "list");
  assert.equal(ui.$("languageSelect").value, "ru");
  assert.equal(ui.requests.filter(r => r.url.pathname === "/admin/server/command").length, 1);
  gate.resolve(response({ output: "No players" }));
  await until(() => ui.$("consoleOutput").textContent.includes("No players"));
  assert.equal(ui.$("commandSubmitButton").disabled, false);
});

test("agent update confirmations cannot survive a changed server release", async t => {
  let value = { protocol: 1, currentVersion: "0.3.0", signed: true, canUpdate: true, client: { version: "0.3.0", sequence: 1 },
    packId: "test", minecraftVersion: "26.2", loaderType: "fabric", loaderVersion: "0.19.3", downloadUrl: "https://agent.test/agents/download", update: { state: "idle" } };
  const ui = await createAdmin(t, { fetch: ({ url }) => {
    if (url.pathname === "/admin/status") return response({ state: "online", agentProtocol: 1, capabilities: {} });
    if (url.pathname === "/admin/agents") return response(value);
  } });
  await until(() => !ui.$("agentUpdateButton").disabled);
  ui.click("agentUpdateButton");
  value = { ...value, client: { version: "0.3.1", sequence: 2 } };
  ui.click("refreshButton");
  await until(() => ui.$("agentDeliveryStatus").textContent.includes("0.3.1"));
  ui.submit("agentUpdateConfirmForm");
  assert.equal(ui.requests.filter(r => r.url.pathname === "/admin/agents/update").length, 0);
  assert.match(ui.$("toastRegion").textContent, /Настройки изменились/);
});

test("the game address renders from the agent, saves through settings and shows a typed rejection", async t => {
  let value = { protocol: 1, currentVersion: "0.3.0", signed: true, canUpdate: true, requireClient: false, gameAddress: "play.old.example",
    packId: "test", minecraftVersion: "26.2", loaderType: "fabric", loaderVersion: "0.19.3", downloadUrl: "https://agent.test/agents/download", update: { state: "idle" },
    client: { version: "0.3.0", sequence: 1 } };
  const settingsBodies = [];
  const ui = await createAdmin(t, { fetch: ({ url, options }) => {
    if (url.pathname === "/admin/status") return response({ state: "online", agentProtocol: 1, capabilities: {} });
    if (url.pathname === "/admin/agents") return response(value);
    if (url.pathname === "/admin/agents/settings") {
      const body = JSON.parse(options.body); settingsBodies.push(body);
      if (body.gameAddress === "bad address") return response({ error: "Enter the game address as host or host:port, or leave it empty.", code: "GAME_ADDRESS_INVALID", args: [] }, 400);
      value = { ...value, ...body }; return response(value);
    }
  } });
  await until(() => ui.$("gameAddressInput").value === "play.old.example");
  ui.input("gameAddressInput", "bad address"); ui.submit("agentPolicyForm");
  await until(() => ui.$("toastRegion").textContent.includes("Игровой адрес должен быть вида host или host:port"));
  ui.input("gameAddressInput", "play.new.example:25565"); ui.submit("agentPolicyForm");
  await until(() => settingsBodies.length === 2 && ui.$("toastRegion").textContent.includes("Игровой адрес сохранён"));
  assert.deepEqual(settingsBodies[1], { requireClient: false, gameAddress: "play.new.example:25565" });
  assert.equal(ui.$("gameAddressInput").value, "play.new.example:25565");
  // The switch used to wait for the address field's save button, so the rule came back
  // off after the next reload: flipping it has to reach the server by itself.
  ui.$("requireClientAgent").click();
  await until(() => settingsBodies.length === 3 && ui.$("toastRegion").textContent.includes("Теперь войти можно только с клиентским UDMC"));
  assert.deepEqual(settingsBodies[2], { requireClient: true, gameAddress: "play.new.example:25565" });
  assert.equal(ui.$("requireClientAgent").checked, true);
  // Each control belongs to a caption that names it: the section used to be one pile in
  // which the version, the player link and the join rules were told apart only by reading.
  const groups = [...ui.w.document.querySelectorAll('[data-agent-panel="agents"] fieldset.generator-group')];
  assert.deepEqual(groups.map(group => group.querySelector("legend").textContent.trim()),
    ["Версия агента на сервере", "Ссылка для игроков", "Правила входа игроков"]);
  for (const control of ui.w.document.querySelectorAll('[data-agent-panel="agents"] input, [data-agent-panel="agents"] button')) {
    assert.ok(control.closest("fieldset.generator-group"), `Вне группы: ${control.id || control.textContent.trim()}`);
  }
});

test("connecting automatically delivers only the public client agent and requires confirmation for updates", async t => {
  let value = { protocol: 1, currentVersion: "0.3.0", signed: true, canUpdate: true, requireClient: false,
    packId: "test", minecraftVersion: "26.2", loaderType: "fabric", loaderVersion: "0.19.3", downloadUrl: "https://agent.test/agents/download", update: { state: "idle" } };
  const ui = await createAdmin(t, {
    native: (name) => name === "prepare_agent_package" ? { bytes: Buffer.from("fixture-agent").toString("base64"), size: 13 } : undefined,
    fetch: ({ url, options }) => {
      if (url.pathname === "/admin/status") return response({ state: "online", agentProtocol: 1, capabilities: {} });
      if (url.pathname === "/admin/agents") return response(value);
      if (url.pathname === "/admin/agents/client") { value = { ...value, client: { version: "0.3.0" } }; return response(value, 201); }
      if (url.pathname === "/admin/agents/update") { value = { ...value, update: { state: "waiting", version: "0.4.0" } }; return response(value, 202); }
      if (url.pathname === "/admin/agents/settings") { value = { ...value, ...JSON.parse(options.body) }; return response(value); }
    }
  });
  await until(() => ui.$("agentDownloadUrl").textContent.includes("/agents/download") && !ui.$("agentUpdateButton").disabled);
  assert.equal(ui.requests.filter(r => r.url.pathname === "/admin/agents/client").length, 1);
  ui.click("refreshButton");
  await until(() => !ui.$("refreshButton").disabled);
  assert.equal(ui.requests.filter(r => r.url.pathname === "/admin/agents/client").length, 1);
  ui.click("agentUpdateButton");
  assert.equal(ui.$("agentUpdateConfirmDialog").open, true);
  assert.equal(ui.requests.filter(r => r.url.pathname === "/admin/agents/update").length, 0);
  ui.submit("agentUpdateConfirmForm");
  await until(() => ui.$("agentUpdateState").textContent.includes("0.4.0"));
  assert.equal(ui.$("agentUpdateButton").disabled, true);
  assert.equal(ui.invocations.filter(r => r.name === "prepare_agent_package")[1].args.update, true);
});

test("credential write errors preserve current connection and allow retry", async t => {
  let fail = true;
  const ui = await createAdmin(t, { native: (name, args) => {
    if (name === "credential_write" && args.name === "admin-connection" && fail) {
      throw { code: "CREDENTIAL_WRITE_FAILED", args: [], fallback: "Could not save protected data." };
    }
  } });
  ui.edit("connection"); ui.input("edit-serverUrlInput", "other.test"); ui.submit("protectedSettingsForm");
  await until(() => ui.$("protectedSettingsError").textContent);
  assert.equal(ui.$("protectedSettingsError").textContent, "Не удалось сохранить защищённые данные в хранилище Windows.");
  assert.equal(ui.$("serverUrlInput").value, "https://agent.test/");
  assert.equal(ui.$("tokenInput").value, "test-key");
  assert.equal(ui.$("protectedSettingsApply").disabled, false);
  fail = false; ui.submit("protectedSettingsForm");
  await until(() => !ui.$("protectedSettingsDialog").open);
  assert.equal(ui.$("serverUrlInput").value, "https://other.test/");
  assert.equal(ui.$("tokenInput").value, "");
  assert.equal(JSON.parse(ui.vault.get("admin-connection")).token, "");
});

test("secret drafts are masked and removed on cancellation", async t => {
  const ui = await createAdmin(t);
  ui.click("tokenVisibilityButton"); ui.edit("token");
  assert.equal(ui.$("edit-tokenInput").type, "password");
  ui.input("edit-tokenInput", "new-secret"); ui.click("protectedSettingsCancel");
  await until(() => !ui.$("edit-tokenInput"));
  assert.equal(ui.$("tokenInput").value, "test-key");
  assert.equal(ui.invocations.filter(c => c.name === "credential_write").length, 0);
});

test("HTTP consent does not follow an edited address", async t => {
  const ui = await createAdmin(t);
  ui.edit("connection"); ui.input("edit-serverUrlInput", "192.0.2.1:3077");
  ui.submit("protectedSettingsForm");
  await until(() => ui.$("protectedSettingsError").textContent);
  ui.click("edit-allowHttpConnection"); ui.input("edit-serverUrlInput", "192.0.2.2:3077");
  assert.equal(ui.$("edit-allowHttpConnection").checked, false);
  assert.equal(ui.$("allowHttpConnection").checked, false);
});

test("an asynchronous save cannot be submitted twice or cancelled halfway", async t => {
  const gate = deferred();
  const ui = await createAdmin(t, { native: (name, args) => name === "credential_write" && args.name === "admin-connection" ? gate.promise : undefined });
  ui.edit("token"); ui.input("edit-tokenInput", "replacement"); ui.submit("protectedSettingsForm");
  await until(() => ui.$("protectedSettingsCancel").disabled);
  ui.submit("protectedSettingsForm"); ui.click("protectedSettingsCancel");
  assert.equal(ui.$("protectedSettingsDialog").open, true);
  assert.equal(ui.$("tokenInput").value, "test-key");
  assert.equal(ui.invocations.filter(c => c.name === "credential_write").length, 1);
  gate.resolve(null);
  await until(() => !ui.$("protectedSettingsDialog").open);
  assert.equal(ui.$("tokenInput").value, "replacement");
});

test("platform selection derives the supported loader and persists", async t => {
  const ui = await createAdmin(t);
  ui.edit("platform"); ui.input("edit-generatorMinecraft", "1.21.1");
  assert.equal(ui.$("edit-generatorLoaderVersion").value, "0.19.3");
  assert.equal(ui.$("edit-generatorLoaderVersion").disabled, true);
  ui.submit("protectedSettingsForm"); await until(() => !ui.$("protectedSettingsDialog").open);
  assert.equal(ui.$("generatorMinecraft").value, "1.21.1");
  assert.ok(ui.$("generatorJava").textContent.includes("21"));
  assert.equal(ui.$("generatorMinecraft").disabled, true);
});

test("NeoForge selection survives restart and generates the correct template for the same Minecraft version", async t => {
  const ui = await createAdmin(t);
  ui.edit("platform"); ui.input("edit-generatorLoader", "neoforge");
  assert.equal(ui.$("edit-generatorMinecraft").value, "1.21.1");
  assert.equal(ui.$("edit-generatorMinecraft").options.length, 1);
  assert.equal(ui.$("edit-generatorLoaderVersion").value, "21.1.248");
  ui.submit("protectedSettingsForm"); await until(() => !ui.$("protectedSettingsDialog").open);
  assert.equal(ui.$("generatorLoader").value, "neoforge");
  assert.equal(ui.$("generatorLoaderVersion").value, "21.1.248");
  const reopened = await createAdmin(t, { storage: ui.saved(), native: name => name === "save_agent" ? null : undefined });
  assert.equal(reopened.$("generatorLoader").value, "neoforge");
  assert.equal(reopened.$("generatorMinecraft").value, "1.21.1");
  reopened.submit("generatorForm"); await until(() => reopened.invocations.some(c => c.name === "save_agent"));
  const request = reopened.invocations.find(c => c.name === "save_agent").args.request;
  assert.equal(request.templateId, "neoforge-1.21.1");
  assert.equal(request.loaderVersion, "21.1.248");
  // Nothing about a project travels with it: the file is the same for every server.
  assert.deepEqual(Object.keys(request).sort(), ["loaderVersion", "templateId"]);
  // The dialog only opens once saving has finished releasing the form.
  await until(() => !reopened.$("generateAgentsButton").disabled);
  reopened.edit("platform"); reopened.input("edit-generatorLoader", "fabric");
  assert.equal(reopened.$("edit-generatorMinecraft").value, "1.21.1");
  assert.equal(reopened.$("edit-generatorLoaderVersion").value, "0.19.3");
  reopened.click("protectedSettingsCancel");
  assert.equal(reopened.$("generatorLoader").value, "neoforge");
});

test("old Fabric settings without a loader remain Fabric", async t => {
  const ui = await createAdmin(t, { storage: { "udmc-generator-settings": JSON.stringify({ generatorMinecraft: "1.21.1" }) } });
  assert.equal(ui.$("generatorLoader").value, "fabric");
  assert.equal(ui.$("generatorMinecraft").value, "1.21.1");
});

test("Modrinth browsing can browse NeoForge offline and follows a connected server", async t => {
  const ui = await createAdmin(t, { connected: false });
  ui.w.document.querySelector('[data-view="modrinth"]').click();
  await until(() => ui.invocations.some(c => c.name === "modrinth_get") && !ui.$("modrinthLoader").disabled);
  ui.input("modrinthLoader", "neoforge");
  await until(() => ui.invocations.some(c => c.name === "modrinth_get" && c.args.query.facets?.includes("categories:neoforge")));
  assert.equal(ui.$("modrinthMinecraft").value, "1.21.1");
  const server = await createAdmin(t, { platform: { version: "1.21.1", loader: { type: "neoforge", version: "21.1.248" } } });
  server.w.document.querySelector('[data-view="modrinth"]').click();
  await until(() => server.invocations.some(c => c.name === "modrinth_get"));
  assert.equal(server.$("modrinthLoader").value, "neoforge");
  assert.equal(server.$("modrinthLoader").disabled, true);
  assert.ok(server.invocations.find(c => c.name === "modrinth_get").args.query.facets.includes("categories:neoforge"));
});

test("manual NeoForge uploads require an explicit destination", async t => {
  const ui = await createAdmin(t, { platform: { version: "1.21.1", loader: { type: "neoforge", version: "21.1.248" } } });
  const jar = zipSync({ "META-INF/neoforge.mods.toml": strToU8('modLoader="javafml"\nloaderVersion="[4,)"\n[[mods]]\nmodId="example"\nversion="1"') });
  Object.defineProperty(ui.$("fileInput"), "files", { value: [new File([jar], "example.jar")] });
  ui.$("fileInput").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
  await until(() => ui.$("stagedValidation").textContent.includes("Выберите назначение"));
  assert.equal(ui.$("uploadButton").disabled, true);
  ui.input("bulkSideInput", "both");
  assert.equal(ui.$("uploadButton").disabled, false);
});

test("RCON settings save the exact password but never auto-execute a command", async t => {
  const ui = await createAdmin(t);
  ui.edit("rcon"); ui.click("edit-rconEnabledInput");
  ui.input("edit-rconPasswordInput", "  exact password  "); ui.click("edit-rememberRconPasswordInput");
  ui.submit("protectedSettingsForm"); await until(() => !ui.$("protectedSettingsDialog").open);
  assert.equal(JSON.parse(ui.vault.get("rcon-password")).password, "  exact password  ");
  assert.equal(ui.$("rconPasswordInput").value, "  exact password  ");
  assert.equal(ui.$("rconPasswordInput").readOnly, true);
  assert.equal(ui.invocations.some(c => c.name === "rcon_execute"), false);
  assert.ok(!JSON.stringify(ui.saved()).includes("exact password"));
});

test("opening Modrinth loads popular mods and keeps protected controls locked", async t => {
  const ui = await createAdmin(t);
  ui.w.document.querySelector('[data-view="modrinth"]').click();
  await until(() => ui.invocations.some(c => c.name === "modrinth_get"));
  await until(() => !ui.$("modrinthQuery").disabled);
  assert.ok([...ui.w.document.querySelectorAll("[data-protected-setting]")].every(e => e.disabled || e.readOnly));
  assert.equal(ui.errors.length, 0);
});

test("server inventory and command catalog are discarded when switching servers", async t => {
  const ui = await createAdmin(t, { fetch: ({ url }) => url.pathname === "/admin/server/files" ? response({ files: [{ path: "config/server-a.json", sha256: "a".repeat(64), size: 2 }] }) : undefined });
  await until(() => ui.$("commandCatalog").textContent.includes("/list"));
  ui.click("scanServerFilesButton"); await until(() => ui.$("serverInventory").textContent.includes("server-a.json"));
  ui.edit("connection"); ui.input("edit-serverUrlInput", "server-b.test"); ui.submit("protectedSettingsForm");
  await until(() => !ui.$("protectedSettingsDialog").open);
  assert.ok(!ui.$("serverInventory").textContent.includes("server-a.json"));
  assert.ok(!ui.$("commandCatalog").textContent.includes("/list"));
});

test("late command responses cannot repopulate a different server's catalog", async t => {
  const gate = deferred();
  const ui = await createAdmin(t, { fetch: ({ url }) => url.pathname === "/admin/server/commands" ? gate.promise : undefined });
  await until(() => ui.requests.some(r => r.url.pathname === "/admin/server/commands"));
  ui.edit("connection"); ui.input("edit-serverUrlInput", "server-b.test"); ui.submit("protectedSettingsForm");
  await until(() => !ui.$("protectedSettingsDialog").open);
  gate.resolve(response({ commands: [{ name: "oldcommand", usage: ["oldcommand"] }], minecraftVersion: "26.2" }));
  await new Promise(setImmediate);
  assert.ok(!ui.$("commandCatalog").textContent.includes("oldcommand"));
});

test("periodic connection loss cannot re-enable server power actions through another view", async t => {
  let offline = false;
  const ui = await createAdmin(t, { fetch: ({ url }) => {
    if (url.pathname === "/admin/status") return offline ? response({ error: "Unavailable" }, 503)
      : response({ state: "online", minecraftVersion: "26.2", loader: { type: "fabric" }, players: { online: 0, max: 20, names: [] }, performance: {}, access: { role: "owner" }, capabilities: { powerActions: true } });
  } });
  assert.equal(ui.$("restartServerButton").disabled, false);
  offline = true; ui.runInterval(5000);
  await until(() => ui.$("statusBadge").textContent === "Связь потеряна");
  ui.w.document.querySelector('[data-view="modrinth"]').click();
  await new Promise(setImmediate);
  assert.equal(ui.$("restartServerButton").disabled, true);
  assert.equal(ui.$("stopServerButton").disabled, true);
});

test("RCON shows checking, confirmed access and failure in the console and sidebar", async t => {
  const gate = deferred(); let fail = false;
  const ui = await createAdmin(t, { native: (name) => {
    if (name === "rcon_execute") { if (fail) throw { code: "RCON_AUTH_FAILED", args: [], fallback: "The server rejected the RCON password." }; return gate.promise; }
  } });
  ui.edit("rcon"); ui.click("edit-rconEnabledInput"); ui.input("edit-rconPasswordInput", " secret ");
  ui.submit("protectedSettingsForm"); await until(() => !ui.$("protectedSettingsDialog").open);
  ui.click("testRconButton");
  await until(() => ui.$("rconConsoleStatus").textContent === "Проверка RCON...");
  assert.equal(ui.$("rconSidebarStatus").textContent, "RCON: проверка rcon...");
  gate.resolve("Players: Alex");
  await until(() => ui.$("rconConsoleStatus").textContent === "Доступен");
  assert.equal(ui.$("rconConnectionStatus").textContent, "Доступен");
  assert.equal(ui.invocations.find(c => c.name === "rcon_execute").args.password, " secret ");
  assert.ok(ui.$("consoleOutput").textContent.includes("Players: Alex"));
  fail = true; ui.click("testRconButton");
  await until(() => ui.$("rconConsoleStatus").textContent === "Нет доступа");
  assert.equal(ui.$("rconConnectionStatus").title, "Сервер отклонил пароль RCON.");
  assert.ok(!ui.$("consoleOutput").textContent.includes(" secret "));
});
test("build tabs separate editing, published files, server inventory and diagnostics", async t => {
  const ui = await createAdmin(t);
  const tab = name => ui.w.document.querySelector(`[data-build-tab="${name}"]`);
  tab("server").click();
  assert.equal(ui.w.document.querySelector('[data-build-panel="draft"]').hidden, true);
  assert.equal(ui.w.document.querySelector('[data-build-panel="server"]').hidden, false);
  assert.equal(tab("server").getAttribute("aria-selected"), "true");
  tab("server").focus();
  tab("server").dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(ui.w.document.querySelector('[data-build-panel="validation"]').hidden, false);
  assert.equal(ui.w.document.activeElement, tab("validation"));
});

test("unmanaged removal names the exact file and requires explicit confirmation", async t => {
  const mutations = [];
  const ui = await createAdmin(t, { fetch: ({ url, options }) => {
    if (url.pathname === "/admin/server/files") return response({ files: [{ path: "config/old.json", size: 4, sha256: "a".repeat(64) }] });
    if (url.pathname === "/admin/server/files/remove") { mutations.push(JSON.parse(options.body)); return response({ ok: true }); }
  } });
  ui.click("scanServerFilesButton"); await until(() => ui.$("serverInventory").querySelector(".icon-button"));
  ui.$("serverInventory").querySelector(".icon-button").click();
  assert.equal(ui.$("deleteDialog").open, true);
  assert.equal(ui.$("deleteFileName").textContent, "config/old.json");
  assert.match(ui.$("deleteDialogText").textContent, /резервную копию/);
  assert.equal(mutations.length, 0);
  ui.submit("deleteForm"); await until(() => !ui.$("deleteDialog").open);
  assert.deepEqual(mutations, [{ path: "config/old.json", sha256: "a".repeat(64) }]);
});
function catalogFixture() {
  const project = { id: "TestMod", project_id: "TestMod", title: "Test Mod", project_type: "mod", description: "A mod", environment: ["client_only_server_optional"],
    body: '# Details\n\n**Bold text**<script>window.secret=true</script><form id="tokenInput"></form><img src="https://evil.test/a.png" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>',
    gallery: [{ url: "https://cdn.modrinth.com/data/TestMod/images/game.png", title: "Gameplay" }, { url: "https://evil.test/pixel.png" }] };
  const version = { id: "TestVersion", project_id: project.id, version_number: "1.0", version_type: "release", game_versions: ["26.2"], loaders: ["fabric"],
    environment: "client_only_server_optional", dependencies: [], files: [{ filename: "test.jar", primary: true, size: 123, hashes: { sha512: "a".repeat(128) }, url: "https://cdn.modrinth.com/data/TestMod/versions/TestVersion/test.jar" }] };
  return { project, version, native(name, args) {
    if (name !== "modrinth_get") return;
    if (args.path === "search") return { hits: [project], total_hits: 1 };
    if (args.path === `project/${project.id}/version`) return [version];
    if (args.path === `project/${project.id}`) return project;
    if (args.path === `version/${version.id}`) return version;
  } };
}

function githubFixture(environment = "client") {
  const bytes = zipSync({ "fabric.mod.json": strToU8(JSON.stringify({ schemaVersion: 1, id: "github_test", version: "1.0", environment })) });
  const asset = { id: 123, name: "test-mod.jar", size: bytes.length, state: "uploaded", digest: null };
  const release = { name: "Test release", assets: [asset, { ...asset, id: 124, name: "test-sources.jar" }, { ...asset, id: 125, name: "installer.exe" }],
    body: '**Description**<script>window.secret=true</script><img src="https://evil.test/a.png"><a href="javascript:alert(1)">unsafe</a>' };
  return { bytes, release, native(name) {
    if (name === "github_releases") return { repository: "Author/Mod", license: { spdx_id: "MIT" }, releases: [release], hasMore: false };
    if (name === "github_download") return bytes;
  } };
}

test("GitHub imports only a reviewed JAR into the draft with its source and permitted side", async t => {
  const fixture = githubFixture(), writes = [];
  const ui = await createAdmin(t, { native: fixture.native, fetch: ({ url, options }) => {
    if (url.pathname === "/admin/files" && options.method === "POST") { writes.push(options); return response({ ok: true }, 201); }
  } });
  ui.click("githubSourceTab"); ui.input("githubRepository", "Author/Mod"); ui.submit("githubSearchForm");
  await until(() => ui.$("githubResults").querySelector("button")); ui.$("githubResults").querySelector("button").click();
  assert.equal(ui.$("githubAsset").options.length, 1);
  assert.equal(ui.$("githubDescription").querySelector("script,img[src],a[href]"), null);
  ui.click("githubPrepare"); await until(() => !ui.$("githubPrepared").hidden);
  assert.equal(ui.$("githubSide").value, "client"); assert.equal(ui.$("githubSide").options.length, 1);
  assert.equal(ui.$("githubInstall").disabled, true); assert.equal(writes.length, 0);
  ui.click("githubRights"); ui.click("githubInstall"); await until(() => writes.length === 1 && ui.$("githubPrepared").hidden);
  assert.equal(writes[0].headers["x-udmc-side"], "client");
  assert.deepEqual(JSON.parse(writes[0].headers["x-udmc-source"]), { provider: "github", projectId: "Author/Mod", versionId: "123", environment: "client_only" });
  assert.equal(ui.requests.filter(r => r.url.pathname === "/admin/publish").length, 0);
});

test("cancelling a GitHub download discards late bytes without changing the draft", async t => {
  const fixture = githubFixture(), pending = deferred();
  const ui = await createAdmin(t, { native: (name, args) => name === "github_download" ? pending.promise : fixture.native(name, args) });
  ui.click("githubSourceTab"); ui.input("githubRepository", "Author/Mod"); ui.submit("githubSearchForm");
  await until(() => ui.$("githubResults").querySelector("button")); ui.$("githubResults").querySelector("button").click();
  ui.click("githubPrepare"); await until(() => ui.invocations.some(i => i.name === "github_download"));
  ui.click("githubCancel"); pending.resolve(fixture.bytes); await new Promise(setImmediate);
  assert.equal(ui.$("githubSelection").hidden, true); assert.equal(ui.$("githubPrepared").hidden, true);
  assert.equal(ui.$("githubRepository").disabled, false);
  assert.equal(ui.requests.filter(r => r.options.method === "POST" && r.url.pathname === "/admin/files").length, 0);
});

test("GitHub refuses a wrong-loader JAR before upload", async t => {
  const fixture = githubFixture();
  const ui = await createAdmin(t, { native: fixture.native, platform: { version: "1.21.1", loader: { type: "neoforge", version: "21.1.248" } } });
  ui.click("githubSourceTab"); ui.input("githubRepository", "Author/Mod"); ui.submit("githubSearchForm");
  await until(() => ui.$("githubResults").querySelector("button")); ui.$("githubResults").querySelector("button").click();
  ui.click("githubPrepare"); await until(() => ui.$("githubStatus").textContent.includes("метаданных загрузчика"));
  assert.equal(ui.$("githubPrepared").hidden, true); assert.equal(ui.$("githubInstall").disabled, true);
});

function curseforgeFixture(environment = "client") {
  const bytes = zipSync({ "fabric.mod.json": strToU8(JSON.stringify({ schemaVersion: 1, id: "cf_test", version: "1.0", environment })) });
  const mod = { id: 55, name: "CF Mod", summary: "Test", downloads: 5, logoUrl: null, websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/cf-mod", distributionAllowed: true };
  const blocked = { ...mod, id: 56, name: "Blocked Mod", distributionAllowed: false };
  const file = { id: 900, displayName: "CF Mod 1.0", fileName: "cf-mod.jar", size: bytes.length, releaseType: 1,
    gameVersions: ["26.2", "Fabric"], requiredDependencies: 1, downloadable: true, sha1: null };
  return { bytes, native(name) {
    if (name === "curseforge_search") return { mods: [mod, blocked], total: 2, hasMore: false };
    if (name === "curseforge_files") return { files: [file], description: "<b>Desc</b><script>bad()</script>" };
    if (name === "curseforge_download") return bytes;
  } };
}

test("CurseForge asks for a personal key, keeps it in the vault and imports a reviewed JAR", async t => {
  const fixture = curseforgeFixture(), writes = [];
  const ui = await createAdmin(t, { native: fixture.native, fetch: ({ url, options }) => {
    if (url.pathname === "/admin/files" && options.method === "POST") { writes.push(options); return response({ ok: true }, 201); }
  } });
  ui.click("curseforgeSourceTab");
  await until(() => !ui.$("curseforgeKeySetup").hidden && ui.$("curseforgeCatalog").hidden);
  ui.input("curseforgeKeyInput", "test-curseforge-key-123");
  ui.submit("curseforgeKeyForm");
  await until(() => ui.$("curseforgeResults").querySelector("button"));
  assert.equal(ui.vault.get("curseforge-api-key"), "test-curseforge-key-123");
  assert.equal(ui.$("curseforgeKeySetup").hidden, true);
  assert.equal(ui.$("curseforgeResults").querySelectorAll(".catalog-row").length, 2);
  const rows = [...ui.$("curseforgeResults").querySelectorAll("button")];
  assert.equal(rows.length, 1, "A distribution-blocked mod must not be selectable");
  assert.match(ui.$("curseforgeResults").textContent, /Автор запретил раздачу через API/);
  rows[0].click();
  await until(() => ui.$("curseforgeFile").options.length === 1);
  assert.equal(ui.$("curseforgeDescription").querySelector("script"), null);
  ui.click("curseforgePrepare");
  await until(() => !ui.$("curseforgePrepared").hidden);
  assert.equal(ui.$("curseforgeSide").value, "client");
  assert.equal(ui.$("curseforgeSide").options.length, 1);
  assert.equal(ui.$("curseforgeInstall").disabled, true);
  assert.equal(writes.length, 0);
  ui.click("curseforgeRights");
  ui.click("curseforgeInstall");
  await until(() => writes.length === 1 && ui.$("curseforgePrepared").hidden);
  assert.equal(writes[0].headers["x-udmc-side"], "client");
  assert.deepEqual(JSON.parse(writes[0].headers["x-udmc-source"]),
    { provider: "curseforge", projectId: "55", versionId: "900", environment: "client_only" });
  assert.equal(ui.requests.filter(r => r.url.pathname === "/admin/publish").length, 0);
  assert.equal(ui.errors.length, 0);
});

test("removing the CurseForge key returns the catalog to key setup", async t => {
  const fixture = curseforgeFixture();
  const ui = await createAdmin(t, { native: fixture.native, secrets: {
    "admin-connection": JSON.stringify({ url: "https://agent.test/", token: "test-key" }),
    "curseforge-api-key": "stored-key-456" } });
  ui.click("curseforgeSourceTab");
  await until(() => ui.$("curseforgeKeySetup").hidden && !ui.$("curseforgeCatalog").hidden);
  ui.click("curseforgeForgetKey");
  await until(() => !ui.$("curseforgeKeySetup").hidden);
  assert.equal(ui.vault.get("curseforge-api-key"), undefined);
  assert.match(ui.$("curseforgeStatus").textContent, /Ключ удалён/);
});

test("catalog details are sanitized, show a gallery and offer only supported sides", async t => {
  const fixture = catalogFixture();
  const ui = await createAdmin(t, { native: fixture.native });
  ui.w.document.querySelector('[data-view="modrinth"]').click();
  await until(() => ui.$("modrinthResults").querySelector("button"));
  ui.$("modrinthResults").querySelector("button").click();
  await until(() => !ui.$("modrinthDetails").hidden);
  assert.equal(ui.$("modrinthResults").hidden, true);
  assert.equal(ui.$("modrinthSide").value, "client");
  assert.deepEqual([...ui.$("modrinthSide").options].map(o => o.value), ["client", "both"]);
  assert.ok(ui.$("modrinthDescription").querySelector("strong"));
  assert.equal(ui.$("modrinthDescription").querySelector("script,form,[id],[onerror],img[src],a[href]"), null);
  assert.equal(ui.$("modrinthGallery").children.length, 1);
  ui.$("modrinthGallery").querySelector("button").click();
  assert.equal(ui.$("catalogImageDialog").open, true);
  assert.match(ui.$("catalogImagePreview").src, /game.png$/);
  ui.$("catalogImageDialog").close();
  ui.click("modrinthCancel");
  assert.equal(ui.$("modrinthSelection").hidden, true);
  assert.equal(ui.$("modrinthResults").hidden, false);
  assert.equal(ui.errors.length, 0);
});

test("cancelling dependency lookup discards late results without uploading", async t => {
  const fixture = catalogFixture(), pending = deferred();
  const ui = await createAdmin(t, { native: (name, args) => name === "modrinth_get" && args.path.startsWith("version/") ? pending.promise : fixture.native(name, args) });
  ui.w.document.querySelector('[data-view="modrinth"]').click();
  await until(() => ui.$("modrinthResults").querySelector("button"));
  ui.$("modrinthResults").querySelector("button").click();
  await until(() => !ui.$("modrinthDetails").hidden);
  ui.click("modrinthResolve");
  await until(() => ui.invocations.some(i => i.name === "modrinth_get" && i.args.path.startsWith("version/")));
  assert.equal(ui.$("modrinthCancel").disabled, false);
  ui.click("modrinthCancel"); pending.resolve(fixture.version);
  await new Promise(setImmediate);
  assert.equal(ui.$("modrinthPlan").hidden, true);
  assert.equal(ui.$("modrinthSelection").hidden, true);
  assert.equal(ui.$("modrinthQuery").disabled, false);
  assert.ok(!ui.requests.some(r => r.url.pathname === "/admin/files" && r.options.method === "POST"));
});
test("a different server profile never restores the legacy server's credentials or generator settings", async t => {
  const id = "11111111-1111-4111-8111-111111111111";
  const ui = await createAdmin(t, { storage: {
    "udmc-server-profiles-v1": JSON.stringify({ active: id, profiles: [{ id: "legacy", name: "Old" }, { id, name: "New" }] }),
    "udmc-control-server-url": "https://old.test/",
    "udmc-generator-settings": JSON.stringify({ generatorMinecraft: "1.21.1" }),
    [`udmc-profile:${id}:udmc-control-server-url`]: "https://new.test/"
  }, secrets: {
    "admin-connection": JSON.stringify({ url: "https://old.test/", token: "old-secret" }),
    [`profile:${id}:admin-connection`]: JSON.stringify({ url: "https://new.test/", token: "new-secret" })
  } });
  assert.equal(ui.$("serverUrlInput").value, "https://new.test/");
  assert.equal(ui.$("tokenInput").value, "new-secret");
  assert.equal(ui.$("serverProfileSelect").value, id);
  assert.ok(ui.invocations.filter(i => i.name === "credential_read").every(i => i.args.name.startsWith(`profile:${id}:`)));
  assert.ok(ui.requests.every(r => r.url.hostname !== "old.test"));
  ui.click("serverProfileSettingsButton");
  assert.equal(ui.$("serverProfileDialog").open, true);
  assert.ok(ui.$("serverProfileDialog").contains(ui.$("generatorForm")));
  assert.ok(ui.$("serverProfileDialog").contains(ui.$("connectionForm")));
});

test("the settings page hosts the language picker and survives a reopened session", async t => {
  const ui = await createAdmin(t);
  assert.equal(ui.$("languageSelect").closest("#settingsView").id, "settingsView");
  assert.equal(ui.w.document.querySelector(".language-picker"), null, "The header must not carry a language picker anymore");
  ui.w.document.querySelector('[data-view="settings"]').click();
  assert.equal(ui.$("settingsView").classList.contains("active"), true);
  assert.equal(ui.$("viewTitle").textContent, "Настройки");
  assert.ok(ui.$("refreshButton").closest(".connection-card"), "Re-reading belongs to the connection, not to a page header");
  ui.w.dispatchEvent(new ui.w.Event("pagehide"));
  const session = Object.fromEntries(Array.from({ length: ui.w.sessionStorage.length },
    (_, i) => { const key = ui.w.sessionStorage.key(i); return [key, ui.w.sessionStorage.getItem(key)]; }));
  const reopened = await createAdmin(t, { session });
  assert.equal(reopened.$("settingsView").classList.contains("active"), true, "The settings view must survive a reopen");
  assert.equal(ui.errors.length, 0);
});

test("the translator settings keep the Yandex key in the vault and forget it on demand", async t => {
  const checks = [];
  const ui = await createAdmin(t, { native: (name, args) => {
    if (name === "translate_texts") { checks.push(args); return ["Привет"]; }
  } });
  ui.w.document.querySelector('[data-view="settings"]').click();
  assert.equal(ui.$("translatorState").textContent, "Не настроен");
  assert.equal(ui.$("translatorConfigured").hidden, true);
  ui.input("translatorKeyInput", "AQVNtest-translator-key");
  ui.submit("translatorForm");
  await until(() => ui.w.document.querySelector(".toast"));
  assert.match(ui.w.document.querySelector(".toast").textContent, /Заполните ключ API и идентификатор каталога/);
  assert.equal(ui.vault.get("translator-key"), undefined);
  ui.input("translatorFolderInput", "b1gtestfolder");
  ui.submit("translatorForm");
  // Saving runs a live check: the form gives way to the configured block.
  await until(() => ui.$("translatorState").textContent === "Перевод работает");
  assert.deepEqual(JSON.parse(ui.vault.get("translator-key")),
    { provider: "yandex", key: "AQVNtest-translator-key", folder: "b1gtestfolder" });
  assert.deepEqual(JSON.parse(JSON.stringify(checks[0])), { key: "AQVNtest-translator-key", folder: "b1gtestfolder", texts: ["Hello"], target: "ru" });
  assert.equal(ui.$("translatorForm").hidden, true, "A configured translator must not keep asking for the key");
  assert.equal(ui.$("translatorConfigured").hidden, false);
  assert.match(ui.$("translatorConfiguredSummary").textContent, /b1gtestfolder/);
  assert.match(ui.$("toastRegion").textContent, /«Hello» → «Привет»/);
  ui.click("translatorReplaceButton");
  assert.equal(ui.$("translatorForm").hidden, false, "Replace reopens the form");
  ui.click("translatorEditCancelButton");
  assert.equal(ui.$("translatorForm").hidden, true);
  ui.click("translatorForgetButton");
  await until(() => ui.$("translatorState").textContent === "Не настроен");
  assert.equal(ui.$("translatorForm").hidden, false);
  assert.equal(ui.vault.get("translator-key"), undefined);
  ui.click("translatorHelp");
  ui.click("translatorConsoleLink");
  ui.click("translatorDocsLink");
  await until(() => ui.invocations.filter(call => call.name === "open_catalog_link").length === 3);
  assert.deepEqual(ui.invocations.filter(call => call.name === "open_catalog_link").map(call => call.args.url), [
    "https://aistudio.yandex.cloud/platform/",
    "https://console.yandex.cloud/",
    "https://aistudio.yandex.ru/ru/docs/ai-studio/operations/get-api-key"
  ], "Help links must target the one-button AI Studio key flow and pages that exist in Russian");
  assert.equal(ui.errors.length, 0);
});

test("a failing translator check is reported while the key stays saved and replaceable", async t => {
  const ui = await createAdmin(t, { native: name => {
    if (name === "translate_texts") throw { code: "TRANSLATOR_UNAUTHORIZED", fallback: "rejected", args: [] };
  } });
  ui.w.document.querySelector('[data-view="settings"]').click();
  ui.input("translatorKeyInput", "AQVNbroken-translator-key");
  ui.input("translatorFolderInput", "b1gtestfolder");
  ui.submit("translatorForm");
  await until(() => ui.$("translatorState").textContent === "Проверка не прошла");
  assert.match(ui.$("toastRegion").textContent, /Яндекс отклонил ключ переводчика/);
  assert.ok(ui.vault.get("translator-key"), "A transient failure must not wipe the stored key");
  assert.equal(ui.$("translatorConfigured").hidden, false);
  assert.equal(ui.$("translatorForm").hidden, true);
  assert.equal(ui.errors.length, 0);
});

test("the translate button swaps catalog descriptions to Russian and back to the original", async t => {
  const batches = [];
  const ui = await createAdmin(t, {
    secrets: { "translator-key": JSON.stringify({ provider: "yandex", key: "AQVNtest-translator-key", folder: "b1gtestfolder" }) },
    native: (name, args) => {
      if (name === "translate_texts") { batches.push(args); return args.texts.map(text => `RU:${text}`); }
    } });
  const description = ui.$("modrinthDescription");
  description.innerHTML = "<p>Sodium is fast.</p><pre>code stays</pre><p>Improves <b>FPS</b> a lot.</p>";
  await until(() => !ui.$("modrinthTranslate").hidden, "The translate button appears for the Russian language");
  ui.click("modrinthTranslate");
  await until(() => description.textContent.includes("RU:"));
  assert.equal(description.querySelector("p").textContent, "RU:Sodium is fast.");
  assert.equal(description.querySelector("pre").textContent, "code stays", "Code blocks are never translated");
  assert.equal(description.querySelector("b").textContent, "RU:FPS");
  assert.deepEqual(JSON.parse(JSON.stringify(batches[0])), { key: "AQVNtest-translator-key", folder: "b1gtestfolder",
    texts: ["Sodium is fast.", "Improves ", "FPS", " a lot."], target: "ru" });
  assert.equal(ui.$("modrinthTranslate").textContent.trim(), "Оригинал");
  ui.click("modrinthTranslate");
  assert.equal(description.querySelector("p").textContent, "Sodium is fast.");
  assert.equal(ui.$("modrinthTranslate").textContent.trim(), "Перевести");
  description.replaceChildren();
  ui.click("modrinthTranslate");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(batches.length, 1, "An empty description must not trigger a translation request");
  assert.equal(ui.errors.length, 0);
});

test("an English interface never shows translate buttons and an unconfigured translator explains itself", async t => {
  const english = await createAdmin(t, { language: "en-US", storage: { "udmc-language": "en" } });
  english.$("modrinthDescription").innerHTML = "<p>Text</p>";
  assert.equal(english.$("modrinthTranslate").hidden, true);
  const unconfigured = await createAdmin(t);
  unconfigured.$("modrinthDescription").innerHTML = "<p>Some description text</p>";
  await until(() => !unconfigured.$("modrinthTranslate").hidden);
  unconfigured.click("modrinthTranslate");
  await until(() => unconfigured.w.document.querySelector(".toast"));
  assert.match(unconfigured.w.document.querySelector(".toast").textContent, /Переводчик не настроен/);
  assert.equal(unconfigured.$("modrinthDescription").textContent, "Some description text");
});

test("the dashboard aggregates attention items and live validation guides to the fix", async t => {
  const draft = { schemaVersion: 1, pack: { id: "udmc-main", name: "Test pack", version: "1.0.0" },
    minecraft: { version: "26.2", loader: { type: "fabric", version: "0.19.3" } }, files: [] };
  const ui = await createAdmin(t, { fetch: ({ url }) => {
    if (url.pathname === "/admin/validation") {
      return url.searchParams.get("target") === "draft"
        ? response({ revision: "rev-1", ok: false, checkedAt: "2026-08-30T10:00:00Z",
          issues: [{ side: "server", code: "udmc_sync.diagnostic.duplicate", args: ["mods/a.jar", "mods/b.jar"], message: "dup" }] })
        : response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z", issues: [] });
    }
    if (url.pathname === "/admin/files") return response({ revision: "rev-1", draft, files: [],
      changes: { added: 2, updated: 0, removed: 0, total: 2, dirty: true } });
    if (url.pathname === "/admin/server/files") return response({ files: [{ path: "mods/manual.jar", size: 2048, sha256: "a".repeat(64) }] });
  } });
  await until(() => ui.$("draftValidationChip").hidden === false, "The draft check ran without any button press");
  assert.equal(ui.$("dashPackName").textContent, "Test pack");
  assert.equal(ui.$("dashPublishedVersion").textContent, "1.0.0");
  assert.match(ui.$("dashDraftState").textContent, /2 изменения/);
  assert.match(ui.$("dashValidation").textContent, /1 проблема/);
  const rows = [...ui.$("attentionList").querySelectorAll(".attention-row")];
  assert.ok(rows.some(row => row.classList.contains("error") && /не пройдёт публикацию/.test(row.textContent)));
  assert.ok(rows.some(row => row.classList.contains("warn") && /не видят изменения черновика/.test(row.textContent)));
  assert.ok(!rows.some(row => row.classList.contains("ok")), "The all-good row must not show next to problems");
  rows.find(row => row.classList.contains("error")).click();
  assert.equal(ui.$("overviewView").classList.contains("active"), true);
  assert.equal(ui.w.document.querySelector('[data-build-tab="validation"]').getAttribute("aria-selected"), "true");
  assert.equal(ui.$("validationTarget").value, "draft");
  await until(() => ui.$("validationResult").querySelector(".validation-issue"));
  ui.w.document.querySelector('[data-build-tab="server"]').click();
  await until(() => ui.$("serverInventory").textContent.includes("mods/manual.jar"), "The out-of-pack list loads by itself");
  assert.match(ui.$("serverInventory").textContent, /Под управление/);
  assert.equal(ui.errors.length, 0);
});

test("an available agent update surfaces on the server page and opens the agents section", async t => {
  const ui = await createAdmin(t, {
    // "Newer available" is a version comparison against the agent this app builds.
    native: name => name === "dependency_status" ? { version: "0.9.0", templates: 1, webview: true, credentialStore: true } : undefined,
    fetch: ({ url }) => {
    if (url.pathname === "/admin/status") return response({ state: "online", minecraftVersion: "26.2",
      loader: { type: "fabric", version: "0.19.3" }, players: { online: 0, max: 20, names: [] }, performance: { tps: 20 },
      access: { id: "test-owner", role: "owner", name: "Test PC" }, agentProtocol: true,
      capabilities: { commands: true, modValidation: true, powerActions: false } });
    if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z", issues: [] });
    if (url.pathname === "/admin/agents") return response({ currentVersion: "0.5.0", canUpdate: true, signed: true,
      client: { version: "0.5.0" }, downloadUrl: "http://agent.test/agents/download", requireClient: true, gameAddress: "" });
  } });
  await until(() => [...ui.$("attentionList").querySelectorAll(".attention-row")].some(row => /на сервере 0\.5\.0, в приложении 0\.9\.0/.test(row.textContent)));
  [...ui.$("attentionList").querySelectorAll(".attention-row")].find(row => /обновление агентов/.test(row.textContent)).click();
  assert.equal(ui.$("serverProfileDialog").open, true, "The attention row must lead straight to the agents section");
  assert.equal(ui.w.document.querySelector('[data-agent-panel="agents"]').hidden, false,
    "The dialog opens on the agents section, not on whichever one was open last");
  assert.equal(ui.$("agentConnectTab").getAttribute("aria-selected"), "false");
  assert.equal(ui.errors.length, 0);
});

test("update-and-restart stages the update then opens the restart dialog, and greys out without power rights", async t => {
  const agents = { currentVersion: "0.5.0", canUpdate: true, signed: true, packId: "test", minecraftVersion: "26.2", loaderType: "fabric", loaderVersion: "0.19.3",
    client: { version: "0.5.0" }, downloadUrl: "http://agent.test/agents/download", requireClient: true, gameAddress: "" };
  // A modern agent swaps the jar in place and reports "applied" instead of "waiting":
  // both outcomes are a successful delivery that still needs a restart.
  const staged = { ...agents, update: { state: "applied", version: "0.9.0", backup: "udmc-sync/agent-update/previous.jar" } };
  const build = powerActions => ({
    native: (name, args) => {
      if (name === "dependency_status") return { version: "0.9.0", templates: 1, webview: true, credentialStore: true };
      if (name === "prepare_agent_package") return { bytes: btoa("jar"), size: 3 };
      return undefined;
    },
    fetch: ({ url, options }) => {
      if (url.pathname === "/admin/status") return response({ state: "online", minecraftVersion: "26.2",
        loader: { type: "fabric", version: "0.19.3" }, players: { online: 2, max: 20, names: ["A", "B"] }, performance: { tps: 20 },
        access: { id: "test-owner", role: "owner", name: "Test PC" }, agentProtocol: true, uptimeSeconds: 500, loadedReleaseSequence: 1,
        capabilities: { commands: true, modValidation: true, powerActions } });
      if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z", issues: [] });
      if (url.pathname === "/admin/agents/update") return response(staged);
      if (url.pathname === "/admin/agents") return response(agents);
    }
  });
  const ui = await createAdmin(t, build(true));
  ui.click("serverProfileSettingsButton");
  ui.w.document.querySelector('[data-agent-mode="agents"]').click();
  await until(() => ui.$("agentUpdateRestartButton").disabled === false);
  ui.click("agentUpdateRestartButton");
  assert.equal(ui.$("agentUpdateConfirmDialog").open, true);
  assert.equal(ui.$("agentUpdateConfirmRestart").hidden, false, "The confirmation explains that a restart follows");
  assert.equal(ui.$("agentUpdateConfirmSubmit").textContent, "Обновить и перезапустить");
  ui.submit("agentUpdateConfirmForm");
  await until(() => ui.$("powerDialog").open, "The restart dialog opens once the update is staged");
  assert.equal(ui.$("powerDelaySelect").value, "60", "Online players preselect the announced delay");

  const blocked = await createAdmin(t, build(false));
  blocked.click("serverProfileSettingsButton");
  blocked.w.document.querySelector('[data-agent-mode="agents"]').click();
  await until(() => blocked.$("agentUpdateButton").disabled === false);
  assert.equal(blocked.$("agentUpdateRestartButton").disabled, true, "Without power rights the button stays grey");
  assert.match(blocked.$("agentUpdateRestartButton").title, /Остановка и перезапуск из панели выключены/);
  assert.equal(ui.errors.length + blocked.errors.length, 0);
});

test("an up-to-date agent raises no update row and says so in the agents section", async t => {
  const ui = await createAdmin(t, {
    native: name => name === "dependency_status" ? { version: "0.5.0", templates: 1, webview: true, credentialStore: true } : undefined,
    fetch: ({ url }) => {
      if (url.pathname === "/admin/status") return response({ state: "online", minecraftVersion: "26.2",
        loader: { type: "fabric", version: "0.19.3" }, players: { online: 0, max: 20, names: [] }, performance: { tps: 20 },
        access: { id: "test-owner", role: "owner", name: "Test PC" }, agentProtocol: true, loadedReleaseSequence: 1,
        capabilities: { commands: true, modValidation: true, powerActions: false } });
      if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z", issues: [] });
      if (url.pathname === "/admin/agents") return response({ currentVersion: "0.5.0", canUpdate: true, signed: true,
        client: { version: "0.5.0" }, downloadUrl: "http://agent.test/agents/download", requireClient: true, gameAddress: "" });
    } });
  await until(() => ui.$("agentDeliveryStatus").textContent.includes("0.5.0"));
  assert.match(ui.$("agentDeliveryStatus").textContent, /Это последняя версия из этого приложения/);
  assert.ok(![...ui.$("attentionList").querySelectorAll(".attention-row")].some(row => /обновление агентов/.test(row.textContent)),
    "A matching agent version must not be advertised as an available update");
  assert.equal(ui.errors.length, 0);
});

test("a server-side file leaves the pack without deletion, and client files refuse to", async t => {
  const detached = [];
  const rows = [
    { path: "config/generated.json", side: "server", size: 100, sha256: "1".repeat(64), change: "unchanged" },
    { path: "mods/shared.jar", side: "both", size: 200, sha256: "2".repeat(64), change: "unchanged" }
  ];
  const ui = await createAdmin(t, { fetch: ({ url, options }) => {
    if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z", issues: [] });
    if (url.pathname === "/admin/files/detach") {
      const body = JSON.parse(options.body);
      if (body.path.startsWith("mods/")) return response({ error: "server only", code: "DETACH_SERVER_SIDE_ONLY", args: [] }, 409);
      detached.push(body.path);
      return response({ ok: true });
    }
    if (url.pathname === "/admin/files") return response({ revision: "rev-1",
      draft: { files: rows.filter(file => !detached.includes(file.path)) }, published: { files: rows },
      files: rows.map(file => detached.includes(file.path) ? { ...file, change: "removed", detached: true } : file),
      changes: { added: 0, updated: 0, removed: detached.length, total: detached.length, dirty: detached.length > 0 } });
  } });
  ui.w.document.querySelector('[data-view="overview"]').click();
  ui.w.document.querySelector('[data-build-tab="published"]').click();
  await until(() => ui.$("filesTable").querySelectorAll("tr.draft-row").length === 2);
  const detachButtons = [...ui.$("filesTable").querySelectorAll(".row-action.detach")];
  assert.equal(detachButtons.length, 1, "Only the server-side file offers detaching");
  detachButtons[0].click();
  await until(() => ui.$("toastRegion").textContent.includes("останется на сервере"));
  assert.deepEqual(detached, ["config/generated.json"]);
  ui.w.document.querySelector('[data-build-tab="draft"]').click();
  await until(() => ui.$("filesTable").textContent.includes("Выйдет из сборки"));
  assert.equal(ui.$("filesTable").querySelector(".change-pill.detached").textContent, "Выйдет из сборки");
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(ui.errors.length, 0);
});

test("published files are bulk-marked for deletion and the draft tab lists the pending removals", async t => {
  const draft = { schemaVersion: 1, pack: { id: "udmc-main", name: "Test pack", version: "1.0.0" },
    minecraft: { version: "26.2", loader: { type: "fabric", version: "0.19.3" } }, files: [] };
  const rows = side => [
    { path: "mods/keep.jar", side, size: 100, sha256: "1".repeat(64), change: "unchanged" },
    { path: "mods/drop-a.jar", side, size: 200, sha256: "2".repeat(64), change: "unchanged" },
    { path: "mods/drop-b.jar", side, size: 300, sha256: "3".repeat(64), change: "unchanged" }
  ];
  let removed = [];
  const ui = await createAdmin(t, { session: { "udmc-ui-session:legacy": JSON.stringify({ side: "client" }) }, fetch: ({ url, options }) => {
    if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z", issues: [] });
    if (url.pathname === "/admin/files" && options.method === "DELETE") { removed.push(url.searchParams.get("path")); return response({ ok: true }); }
    if (url.pathname === "/admin/files") return response({ revision: "rev-1",
      draft: { ...draft, files: rows("server").filter(file => !removed.includes(file.path)) },
      published: { files: rows("server") },
      files: rows("server").map(file => removed.includes(file.path) ? { ...file, change: "removed" } : file),
      changes: { added: 0, updated: 0, removed: removed.length, total: removed.length, dirty: removed.length > 0 } });
  } });
  ui.w.document.querySelector('[data-view="overview"]').click();
  // The draft tab holds only pending changes; a clean draft is an explained empty state.
  assert.match(ui.$("filesTable").textContent, /Изменений нет: черновик совпадает/);
  ui.w.document.querySelector('[data-build-tab="published"]').click();
  ui.w.document.querySelector('[data-side-filter="all"]').click();
  await until(() => ui.$("filesTable").querySelectorAll(".table-pick").length === 3);
  const picks = [...ui.$("filesTable").querySelectorAll(".table-pick")];
  picks[1].click(); picks[2].click();
  assert.match(ui.$("filesBulkBar").textContent, /Выбрано: 2/);
  ui.click("filesBulkRemove");
  assert.equal(ui.$("bulkRemoveDialog").open, true);
  assert.match(ui.$("bulkRemoveTitle").textContent, /Удалить из сборки: 2 файла\?/);
  ui.submit("bulkRemoveForm");
  await until(() => ui.$("toastRegion").textContent.includes("Помечено на удаление: 2 файла"));
  assert.deepEqual(removed, ["mods/drop-a.jar", "mods/drop-b.jar"]);
  // A "client" side filter must not hide what the next publish is about to delete.
  ui.w.document.querySelector('[data-side-filter="client"]').click();
  ui.w.document.querySelector('[data-build-tab="draft"]').click();
  await until(() => ui.$("filesTable").querySelectorAll("tr.draft-row.removed").length === 2);
  assert.match(ui.$("filesTable").textContent, /drop-a\.jar/);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(ui.errors.length, 0);
});

test("several out-of-pack files are selected and removed with one confirmed action", async t => {
  const removals = [];
  const ui = await createAdmin(t, { fetch: ({ url, options }) => {
    if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z", issues: [] });
    if (url.pathname === "/admin/server/files" && (!options.method || options.method === "GET")) return response({ files: [
      { path: "mods/manual-a.jar", size: 1024, sha256: "a".repeat(64) },
      { path: "mods/manual-b.jar", size: 2048, sha256: "b".repeat(64) },
      { path: "mods/manual-c.jar", size: 4096, sha256: "c".repeat(64) }
    ] });
    if (url.pathname === "/admin/server/files/remove") { removals.push(JSON.parse(options.body)); return response({ ok: true }); }
  } });
  ui.w.document.querySelector('[data-view="overview"]').click();
  ui.w.document.querySelector('[data-build-tab="server"]').click();
  await until(() => ui.$("serverInventory").querySelectorAll(".inventory-pick").length === 3);
  assert.match(ui.$("serverInventory").textContent, /Файлы опубликованной сборки здесь не показываются/);
  const picks = [...ui.$("serverInventory").querySelectorAll(".inventory-pick")];
  picks[0].click();
  picks[2].click();
  assert.match(ui.$("serverInventory").textContent, /Выбрано: 2/);
  ui.click("serverBulkRemove");
  assert.equal(ui.$("bulkRemoveDialog").open, true);
  assert.match(ui.$("bulkRemoveTitle").textContent, /2 файла/);
  assert.match(ui.$("bulkRemoveList").textContent, /manual-a\.jar/);
  assert.match(ui.$("bulkRemoveList").textContent, /manual-c\.jar/);
  ui.submit("bulkRemoveForm");
  await until(() => ui.$("toastRegion").textContent.includes("Удаление добавлено в черновик"));
  assert.deepEqual(removals.map(r => r.path), ["mods/manual-a.jar", "mods/manual-c.jar"]);
  assert.deepEqual(removals.map(r => r.sha256), ["a".repeat(64), "c".repeat(64)]);
  assert.equal(ui.$("bulkRemoveDialog").open, false);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(ui.errors.length, 0);
});

test("publish-and-restart publishes first and then opens the restart dialog", async t => {
  const draft = { schemaVersion: 1, releaseSequence: 2, pack: { id: "udmc-main", name: "Test pack", version: "1.0.0" },
    minecraft: { version: "26.2", loader: { type: "fabric", version: "0.19.3" } }, files: [] };
  const published = [];
  const ui = await createAdmin(t, { fetch: ({ url, options }) => {
    if (url.pathname === "/manifest") return response({ schemaVersion: 1, releaseSequence: 2, pack: { id: "udmc-main", name: "Test pack", version: "1.0.0" }, minecraft: { version: "26.2", loader: { type: "fabric", version: "0.19.3" } }, files: [] });
    if (url.pathname === "/admin/status") return response({ state: "online", minecraftVersion: "26.2",
      loader: { type: "fabric", version: "0.19.3" }, players: { online: 3, max: 20, names: ["A", "B", "C"] }, performance: { tps: 20 },
      access: { id: "test-owner", role: "owner", name: "Test PC" }, uptimeSeconds: 900, loadedReleaseSequence: 1,
      capabilities: { commands: true, modValidation: true, powerActions: true } });
    if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-31T10:00:00Z", issues: [] });
    if (url.pathname === "/admin/publish") { published.push(JSON.parse(options.body)); return response({ pack: { version: "1.0.1" } }); }
    if (url.pathname === "/admin/files") return response({ revision: "rev-1", draft, published: { files: [] },
      files: [{ path: "mods/new.jar", side: "both", size: 10, sha256: "a".repeat(64), change: "added" }],
      changes: { added: 1, updated: 0, removed: 0, total: 1, dirty: true, serverRestartRecommended: true } });
  } });
  // The pack page repeats the "restart needed" signal from the server page.
  ui.w.document.querySelector('[data-view="overview"]').click();
  await until(() => ui.$("packRestartNotice").hidden === false);
  assert.match(ui.$("packRestartText").textContent, /работает на прежней версии сборки/);
  ui.click("publishOpenButton");
  assert.equal(ui.$("publishDialog").open, true);
  assert.equal(ui.$("publishRestartButton").disabled, false);
  ui.$("publishRestartButton").click();
  await until(() => ui.$("powerDialog").open, "The restart dialog follows a successful publication");
  assert.equal(published.length, 1, "The pack is published exactly once");
  assert.equal(ui.$("powerDelaySelect").value, "60", "Online players preselect the announced delay");
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(ui.errors.length, 0);
});

test("publish-and-restart is greyed out when the server forbids power actions", async t => {
  const draft = { schemaVersion: 1, releaseSequence: 2, pack: { id: "udmc-main", name: "Test pack", version: "1.0.0" },
    minecraft: { version: "26.2", loader: { type: "fabric", version: "0.19.3" } }, files: [] };
  const ui = await createAdmin(t, { fetch: ({ url }) => {
    if (url.pathname === "/manifest") return response({ schemaVersion: 1, releaseSequence: 2, pack: { id: "udmc-main", name: "Test pack", version: "1.0.0" }, minecraft: { version: "26.2", loader: { type: "fabric", version: "0.19.3" } }, files: [] });
    if (url.pathname === "/admin/status") return response({ state: "online", minecraftVersion: "26.2",
      loader: { type: "fabric", version: "0.19.3" }, players: { online: 0, max: 20, names: [] }, performance: { tps: 20 },
      access: { id: "test-owner", role: "owner", name: "Test PC" }, uptimeSeconds: 900, loadedReleaseSequence: 1,
      capabilities: { commands: true, modValidation: true, powerActions: false } });
    if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-31T10:00:00Z", issues: [] });
    if (url.pathname === "/admin/files") return response({ revision: "rev-1", draft, published: { files: [] },
      files: [{ path: "mods/new.jar", side: "both", size: 10, sha256: "a".repeat(64), change: "added" }],
      changes: { added: 1, updated: 0, removed: 0, total: 1, dirty: true, serverRestartRecommended: true } });
  } });
  ui.w.document.querySelector('[data-view="overview"]').click();
  await until(() => ui.$("packRestartNotice").hidden === false);
  assert.equal(ui.$("packRestartButton").hidden, true, "Without power rights the pack notice only explains");
  assert.match(ui.$("packRestartText").textContent, /перезапустите его вручную/);
  ui.click("publishOpenButton");
  assert.equal(ui.$("publishRestartButton").disabled, true);
  assert.match(ui.$("publishRestartButton").title, /Остановка и перезапуск из панели выключены/);
  assert.equal(ui.errors.length, 0);
});

test("a stale running pack offers a delayed restart with a player countdown", async t => {
  const power = [];
  const ui = await createAdmin(t, { fetch: ({ url, options }) => {
    if (url.pathname === "/admin/status") return response({ state: "online", minecraftVersion: "26.2",
      loader: { type: "fabric", version: "0.19.3" }, players: { online: 2, max: 20, names: ["A", "B"] }, performance: { tps: 20 },
      access: { id: "test-owner", role: "owner", name: "Test PC" }, uptimeSeconds: 1000, loadedReleaseSequence: 0,
      capabilities: { commands: true, modValidation: true, powerActions: true } });
    if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z", issues: [] });
    if (url.pathname === "/admin/server/restart") { power.push(JSON.parse(options.body)); return response({ accepted: true }, 202); }
  } });
  await until(() => [...ui.$("attentionList").querySelectorAll(".attention-row")].some(row => /прежней версии сборки/.test(row.textContent)));
  [...ui.$("attentionList").querySelectorAll(".attention-row")].find(row => /прежней версии сборки/.test(row.textContent)).click();
  assert.equal(ui.$("powerDialog").open, true);
  assert.equal(ui.$("powerDelaySelect").value, "60", "Online players preselect the announced delay");
  ui.submit("powerForm");
  await until(() => ui.$("toastRegion").textContent.includes("Запланировано"));
  assert.deepEqual(power[0], { delaySeconds: 60 });
  assert.equal(ui.errors.length, 0);
});

test("a scheduled power action shows a countdown row and cancels with one click", async t => {
  const calls = [];
  const ui = await createAdmin(t, { fetch: ({ url, options }) => {
    if (url.pathname === "/admin/status") return response({ state: "online", minecraftVersion: "26.2",
      loader: { type: "fabric", version: "0.19.3" }, players: { online: 1, max: 20, names: ["A"] }, performance: { tps: 20 },
      access: { id: "test-owner", role: "owner", name: "Test PC" }, uptimeSeconds: 1000, loadedReleaseSequence: 1,
      power: { action: "restart", executeAt: Date.now() + 90000, delaySeconds: 90 },
      capabilities: { commands: true, modValidation: true, powerActions: true } });
    if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z", issues: [] });
    if (url.pathname === "/admin/server/restart") { calls.push(JSON.parse(options.body)); return response({ cancelled: true }); }
  } });
  await until(() => [...ui.$("attentionList").querySelectorAll(".attention-row")].some(row => /отсчёт в чате/.test(row.textContent)));
  const row = [...ui.$("attentionList").querySelectorAll(".attention-row")].find(row => /отсчёт в чате/.test(row.textContent));
  assert.match(row.textContent, /Перезапуск сервера через/);
  row.click();
  await until(() => ui.$("toastRegion").textContent.includes("Отменено"));
  assert.deepEqual(calls[0], { cancel: true });
  // The cancel handler refreshes the status in the background; let it settle inside the test.
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(ui.errors.length, 0);
});

test("a clean connected pack shows the single all-good attention row", async t => {
  const ui = await createAdmin(t, { fetch: ({ url }) => {
    if (url.pathname === "/admin/validation") return response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z", issues: [] });
  } });
  await until(() => ui.$("attentionList").querySelector(".attention-row.ok"));
  assert.equal(ui.$("attentionList").querySelectorAll(".attention-row").length, 1);
  assert.equal(ui.$("attentionBadge").textContent, "Всё в порядке");
  assert.equal(ui.$("draftValidationChip").hidden, true);
  assert.match(ui.$("dashValidation").textContent, /Проблем нет/);
  assert.equal(ui.errors.length, 0);
});

test("an open settings dialog locks the workspace scroller beneath it", async t => {
  // jsdom does not apply styles: the stylesheet rules are asserted as text, the selector against the live DOM.
  const css = await readFile(new URL("../apps/admin-desktop/ui/assets/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.workspace:has\(dialog\[open\]\) \{ overflow-y: hidden; \}/);
  assert.match(css, /dialog \{ overscroll-behavior: contain; \}/);
  const ui = await createAdmin(t);
  const workspace = ui.w.document.querySelector("main.workspace");
  assert.ok(workspace.contains(ui.$("serverProfileDialog")));
  assert.equal(ui.w.document.querySelector(".workspace:has(dialog[open])"), null);
  ui.click("serverProfileSettingsButton");
  assert.equal(ui.$("serverProfileDialog").open, true);
  assert.equal(ui.w.document.querySelector(".workspace:has(dialog[open])"), workspace);
  ui.$("serverProfileDialog").close();
  assert.equal(ui.w.document.querySelector(".workspace:has(dialog[open])"), null);
});
