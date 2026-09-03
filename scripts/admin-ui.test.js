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

test("a dropdown is drawn by the panel, inside the dialog it belongs to", async t => {
  const ui = await createAdmin(t);
  const select = ui.$("powerDelaySelect");
  let changes = 0;
  select.addEventListener("change", () => changes++);
  const press = new ui.w.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  select.dispatchEvent(press);
  // Cancelling the press is what keeps the operating system from opening its own list.
  assert.equal(press.defaultPrevented, true);
  const menu = ui.w.document.querySelector(".select-menu");
  assert.ok(menu, "The panel draws the list itself");
  assert.equal(menu.closest("dialog")?.id, "powerDialog",
    "A list for a control inside a modal is drawn inside that modal");
  assert.deepEqual([...menu.children].map(row => row.textContent), [...select.options].map(option => option.textContent));

  const last = menu.children[menu.children.length - 1];
  last.dispatchEvent(new ui.w.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  assert.equal(select.value, select.options[select.options.length - 1].value);
  assert.equal(changes, 1, "One change event, as a native list would send");
  assert.equal(ui.w.document.querySelector(".select-menu"), null, "The list closes after a choice");
  assert.equal(ui.errors.length, 0);
});

test("an explanation is drawn by the panel and a title is put back afterwards", async t => {
  const ui = await createAdmin(t);
  const button = ui.$("refreshButton");
  const title = button.getAttribute("title");
  assert.ok(title, "The refresh button explains itself with a title");

  button.dispatchEvent(new ui.w.Event("pointerover", { bubbles: true }));
  assert.equal(button.hasAttribute("title"), false, "Lifted off, so Windows draws nothing of its own");
  await until(() => ui.w.document.querySelector(".tooltip-bubble:not([hidden])"));
  assert.equal(ui.w.document.querySelector(".tooltip-bubble").textContent, title);

  button.dispatchEvent(new ui.w.Event("pointerout", { bubbles: true }));
  assert.equal(button.getAttribute("title"), title, "And put back on the way out");
  assert.equal(ui.w.document.querySelector(".tooltip-bubble").hidden, true);

  // The question marks are the same bubble: they used to carry a box of their own in CSS.
  const hint = ui.w.document.querySelector("#pairSection .hint") || ui.w.document.querySelector(".hint");
  hint.dispatchEvent(new ui.w.Event("pointerover", { bubbles: true }));
  await until(() => ui.w.document.querySelector(".tooltip-bubble:not([hidden])"));
  assert.equal(ui.w.document.querySelector(".tooltip-bubble").textContent, hint.dataset.hint);
  assert.equal(ui.errors.length, 0);
});

test("a message to players goes out as one command and its answer stays where it was asked", async t => {
  const ui = await createAdmin(t, { fetch: ({ url }) => url.pathname === "/admin/server/command"
    ? response({ output: "Broadcast delivered" }) : undefined });
  ui.input("broadcastInput", "  restart   in five  ");
  ui.submit("broadcastForm");
  await until(() => ui.$("serverReplyText").textContent.includes("Broadcast delivered"));
  const sent = ui.requests.filter(r => r.url.pathname === "/admin/server/command");
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].options.body).command, "say restart in five");
  assert.equal(ui.$("broadcastInput").value, "", "A sent message clears the field");
  assert.equal(ui.$("serverReplyCommand").textContent, "> say restart in five");
  assert.equal(ui.errors.length, 0);
});

test("the log badge counts what has not been read, not what is stored", async t => {
  const ui = await createAdmin(t);
  await until(() => !ui.$("activityCount").hidden);
  assert.ok(Number(ui.$("activityCount").textContent) > 0);

  ui.w.document.querySelector('[data-view="activity"]').click();
  assert.equal(ui.$("activityCount").hidden, true, "Opening the log reads it");
  ui.w.document.querySelector('[data-view="dashboard"]').click();
  assert.equal(ui.$("activityCount").hidden, true, "Read entries do not come back");
  assert.ok(ui.$("logOutput").textContent.trim().length > 0, "And the log itself is still there");
  assert.equal(ui.errors.length, 0);
});

test("the console turns on with a password and off when it is cleared", async t => {
  const ui = await createAdmin(t);
  assert.equal(ui.$("commandTransportLabel").textContent, "UDMC Agent");
  ui.edit("rcon"); ui.input("edit-rconPasswordInput", "secret"); ui.submit("protectedSettingsForm");
  await until(() => !ui.$("protectedSettingsDialog").open);
  assert.equal(ui.$("commandTransportLabel").textContent, "RCON", "Filling it in is the answer; there is no switch");
  assert.equal(JSON.parse(ui.vault.get("rcon-password")).password, "secret", "Kept without asking whether to keep it");

  ui.edit("rcon"); ui.input("edit-rconPasswordInput", ""); ui.submit("protectedSettingsForm");
  await until(() => !ui.$("protectedSettingsDialog").open);
  assert.equal(ui.$("commandTransportLabel").textContent, "UDMC Agent", "Clearing it is how the console is switched off");
  assert.equal(ui.vault.get("rcon-password"), undefined, "And the password goes with it");
  assert.equal(ui.$("rconConnectionStatus").textContent, "Не настроен");
  assert.equal(ui.errors.length, 0);
});

test("a settled key is connected with, without anyone pressing a button", async t => {
  const ui = await createAdmin(t);
  await until(() => ui.requests.some(r => r.url.pathname === "/manifest"));
  const before = ui.requests.filter(r => r.url.pathname === "/manifest").length;
  // Connecting is what the panel is for; a key that has just been settled is an instruction
  // to use it, and there is no longer a button that would have to be found and pressed.
  ui.edit("token"); ui.input("edit-tokenInput", "another-key"); ui.submit("protectedSettingsForm");
  await until(() => !ui.$("protectedSettingsDialog").open);
  await until(() => ui.requests.filter(r => r.url.pathname === "/manifest").length > before);
  assert.equal(ui.w.document.querySelector("#connectButton"), null, "There is no button left to press");
  assert.equal(ui.errors.length, 0);
});

test("a name is shown until the pencil is pressed, and the same button saves it", async t => {
  const ui = await createAdmin(t, { fetch: ({ url }) => url.pathname === "/admin/settings" ? response({ ok: true }) : undefined });
  ui.w.document.querySelector('[data-view="overview"]').click();
  assert.equal(ui.$("packSettingsForm").hidden, true, "A name reads as a name, not as a field to fill in");
  assert.equal(ui.$("packNameHeading").textContent, "Test pack");

  ui.click("renamePackButton");
  assert.equal(ui.$("packSettingsForm").hidden, false);
  ui.input("packNameInput", "Другая сборка");
  ui.submit("packSettingsForm");
  await until(() => ui.$("packSettingsForm").hidden === true);
  assert.equal(ui.$("packNameHeading").textContent, "Другая сборка");
  assert.equal(JSON.parse(ui.requests.find(r => r.url.pathname === "/admin/settings").options.body).packName, "Другая сборка");

  // The server name in the sidebar works the same way, and locks itself again after saving.
  ui.click("serverProfileSettingsButton");
  assert.equal(ui.$("serverProfileName").readOnly, true);
  ui.click("renameProfileButton");
  assert.equal(ui.$("serverProfileName").readOnly, false);
  ui.input("serverProfileName", "Прод");
  ui.click("renameProfileButton");
  assert.equal(ui.$("serverProfileName").readOnly, true);
  assert.equal(ui.$("serverProfileSelect").options[0].textContent, "Прод");
  assert.equal(ui.errors.length, 0);
});

test("the login rule is switched by its switch, and the question mark only explains it", async t => {
  const bodies = [];
  const ui = await createAdmin(t, { fetch: ({ url, options }) => {
    if (url.pathname === "/admin/status") return response({ state: "online", agentProtocol: 1, capabilities: { powerActions: true } });
    if (url.pathname === "/admin/agents") {
      return response({ currentVersion: "0.5.0", canUpdate: false, signed: true, client: { version: "0.5.0" },
        downloadUrl: "http://agent.test/agents/download", requireClient: false, gameAddress: "" });
    }
    if (url.pathname === "/admin/agents/settings") {
      bodies.push(JSON.parse(options.body));
      return response({ currentVersion: "0.5.0", canUpdate: false, signed: true, client: { version: "0.5.0" },
        downloadUrl: "http://agent.test/agents/download", ...bodies[bodies.length - 1] });
    }
    return undefined;
  } });
  ui.click("serverProfileSettingsButton");
  ui.w.document.querySelector('[data-agent-mode="agents"]').click();
  await until(() => ui.$("requireClientAgent").disabled === false);

  // The checkbox itself is a pixel wide and invisible; what a person presses is the switch
  // drawn beside it, and only the label decides where that press lands. The question mark in
  // the same label is a button, and a button is labelable: it took the press for itself, so
  // the rule never moved and its own explanation popped up instead.
  const row = ui.$("requireClientAgent").closest("label");
  assert.equal(row.control, ui.$("requireClientAgent"), "The row belongs to the rule, not to the hint beside it");
  row.querySelector("i[aria-hidden]").click();
  await until(() => bodies.length === 1);
  assert.equal(bodies[0].requireClient, true);
  // The switch is disabled for the length of the request; waiting for it to come back
  // keeps the whole save inside the test instead of after it, where the window is gone.
  await until(() => ui.$("requireClientAgent").disabled === false);
  assert.equal(ui.$("requireClientAgent").checked, true);

  row.querySelector(".hint").click();
  assert.equal(ui.$("requireClientAgent").checked, true, "Asking what the rule means must not change it");
  assert.equal(bodies.length, 1);
  assert.equal(ui.errors.length, 0);
});

test("every label belongs to the field it draws", async t => {
  const ui = await createAdmin(t);
  for (const label of ui.w.document.querySelectorAll("label")) {
    const fields = label.querySelectorAll("input, select, textarea");
    if (!fields.length) continue;
    assert.equal(label.control, fields[0], `Label points elsewhere: ${label.textContent.trim().slice(0, 48)}`);
  }
  assert.equal(ui.errors.length, 0);
});

test("the game address is opened and saved by the one button inside its field", async t => {
  const bodies = [];
  const ui = await createAdmin(t, { fetch: ({ url, options }) => {
    if (url.pathname === "/admin/status") {
      return response({ state: "online", agentProtocol: 1, capabilities: { powerActions: true } });
    }
    if (url.pathname === "/admin/agents") {
      return response({ currentVersion: "0.5.0", canUpdate: false, signed: true, client: { version: "0.5.0" },
        downloadUrl: "http://agent.test/agents/download", requireClient: false, gameAddress: "" });
    }
    if (url.pathname === "/admin/agents/settings") {
      bodies.push(JSON.parse(options.body));
      return response({ currentVersion: "0.5.0", canUpdate: false, signed: true, client: { version: "0.5.0" },
        downloadUrl: "http://agent.test/agents/download", ...bodies[bodies.length - 1] });
    }
    return undefined;
  } });
  ui.click("serverProfileSettingsButton");
  ui.w.document.querySelector('[data-agent-mode="agents"]').click();
  await until(() => ui.$("agentPolicySave").disabled === false);
  assert.equal(ui.$("gameAddressInput").readOnly, true, "Shown, not open for typing");

  ui.click("agentPolicySave");
  assert.equal(ui.$("gameAddressInput").readOnly, false);
  ui.input("gameAddressInput", "play.udmc.test:25565");
  ui.click("agentPolicySave");
  await until(() => ui.$("gameAddressInput").readOnly === true);
  assert.deepEqual(bodies[bodies.length - 1], { requireClient: false, gameAddress: "play.udmc.test:25565" });
  assert.equal(ui.errors.length, 0);
});

test("a claimed server shows what this panel holds instead of a field for a code", async t => {
  const ui = await createAdmin(t, { storage: { "udmc-control-server-url": "https://agent.test/" },
    fetch: ({ url }) => url.pathname === "/pair"
      ? response({ unpaired: false, packName: "UDMC Main", minecraftVersion: "26.2", loaderType: "fabric" })
      : undefined });
  // Asking the server whether it is claimed happens when the tab that would claim it is opened.
  ui.w.document.querySelector('[data-agent-mode="connect"]').click();
  await until(() => ui.$("pairAvailability").textContent === "Привязан");
  assert.equal(ui.$("pairFieldLabel").textContent, "Состояние привязки");
  assert.equal(ui.$("pairedSummary").hidden, false);
  assert.equal(ui.$("pairedSummary").value, "UDMC Main · Minecraft 26.2 · fabric");
  // Nothing left to type or press: the code is spent.
  assert.equal(ui.$("pairEntry").hidden, true);
  assert.equal(ui.$("pairRconButton").hidden, true);
  assert.equal(ui.$("pairRestoreButton").disabled, true);
});

test("a command that changes the server names who else is in the panel", async t => {
  const ui = await createAdmin(t, { fetch: ({ url }) => {
    if (url.pathname === "/admin/status") {
      return response({ state: "online", agentProtocol: 1, capabilities: {},
        workspace: { revision: "r1", online: [{ deviceId: "other", name: "Вася", mine: false }] } });
    }
    // The draft carries the workspace revision the status announces, or every write would be
    // refused as stale before it reached the guard.
    if (url.pathname === "/admin/files") {
      return response({ revision: "rev-1", draft: null, files: [], workspaceRevision: "r1",
        changes: { added: 0, updated: 0, removed: 0, total: 0, dirty: false } });
    }
    if (url.pathname === "/admin/server/command") return response({ output: "ok" });
  } });
  await until(() => ui.$("workspacePresenceText").textContent.includes("Вася"));
  const sent = () => ui.requests.filter(r => r.url.pathname === "/admin/server/command").length;

  // Asking the server something changes nothing, so it goes straight through.
  ui.input("commandInput", "list"); ui.submit("commandForm");
  await until(() => sent() === 1);
  assert.equal(ui.$("commandGuardDialog").open, false);

  // A command that changes the server stops to say who else is working on it.
  ui.input("commandInput", "stop"); ui.submit("commandForm");
  await until(() => ui.$("commandGuardDialog").open);
  assert.match(ui.$("commandGuardText").textContent, /Вася/);
  ui.$("commandGuardDialog").close();
  await until(() => !ui.$("commandGuardDialog").open);
  assert.equal(sent(), 1, "A cancelled warning must not send the command");

  ui.input("commandInput", "stop"); ui.submit("commandForm");
  await until(() => ui.$("commandGuardDialog").open);
  ui.submit("commandGuardForm");
  await until(() => sent() === 2);
});

test("agent update confirmations cannot survive a changed server release", async t => {
  let value = { protocol: 1, currentVersion: "0.3.0", signed: true, canUpdate: true, client: { version: "0.3.0", sequence: 1 },
    packId: "test", minecraftVersion: "26.2", loaderType: "fabric", loaderVersion: "0.19.3", downloadUrl: "https://agent.test/agents/download", update: { state: "idle" } };
  const ui = await createAdmin(t, { fetch: ({ url }) => {
    if (url.pathname === "/admin/status") return response({ state: "online", agentProtocol: 1, capabilities: {} });
    if (url.pathname === "/admin/agents") return response(value);
  } });
  await until(() => !ui.$("agentUpdateRestartButton").disabled);
  ui.click("agentUpdateRestartButton");
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
  // Each control still names itself — by the label of the field it sits in, by its own
  // accessible name, or by the words on it. The captions above piles of them are gone.
  for (const control of ui.w.document.querySelectorAll('[data-agent-panel="agents"] input, [data-agent-panel="agents"] button')) {
    const named = control.closest("label") || control.getAttribute("aria-label")
      || (control.id && ui.w.document.querySelector(`label[for="${control.id}"]`)) || control.textContent.trim();
    assert.ok(named, `Без подписи: ${control.id || control.outerHTML.slice(0, 60)}`);
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
  await until(() => ui.$("agentDownloadUrl").value.includes("/agents/download") && !ui.$("agentUpdateRestartButton").disabled);
  assert.equal(ui.requests.filter(r => r.url.pathname === "/admin/agents/client").length, 1);
  ui.click("refreshButton");
  await until(() => !ui.$("refreshButton").disabled);
  assert.equal(ui.requests.filter(r => r.url.pathname === "/admin/agents/client").length, 1);
  ui.click("agentUpdateRestartButton");
  assert.equal(ui.$("agentUpdateConfirmDialog").open, true);
  assert.equal(ui.requests.filter(r => r.url.pathname === "/admin/agents/update").length, 0);
  ui.submit("agentUpdateConfirmForm");
  await until(() => ui.$("agentUpdateState").textContent.includes("0.4.0"));
  assert.equal(ui.$("agentUpdateRestartButton").disabled, true);
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

test("the game version is chosen without a server and taken from one with it", async t => {
  // Nobody has answered which game this is yet, so the choice is the person's.
  const ui = await createAdmin(t, { connected: false });
  assert.equal(ui.$("generatorMinecraft").disabled, false);
  ui.input("generatorMinecraft", "1.21.1");
  assert.equal(ui.$("generatorLoaderVersion").value, "0.19.3");
  assert.equal(ui.$("generatorLoaderVersion").disabled, true, "The loader version is derived, never picked");
  assert.ok(ui.$("generatorJava").textContent.includes("21"));
  assert.equal(ui.saved()["udmc-generator-settings"], JSON.stringify({ generatorLoader: "fabric", generatorMinecraft: "1.21.1" }));

  // A connected server has answered it: the file follows the server, and there is nothing to pick.
  const connected = await createAdmin(t, { storage: ui.saved() });
  await until(() => connected.$("generatorMinecraft").disabled === true);
  assert.equal(connected.$("generatorMinecraft").value, "26.2");
  assert.equal(connected.$("generatorLoader").disabled, true);
  assert.equal(connected.w.document.querySelector('[data-edit-setting="platform"]'), null,
    "There is no editor for a version the server dictates");
});

test("NeoForge selection survives restart and generates the correct template for the same Minecraft version", async t => {
  const ui = await createAdmin(t, { connected: false });
  ui.input("generatorLoader", "neoforge");
  assert.equal(ui.$("generatorMinecraft").value, "1.21.1");
  assert.equal(ui.$("generatorMinecraft").options.length, 1);
  assert.equal(ui.$("generatorLoaderVersion").value, "21.1.248");
  assert.equal(ui.$("generatorLoader").value, "neoforge");
  assert.equal(ui.$("generatorLoaderVersion").value, "21.1.248");
  const reopened = await createAdmin(t, { connected: false, storage: ui.saved(), native: name => name === "save_agent" ? null : undefined });
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
  reopened.input("generatorLoader", "fabric");
  assert.equal(reopened.$("generatorMinecraft").value, "1.21.1");
  assert.equal(reopened.$("generatorLoaderVersion").value, "0.19.3");
});

test("old Fabric settings without a loader remain Fabric", async t => {
  // Unconnected: what was stored is what is offered, since no server has said otherwise.
  const ui = await createAdmin(t, { connected: false, storage: { "udmc-generator-settings": JSON.stringify({ generatorMinecraft: "1.21.1" }) } });
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
  ui.edit("rcon");
  ui.input("edit-rconPasswordInput", "  exact password  ");
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
  ui.edit("rcon"); ui.input("edit-rconPasswordInput", " secret ");
  ui.submit("protectedSettingsForm"); await until(() => !ui.$("protectedSettingsDialog").open);
  ui.click("rconConnectionStatus");
  await until(() => ui.$("rconConsoleStatus").textContent === "Проверка RCON...");
  assert.equal(ui.$("rconSidebarStatus").textContent, "RCON: проверка rcon...");
  gate.resolve("Players: Alex");
  await until(() => ui.$("rconConsoleStatus").textContent === "Доступен");
  assert.equal(ui.$("rconConnectionStatus").textContent, "Доступен");
  assert.equal(ui.invocations.find(c => c.name === "rcon_execute").args.password, " secret ");
  assert.ok(ui.$("consoleOutput").textContent.includes("Players: Alex"));
  fail = true; ui.click("rconConnectionStatus");
  // The chip names what the console answered, not the general shape of the failure.
  await until(() => ui.$("rconConsoleStatus").textContent === "Неверный пароль");
  assert.equal(ui.$("rconConnectionStatus").dataset.hint, "Сервер отклонил пароль RCON.");
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
        // The running server carries a warning: said, counted apart, never a refusal.
        : response({ revision: "rev-1", ok: true, checkedAt: "2026-08-30T10:00:00Z",
          issues: [{ side: "server", level: "warning", code: "udmc_sync.diagnostic.not_delivered_namespace", args: ["orphan", "2"], message: "orphan" }] });
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
  assert.ok(rows.some(row => row.classList.contains("warn") && /Совместимость на сервере: 1 предупреждение/.test(row.textContent)),
    "A warning on the server is its own row, and not an error");
  assert.ok(!rows.some(row => row.classList.contains("error") && /Совместимость на сервере/.test(row.textContent)),
    "A warning must never be counted as a problem that refuses publication");
  assert.ok(!rows.some(row => row.classList.contains("ok")), "The all-good row must not show next to problems");
  rows.find(row => row.classList.contains("error")).click();
  assert.equal(ui.$("overviewView").classList.contains("active"), true);
  assert.equal(ui.w.document.querySelector('[data-build-tab="validation"]').getAttribute("aria-selected"), "true");
  assert.equal(ui.$("validationTarget").value, "draft");
  await until(() => ui.$("validationResult").querySelector(".validation-issue"));
  assert.equal(ui.$("validationResult").querySelector(".state-badge.warning"), null, "The draft's problem is not a warning");
  ui.$("validationTarget").value = "server"; ui.$("validationTarget").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
  await until(() => ui.$("validationResult").querySelector(".state-badge.warning"), "The server's warning wears its own badge");
  assert.match(ui.$("validationResult").textContent, /Проблем нет, предупреждений: 1/);
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
  await until(() => blocked.$("agentUpdateRestartButton").disabled === false);
  // Without power rights the one button only prepares the replacement, and says which it is:
  // a server the panel cannot restart still has to be updatable.
  assert.equal(blocked.$("agentUpdateLabel").textContent, "Обновить агенты");
  assert.match(blocked.$("agentUpdateRestartButton").title, /Перезапуск из панели этому серверу недоступен/);
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
  assert.match(ui.$("agentDeliveryStatus").textContent, /новых версий нет/);
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
