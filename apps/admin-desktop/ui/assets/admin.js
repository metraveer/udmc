import { t, getLocale, countText, translateDocument, initLanguage } from "./i18n.js";
import { initialFileSettings, inspectFile } from "./file-intake.js";
import { initGenerator } from "./generator-ui.js";
import { initServerTools } from "./server-tools.js";
import { normalizeAddress } from "./connection.js";
import { initCatalog } from "./catalog-ui.js";
import { initTranslator } from "./translate.js";
import { initAppUpdates } from "./app-updates.js";
import { initAccess } from "./access-ui.js";
import { initPairing } from "./pairing-ui.js";
import { initProtectedSettings } from "./protected-settings.js";
import { agentJson, formatAgentError, formatAppError, UPLOAD_TIMEOUT } from "./http.js";
import { createWorkspaceAccess } from "./workspace-access.js";
import { modSidePolicy } from "./modrinth.js";
import { initAgentUpdates } from "./agent-updates-ui.js";
import { profileStorage as localStorage, profileInvoke, initServerProfiles, serverProfiles } from "./server-profiles.js";
import { createProfileSession } from "./profile-session.js";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3077/";
const DEFAULT_RCON_PORT = 25575;
const STORAGE_KEYS = {
  serverUrl: "udmc-control-server-url",
  token: "udmc-control-token",
  rconEnabled: "udmc-control-rcon-enabled",
  rconHost: "udmc-control-rcon-host",
  rconPort: "udmc-control-rcon-port",
  rconRemember: "udmc-control-rcon-remember",
  rconPassword: "udmc-control-rcon-password"
};

// The heading of each page. There used to be a second line above it naming the same page in
// other words; two names for one screen only made the reader check whether they differed.
const viewDetails = {
  dashboard: t("Сервер"),
  overview: t("Сборка"),
  modrinth: t("Каталог модов"),
  console: t("Консоль"),
  generator: t("Настройка сервера"),
  devices: t("Устройства"),
  dependencies: t("Компоненты"),
  activity: t("Журнал"),
  settings: t("Настройки")
};

const elements = Object.fromEntries([
  "statusBadge", "statusDot", "serverLabel", "serverUrlInput", "tokenInput", "tokenVisibilityButton",
  "connectionForm", "rconForm", "rconEnabledInput",
  "rconHostInput", "rconPortInput", "rconPasswordInput", "rememberRconPasswordInput", "rconFields",
  "testRconButton", "rconDetectedBadge", "publishDialog", "publishForm", "publishOpenButton",
  "publishButtonLabel", "publishVersionInput", "publishChangeSummary", "publishRestartNote",
  "deleteDialog", "deleteForm", "deleteFileName", "deleteDialogText", "fileInput", "dropZone", "dropTitle",
  "dropSubtitle", "selectedFiles", "selectedFilesTitle", "stagedFileList", "stagedValidation", "bulkRootInput",
  "bulkSideInput", "clearSelectedButton", "uploadButton", "refreshButton", "clearLogButton", "draftBar",
  "draftStatusTitle", "draftStatusText", "draftChangeCounts", "resetDraftButton", "resetDraftDialog", "resetDraftForm",
  "filesTable", "fileSearchInput", "fileSideFilter", "visibleFileCount", "logOutput", "activityCount",
  "viewTitle", "toastRegion", "packNameHeading",
  "broadcastForm", "broadcastInput", "broadcastButton", "serverReplyCommand", "serverReplyText",
  "serverState", "serverPlayers", "serverTps", "serverUptime", "liveBadge", "serverMotd", "serverGamePort",
  "serverEnvironment", "serverWorlds", "serverTickTime", "serverJava", "serverMemoryText", "serverMemoryBar",
  "playerCountBadge", "playerList", "playerFilter", "playerListMore", "playersSummary", "playersPopover",
  "packSummary", "packPopover", "serverPackName",
  "restartServerButton", "stopServerButton", "commandTransportLabel",
  "clearConsoleButton", "consoleOutput", "commandForm", "commandInput", "commandSubmitButton", "powerDialog",
  "powerForm", "powerDialogTitle", "powerDialogText", "powerConfirmButton"
].map((id) => [id, document.querySelector(`#${id}`)]));
elements.uploadButtonLabel = document.querySelector("#uploadButton span");

let selectedFiles = [];
let playerNames = [];
/**
 * The dropdowns in the summary strip. Both hang from the number they belong to.
 */
const SUMMARY_POPOVERS = [
  { trigger: "playersSummary", panel: "playersPopover", focus: "playerFilter" },
  { trigger: "packSummary", panel: "packPopover" },
];
let manifest = null;
let draftState = null;
let buildBusy = false;
let serverStatus = null;
let connectionRevision = 0;
let knownConnection = null;
let sideFilter = "all";
let deleteTarget = null;
let powerAction = null;
const profileSession = createProfileSession(window.sessionStorage, serverProfiles.active());
const rememberedUi = profileSession.read();
let activityEntries = rememberedUi.activity;
let consoleEntries = rememberedUi.console;
let rconState = { status: "idle", checkedAt: null, message: "" };
let accessUi = null;
let pairingUi = null;
let modrinthUi = null;
let accessRole = null;
let accessIdentityId = null;
let activeView = "dashboard";
let buildTab = "draft";
let refreshRunning = false;
let refreshQueued = false;
let packNameDirty = rememberedUi.packNameDirty;
let profileNameDirty = rememberedUi.profileNameDirty;
let publishRevision = null;
let publishConnectionRevision = -1;
let protectedSettings = null;
let serverTools = null;
let agentUpdates = null;
let validationSnapshot = { supported: false, draft: null, server: null };
let agentUpdateSnapshot = { canUpdate: false, pending: false, failed: false, version: null };
let powerWatch = null; // { action, since, lastUptime, sawDown } - a requested power action being executed
let lastKnownPower = null;
const tableSelection = new Map(); // path -> file rows picked in the pack table for bulk removal
const workspaceAccess = createWorkspaceAccess({
  getBinding: () => connectionRevision,
  request: (path, options = {}, timeout) => agentJson(apiUrl(path), {
    ...options, headers: { ...adminHeaders(), ...options.headers }
  }, timeout),
  onConflict: () => {
    closeStaleBuildDialogs();
    refresh({ silent: true });
    renderWorkspaceAccess();
  }
});

translateDocument();
restoreConnection();
restoreRconSettings();
if (packNameDirty) {
  document.getElementById("packNameInput").value = rememberedUi.packName;
  togglePackRename(true);
}
elements.fileSearchInput.value = rememberedUi.fileSearch;
document.getElementById("commandSearch").value = rememberedUi.commandSearch;
sideFilter = rememberedUi.side;
elements.fileSideFilter.querySelectorAll("button").forEach(button => button.classList.toggle("active", button.dataset.sideFilter === sideFilter));
renderActivity(); renderConsole(); renderServerReply();
bindEvents();
initServerProfiles({ getBusy: () => buildBusy || protectedSettings?.isEditing() || rconState.status === "checking",
  hasLocalFiles: () => selectedFiles.length > 0, showToast, beforeReload: saveUiSession, openSettings: () => navigateTo("generator") });
// After the profile module fills the saved display name, an unsaved edit from this session wins.
if (profileNameDirty) document.getElementById("serverProfileName").value = rememberedUi.profileName;
initLanguage({ getBusy: () => buildBusy || protectedSettings?.isEditing() || rconState.status === "checking",
  hasLocalFiles: () => selectedFiles.length > 0, showToast, beforeReload: saveUiSession });
await restoreSecureCredentials();
async function adoptConnection(url, token, allowHttp) {
  connectionRevision++; powerWatch = null; lastKnownPower = null;
  workspaceAccess.reset();
  elements.serverUrlInput.value = url;
  elements.tokenInput.value = token;
  document.getElementById("allowHttpConnection").checked = allowHttp === true;
  packNameDirty = false;
  manifest = null; draftState = null; serverStatus = null;
  agentUpdates?.reset();
  resetManifest(); resetServerStatus(); renderFilteredFiles();
  setStatus(t("Ожидает подключения"), "warn");
  accessUi?.reset();
  await saveConnection();
  elements.serverUrlInput.dispatchEvent(new Event("change"));
}
const getConnection = () => ({ url: normalizedServerUrl(), token: elements.tokenInput.value.trim(), allowHttp: document.getElementById("allowHttpConnection").checked });
agentUpdates = initAgentUpdates({ getContext: () => serverStatus, getBinding: () => connectionRevision,
  getRevision: () => workspaceAccess.revision(),
  getBusy: () => buildBusy || protectedSettings?.isEditing(), setBusy: setBuildBusy,
  adminGet, adminJson, adminRaw, invoke: profileInvoke, showToast,
  getTemplates: () => generatorUi.templates(),
  onState: state => { agentUpdateSnapshot = state; renderDashboard(); },
  requestRestart: () => {
    // Players online get the announced delay preselected, an empty server restarts at once.
    document.getElementById("powerDelaySelect").value = (serverStatus?.players?.online || 0) > 0 ? "60" : "0";
    openPowerDialog("restart");
  } });
const generatorUi = initGenerator({ navigateTo, showToast,
  getBusy: () => buildBusy || protectedSettings?.isEditing(), setBusy: setBuildBusy,
  onFieldsChanged: () => protectedSettings?.syncLocks() });
pairingUi = initPairing({ getConnection, showToast, adminGet,
  isOwner: () => accessRole === "owner",
  addressChosen: () => Boolean(localStorage.getItem(STORAGE_KEYS.serverUrl) || localStorage.getItem("udm-admin-server-url")),
  getBusy: () => buildBusy || protectedSettings?.isEditing(), setBusy: setBuildBusy,
  // The server made the project and now hands over the key to it: adopt it like any connection.
  onPaired: async project => {
    const url = normalizedServerUrl();
    await adoptConnection(url, project.adminToken, document.getElementById("allowHttpConnection").checked);
    await refresh();
    // A server cannot work out its own public address, and players are told it by the server
    // when they join. This is the address that demonstrably reached it a moment ago.
    try { await adminJson("/admin/agents/settings", { serverUrl: url }); }
    catch (error) { showToast(formatAppError(error), "error"); }
  } });
accessUi = initAccess({ getConnection, setConnection: adoptConnection,
  replaceToken: async token => { elements.tokenInput.value = token; await saveConnection(); },
  getBusy: () => buildBusy || protectedSettings?.isEditing(), setBusy: setBuildBusy, navigateTo, showToast, refresh,
  onRole: identity => {
    accessRole = identity?.role || null;
    accessIdentityId = identity?.id || null;
    pairingUi?.syncOwner();
    document.getElementById("agentCreateTab").disabled = buildBusy;
    protectedSettings?.syncLocks();
  }
});
serverTools = initServerTools({ adminGet, adminJson, refresh: () => refresh({ silent: true }), showToast,
  getRevision: () => draftState?.revision,
  removeServerFile: file => openDeleteDialog({ ...file, change: "unchanged", unmanaged: true, side: "server" }),
  removeManagedFile: file => workspaceAccess.mutate(`/admin/files?path=${encodeURIComponent(file.path)}`, { method: "DELETE" }),
  getBinding: () => connectionRevision,
  getBusy: () => buildBusy, setBusy: setBuildBusy,
  insertCommand: (command) => { elements.commandInput.value = command; elements.commandInput.focus(); elements.commandForm.scrollIntoView({ block: "center" }); },
  onValidation: state => { validationSnapshot = state; renderDraftValidationChip(); renderDashboard(); },
  getDirty: () => Boolean(draftState?.changes?.dirty)
});
document.getElementById("dashOpenBuild").addEventListener("click", () => navigateTo("overview"));
document.getElementById("packRestartButton").addEventListener("click", () => { if (!buildBusy) openRestartWithDelay(); });
document.getElementById("filesBulkClear").addEventListener("click", () => { tableSelection.clear(); renderFilteredFiles(); });
document.getElementById("filesBulkRemove").addEventListener("click", () => {
  if (buildBusy || !tableSelection.size) return;
  serverTools.openBulkRemoval([...tableSelection.values()], "managed");
});
document.getElementById("draftValidationChip").addEventListener("click", () => {
  navigateTo("overview");
  serverTools.showValidation("draft");
  setBuildTab("validation");
});
modrinthUi = initCatalog({ initialProvider: rememberedUi.catalog, getContext: () => draftState && serverStatus ? {
  url: normalizedServerUrl(), projectId: draftState.draft.pack.id, minecraft: draftState.draft.minecraft.version,
  loader: draftState.draft.minecraft.loader.type, modValidation: serverStatus.capabilities?.modValidation === true,
  files: draftState.draft.files.map(({ path, side, sha256 }) => ({ path, side, sha256 }))
} : null, getBusy: () => buildBusy, setBusy: setBuildBusy, showToast,
  refresh: () => refresh({ silent: true }),
  upload: (file, side, source) => adminRaw(`/admin/files?path=${encodeURIComponent(`mods/${file.name}`)}`, file, { "content-type": "application/octet-stream", "x-udmc-side": side,
    ...(source ? { "x-udmc-source": JSON.stringify(source) } : {}) })
});
initTranslator({ showToast });
initAppUpdates({ showToast, getBusy: () => buildBusy });
navigateTo(rememberedUi.view);
setBuildTab(rememberedUi.tab);
if ((!elements.tokenInput.value && !rememberedUi.restored) || rememberedUi.settingsOpen) navigateTo("generator");
protectedSettings = initProtectedSettings({
  getBusy: () => buildBusy || rconState.status === "checking",
  getBinding: () => JSON.stringify([connectionRevision, elements.tokenInput.value]),
  getContext: () => ({ serverUrl: elements.serverUrlInput.value, templates: generatorUi.templates() }),
  canEdit: group => (group !== "platform" || (accessRole !== "admin" && generatorUi.templates().length > 0)),
  onApply: applyProtectedSettings, showToast
});
// A panel with no key has a server to claim, not a file to build: pairing is the way in.
setAgentMode("connect");
await accessUi.ready;
refresh();
window.setInterval(() => {
  if (manifest) refreshServerStatus(true);
  if (buildBusy) workspaceAccess.heartbeat().catch(() => {});
  renderRconStatus();
  accessUi.poll().catch(handleError);
}, 5000);

function bindEvents() {
  window.addEventListener("pagehide", saveUiSession);
  const buildTabs = document.getElementById("buildTabs");
  buildTabs.addEventListener("click", event => {
    const button = event.target.closest("[data-build-tab]");
    if (button) setBuildTab(button.dataset.buildTab);
  });
  buildTabs.addEventListener("keydown", event => {
    const buttons = [...buildTabs.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    setBuildTab(buttons[next].dataset.buildTab); buttons[next].focus();
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => navigateTo(button.dataset.view));
  });
  for (const entry of SUMMARY_POPOVERS) {
    elements[entry.trigger].addEventListener("click", () => toggleSummary(entry.trigger));
  }
  elements.playerFilter.addEventListener("input", () => renderPlayers(playerNames));
  // Anywhere outside them, or Escape: a panel that will not go away is worse than a card.
  document.addEventListener("click", event => {
    if (!event.target.closest(".summary-popover-host")) closeSummaries();
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeSummaries(); });
  const followAnchors = () => {
    for (const entry of SUMMARY_POPOVERS) {
      if (elements[entry.panel].hidden) continue;
      // Once the number it belongs to has scrolled away, the panel floats over unrelated
      // content and points at nothing. Follow the anchor while it is visible, close after.
      const anchor = elements[entry.trigger].getBoundingClientRect();
      if (anchor.bottom < 0 || anchor.top > window.innerHeight) toggleSummary(entry.trigger, false);
      else placePopover(entry);
    }
  };
  // Anchored to the viewport, so they have to follow when the viewport changes under them.
  window.addEventListener("resize", followAnchors);
  document.addEventListener("scroll", followAnchors, true);
  document.getElementById("openJoinButton").addEventListener("click", () => document.getElementById("joinDialog").showModal());
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => document.querySelector(`#${button.dataset.closeDialog}`).close());
  });
  document.querySelectorAll("[data-quick-command]").forEach((button) => {
    button.addEventListener("click", () => runQuickCommand(button));
  });

  document.querySelectorAll("[data-agent-mode]").forEach(button => button.addEventListener("click", () => setAgentMode(button.dataset.agentMode)));
  elements.connectionForm.addEventListener("submit", connectToServer);
  elements.serverUrlInput.addEventListener("input", () => {
    connectionRevision++; powerWatch = null; lastKnownPower = null;
    workspaceAccess.reset();
    document.getElementById("allowHttpConnection").checked = false;
    let url = null;
    try { url = normalizedServerUrl(); } catch { /* The address may be incomplete while typing. */ }
    elements.tokenInput.value = knownConnection?.url === url ? knownConnection.token : "";
    accessUi?.reset();
    packNameDirty = false;
    manifest = null; draftState = null; serverStatus = null;
    resetManifest(); resetServerStatus(); renderFilteredFiles();
    setStatus(t("Адрес изменён"), "warn");
    updateServerLabel();
  });
  elements.tokenInput.addEventListener("input", () => {
    connectionRevision++; powerWatch = null; lastKnownPower = null; accessUi?.reset();
    workspaceAccess.reset();
    manifest = null; draftState = null; serverStatus = null;
    packNameDirty = false;
    resetManifest(); resetServerStatus(); renderFilteredFiles();
    setStatus(t("Ключ изменён"), "warn");
  });
  elements.refreshButton.addEventListener("click", () => activeView === "devices" ? accessUi.onOpen() : activeView === "modrinth" ? modrinthUi.onOpen(true) : refresh());
  elements.clearLogButton.addEventListener("click", clearActivity);
  // The switch is the whole setting: it saves itself instead of waiting for a button.
  document.getElementById("packNameInput").addEventListener("input", () => { packNameDirty = true; });
  document.getElementById("packSettingsForm").addEventListener("submit", savePackName);
  document.getElementById("renamePackButton").addEventListener("click", () => togglePackRename(true));
  document.getElementById("cancelRenameButton").addEventListener("click", () => {
    const known = elements.packNameHeading.textContent;
    if (known && known !== "-") document.getElementById("packNameInput").value = known;
    packNameDirty = false;
    togglePackRename(false);
  });
  elements.broadcastForm.addEventListener("submit", broadcastToPlayers);
  document.getElementById("serverProfileName").addEventListener("input", () => { profileNameDirty = true; });
  document.getElementById("serverProfileForm").addEventListener("submit", () => { profileNameDirty = false; });
  elements.rconForm.addEventListener("submit", saveRconSettings);
  elements.rconEnabledInput.addEventListener("change", updateRconFields);
  [elements.rconHostInput, elements.rconPortInput, elements.rconPasswordInput].forEach((input) => input.addEventListener("input", () => {
    rconState = { status: "idle", checkedAt: null, message: t("Параметры изменены") };
    renderRconStatus();
  }));
  elements.testRconButton.addEventListener("click", testRcon);
  elements.publishOpenButton.addEventListener("click", openPublishDialog);
  elements.publishForm.addEventListener("submit", publishVersion);
  elements.deleteForm.addEventListener("submit", confirmDelete);
  elements.resetDraftButton.addEventListener("click", () => elements.resetDraftDialog.showModal());
  elements.resetDraftForm.addEventListener("submit", resetDraft);
  elements.uploadButton.addEventListener("click", uploadSelectedFiles);
  elements.fileInput.addEventListener("change", () => setSelectedFiles([...elements.fileInput.files], true));
  elements.clearSelectedButton.addEventListener("click", () => setSelectedFiles([]));
  elements.bulkRootInput.addEventListener("change", () => applyBulkSetting("root", elements.bulkRootInput));
  elements.bulkSideInput.addEventListener("change", () => applyBulkSetting("side", elements.bulkSideInput));
  elements.fileSearchInput.addEventListener("input", renderFilteredFiles);
  elements.tokenVisibilityButton.addEventListener("click", toggleTokenVisibility);
  elements.commandForm.addEventListener("submit", submitCommand);
  elements.clearConsoleButton.addEventListener("click", clearConsole);
  elements.restartServerButton.addEventListener("click", () => openPowerDialog("restart"));
  elements.stopServerButton.addEventListener("click", () => openPowerDialog("stop"));
  elements.powerForm.addEventListener("submit", confirmPowerAction);

  elements.fileSideFilter.addEventListener("click", (event) => {
    const button = event.target.closest("[data-side-filter]");
    if (!button) return;
    sideFilter = button.dataset.sideFilter;
    elements.fileSideFilter.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    renderFilteredFiles();
  });

  elements.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
  elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("dragging"));
  elements.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
    setSelectedFiles([...event.dataTransfer.files], true);
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
}

function setBuildTab(name) {
  if (!["draft", "published", "server", "validation"].includes(name)) return;
  buildTab = name;
  document.querySelectorAll("[data-build-tab]").forEach(button => {
    const selected = button.dataset.buildTab === name;
    button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll("[data-build-panel]").forEach(panel => { panel.hidden = !panel.dataset.buildPanel.split(" ").includes(name); });
  document.getElementById("filesHeadingTitle").textContent = name === "published" ? t("Файлы у игроков") : t("Изменения к публикации");
  if (name === "server" && draftState) serverTools?.ensureInventory();
  if (name === "validation") serverTools?.ensureValidation();
  renderFilteredFiles();
}

function navigateTo(viewName) {
  if (viewName === "generator") { document.getElementById("serverProfileDialog").showModal(); return; }
  document.getElementById("serverProfileDialog").close();
  activeView = viewName;
  elements.viewTitle.textContent = viewDetails[viewName] || viewDetails.dashboard;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
  document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === viewName));
  elements.publishOpenButton.hidden = viewName !== "overview";
  document.querySelector(".workspace").scrollTop = 0;
  if (viewName === "devices") accessUi?.onOpen();
  if (viewName === "modrinth") modrinthUi?.onOpen();
}

function setAgentMode(mode) {
  document.querySelectorAll("[data-agent-panel]").forEach(panel => { panel.hidden = panel.dataset.agentPanel !== mode; });
  // Whether this server still needs claiming is a question for the server, asked when the
  // panel that would claim it is on screen.
  if (mode === "connect") pairingUi?.show().catch(handleError);
  document.querySelectorAll("[data-agent-mode]").forEach(button => {
    const selected = button.dataset.agentMode === mode;
    button.classList.toggle("active", selected); button.setAttribute("aria-selected", String(selected));
  });
}

async function connectToServer(event) {
  event.preventDefault();
  if (buildBusy) return;
  try {
    await saveConnection();
    await refresh();
    if (manifest) navigateTo("dashboard");
  } catch (error) {
    handleError(error);
  }
}

async function refresh(options = {}) {
  if (refreshRunning) { refreshQueued = true; return; }
  refreshRunning = true;
  const silent = Boolean(options.silent);
  const revision = connectionRevision;
  setBusy(elements.refreshButton, true);

  try {
    updateServerLabel();
    if (!elements.tokenInput.value.trim()) {
      manifest = null; draftState = null; serverStatus = null;
      resetManifest(); resetServerStatus(); renderFilteredFiles();
      setStatus(t("Не подключено"), "warn");
      return;
    }
    if (!silent) setStatus(t("Подключение..."), "warn");
    const health = await requestJson("/health");
    if (revision !== connectionRevision) return;
    if (!health.ok) throw new Error(t("Сервер не подтвердил готовность."));
    await accessUi.ensureDevice(health.accessControl === true);
    if (revision !== connectionRevision) return;

    const result = await Promise.all([
      requestJson("/manifest"),
      adminGet("/admin/status"),
      adminGet("/admin/files")
    ]);
    if (revision !== connectionRevision) return;
    [manifest, serverStatus, draftState] = result;
    workspaceAccess.receive(serverStatus.workspace);
    workspaceAccess.acceptDraft(draftState.workspaceRevision);
    renderWorkspaceAccess();
    if (!draftState.draft || !draftState.changes) throw new Error(t("Обновите UDMC Agent на сервере: эта версия не поддерживает черновики."));
    serverTools.syncStatus(serverStatus, manifest);
    fillManifest(manifest);
    renderDraftState();
    renderFilteredFiles();
    updateDropZone();
    renderServerStatus(serverStatus);
    accessUi.receive(serverStatus.access);
    serverTools.refreshCommands();
    if (buildTab === "server") serverTools.ensureInventory();
    setStatus(t("Сервер доступен"), "ok");
    if (!silent) addActivity(t("Подключение установлено. Опубликованная версия сборки: {0}.", manifest.pack.version), "success");
    if (activeView === "devices") accessUi.onOpen();
    if (activeView === "modrinth") modrinthUi.onOpen();
    agentUpdates.connected();
  } catch (error) {
    if (revision !== connectionRevision) return;
    manifest = null;
    draftState = null;
    serverStatus = null;
    agentUpdates.reset();
    resetManifest();
    resetServerStatus();
    renderFilteredFiles();
    setStatus(t("Нет подключения"), "error");
    accessUi.reset();
    if (!silent) addActivity(formatAgentError(error), "error");
  } finally {
    setBusy(elements.refreshButton, buildBusy);
    refreshRunning = false;
    if (refreshQueued) { refreshQueued = false; refresh({ silent: true }); }
  }
}

async function refreshServerStatus(silent = false) {
  const revision = connectionRevision;
  try {
    const result = await adminGet("/admin/status");
    if (revision !== connectionRevision) return;
    serverStatus = result;
    if (powerWatch && ((powerWatch.sawDown && result.state === "online")
      || (powerWatch.lastUptime != null && result.uptimeSeconds != null && result.uptimeSeconds < powerWatch.lastUptime))) {
      powerWatch = null;
      addActivity(t("Сервер снова в сети после перезапуска."), "success");
      showToast(t("Сервер снова в сети"));
    }
    if (powerWatch && Date.now() - powerWatch.since > 10 * 60 * 1000) powerWatch = null;
    lastKnownPower = result.power ? { ...result.power, uptime: result.uptimeSeconds } : null;
    workspaceAccess.receive(result.workspace);
    renderWorkspaceAccess();
    if (workspaceAccess.changed() && !buildBusy) {
      closeStaleBuildDialogs();
      refresh({ silent: true });
    }
    renderServerStatus(serverStatus);
    serverTools.syncStatus(serverStatus, manifest);
    accessUi.receive(serverStatus.access);
    setStatus(t("Сервер доступен"), "ok");
    if (document.getElementById("serverProfileDialog").open) agentUpdates.refresh();
  } catch (error) {
    if (revision !== connectionRevision) return;
    // A dead status during a requested power action is the expected middle of the
    // process: keep a progress row instead of a plain "connection lost".
    if (!powerWatch && lastKnownPower && lastKnownPower.executeAt <= Date.now()) {
      powerWatch = { action: lastKnownPower.action, since: Date.now(), lastUptime: lastKnownPower.uptime ?? null };
      lastKnownPower = null;
    }
    if (powerWatch) powerWatch.sawDown = true;
    resetServerStatus();
    setStatus(t("Связь потеряна"), "error");
    if (error.status === 401 || error.status === 403) {
      workspaceAccess.reset(); renderWorkspaceAccess();
      manifest = null; draftState = null; serverStatus = null;
      resetManifest(); renderFilteredFiles(); accessUi.reset();
      document.getElementById("connectionIdentity").textContent = t("Доступ отклонён");
    }
    if (!silent) handleError(error);
  }
}

function showPackName(name) {
  elements.packNameHeading.textContent = name || "-";
  if (!packNameDirty) document.getElementById("packNameInput").value = name;
}

function togglePackRename(open) {
  document.getElementById("packTitleRow").hidden = open;
  document.getElementById("packSettingsForm").hidden = !open;
  if (open) document.getElementById("packNameInput").focus();
}

async function savePackName(event) {
  event.preventDefault();
  if (buildBusy) return;
  const name = document.getElementById("packNameInput").value.trim();
  if (!name) return;
  setBuildBusy(true);
  try {
    if (manifest) await adminJson("/admin/settings", { packName: name });
    packNameDirty = false;
    localStorage.setItem("udmc-pack-name", name);
    if (manifest) await refresh({ silent: true });
    showPackName(name);
    togglePackRename(false);
    showToast(manifest ? t("Название сборки сохранено") : t("Название сохранено для создания JAR"));
  } catch (error) { handleError(error); } finally { setBuildBusy(false); }
}

async function saveRconSettings(event) {
  event.preventDefault();
  protectedSettings?.open("rcon");
}

async function applyProtectedSettings(group, values) {
  let oldUrl = null;
  try { oldUrl = normalizedServerUrl(); } catch { /* Allow repairing a previously saved invalid address. */ }
  const oldHttp = document.getElementById("allowHttpConnection").checked;
  if (group === "connection") {
    const url = values.serverUrlInput;
    const token = oldUrl === url ? elements.tokenInput.value.trim() : knownConnection?.url === url ? knownConnection.token : "";
    await persistConnection({ url, token }, values.allowHttpConnection);
  } else if (group === "token") {
    await persistConnection({ url: normalizedServerUrl(), token: values.tokenInput }, oldHttp);
  } else if (group === "rcon") {
    if (window.__TAURI__?.core?.invoke) {
      const value = values.rememberRconPasswordInput ? JSON.stringify({ host: values.rconHostInput, port: Number(values.rconPortInput), password: values.rconPasswordInput }) : null;
      await profileInvoke("credential_write", { name: "rcon-password", value });
    }
    for (const [key, id] of [["rconEnabled", "rconEnabledInput"], ["rconHost", "rconHostInput"], ["rconPort", "rconPortInput"], ["rconRemember", "rememberRconPasswordInput"]]) localStorage.setItem(STORAGE_KEYS[key], String(values[id]));
    localStorage.removeItem(STORAGE_KEYS.rconPassword);
  } else {
    generatorUi.persistSettings(values);
  }
  for (const [id, value] of Object.entries(values)) {
    const field = document.getElementById(id);
    if (field.type === "checkbox") field.checked = value;
    else field.value = value;
  }
  if (group === "connection") {
    if (oldUrl !== values.serverUrlInput) {
      elements.serverUrlInput.dispatchEvent(new Event("input"));
      document.getElementById("allowHttpConnection").checked = values.allowHttpConnection;
    } else if (oldHttp !== values.allowHttpConnection) {
      connectionRevision++; powerWatch = null; lastKnownPower = null; accessUi?.reset();
      workspaceAccess.reset(); agentUpdates?.reset();
      manifest = null; draftState = null; serverStatus = null;
      packNameDirty = false;
      resetManifest(); resetServerStatus(); renderFilteredFiles();
      setStatus(t("Настройки подключения изменены"), "warn");
    }
    elements.serverUrlInput.dispatchEvent(new Event("change"));
    generatorUi.persistSettings();
    updateServerLabel();
  } else if (group === "token") elements.tokenInput.dispatchEvent(new Event("input"));
  else if (group === "platform") generatorUi.setPlatform(values);
  else if (group === "rcon") {
    rconState = { status: "idle", checkedAt: null, message: t("Параметры изменены") };
    updateRconFields(); addActivity(t("Настройки RCON сохранены."), "success");
  }
  if (["platform", "connection"].includes(group)) document.getElementById("generatorResult").hidden = true;
}

async function testRcon() {
  setBusy(elements.testRconButton, true);
  try {
    const output = await invokeRcon("list");
    addConsoleEntry("list", output, "RCON");
    addActivity(t("Подключение RCON проверено."), "success");
    showToast(t("RCON доступен"));
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(elements.testRconButton, false);
  }
}

async function submitCommand(event) {
  event.preventDefault();
  if (buildBusy) return;
  const command = elements.commandInput.value.trim();
  if (!command) return;
  elements.commandInput.value = "";
  await executeServerCommand(command, elements.commandSubmitButton);
  elements.commandInput.focus();
}

// Warning the players is what an administrator does right before the two buttons under this
// field, and until now it meant typing a command on the console page.
async function broadcastToPlayers(event) {
  event.preventDefault();
  const message = elements.broadcastInput.value.trim().replace(/\s+/g, " ");
  if (!message) return;
  const answered = await executeServerCommand(`say ${message}`, elements.broadcastButton);
  if (answered !== null) elements.broadcastInput.value = "";
}

async function runQuickCommand(button) {
  await executeServerCommand(button.dataset.quickCommand, button);
}

async function executeServerCommand(command, button) {
  if (buildBusy) return null;
  setBuildBusy(true);
  setBusy(button, true);
  try {
    let output;
    let transport;
    if (elements.rconEnabledInput.checked) {
      output = await invokeRcon(command);
      transport = "RCON";
    } else {
      const payload = await adminJson("/admin/server/command", { command });
      output = payload.output;
      transport = "UDMC Agent";
    }
    addConsoleEntry(command, output, transport);
    addActivity(t("Выполнена команда: {0}.", command), "success");
    showToast(t("Команда выполнена"));
    return output;
  } catch (error) {
    addConsoleEntry(command, formatAgentError(error), t("Ошибка"), true);
    handleError(error);
    return null;
  } finally {
    setBuildBusy(false);
    setBusy(button, false);
  }
}

async function invokeRcon(command) {
  const snapshot = [elements.rconHostInput.value, elements.rconPortInput.value, elements.rconPasswordInput.value].join("\n");
  const unchanged = () => snapshot === [elements.rconHostInput.value, elements.rconPortInput.value, elements.rconPasswordInput.value].join("\n");
  rconState = { status: "checking", checkedAt: null, message: "" };
  renderRconStatus();
  try {
  const port = Number(elements.rconPortInput.value);
  validateRconFields(port);
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error(t("RCON доступен только в установленном приложении UDMC Control."));

  const output = await invoke("rcon_execute", {
    host: elements.rconHostInput.value.trim(),
    port,
    password: elements.rconPasswordInput.value,
    command
  });
  if (unchanged()) rconState = { status: "online", checkedAt: Date.now(), message: t("Авторизация подтверждена") };
  return output;
  } catch (error) {
    const message = formatAgentError(error);
    if (unchanged()) rconState = { status: "error", checkedAt: Date.now(), message };
    throw new Error(message);
  } finally { renderRconStatus(); }
}

function renderRconStatus() {
  const enabled = elements.rconEnabledInput.checked;
  const stale = rconState.checkedAt && Date.now() - rconState.checkedAt > 60000;
  const label = !enabled ? t("Отключён в панели") : rconState.status === "checking" ? t("Проверка RCON...")
    : rconState.status === "online" ? stale ? t("Проверка устарела") : t("Доступен") : rconState.status === "error" ? t("Нет доступа") : t("Доступ не проверен");
  const status = !enabled || stale ? "neutral" : rconState.status;
  for (const id of ["rconConnectionStatus", "rconConsoleStatus"]) {
    const badge = document.getElementById(id);
    badge.textContent = label;
    badge.className = `state-badge ${status}`;
    badge.title = rconState.message;
  }
  document.getElementById("rconConsoleStatus").hidden = !enabled;
  document.getElementById("rconCoordinationWarning").hidden = !enabled;
  const sidebar = document.getElementById("rconSidebarStatus");
  sidebar.textContent = `RCON: ${label.toLowerCase()}`;
  sidebar.className = `sidebar-rcon ${status}`;
  document.getElementById("rconCheckedAt").textContent = rconState.checkedAt ? t("Проверено {0}", new Date(rconState.checkedAt).toLocaleTimeString(getLocale())) : "";
  protectedSettings?.syncLocks();
  agentUpdates?.render();
}

function validateRconFields(port) {
  const host = elements.rconHostInput.value.trim();
  if (!host || host.includes("://") || /[\\/\s]/.test(host)) throw new Error(t("Укажите домен или IP RCON без протокола и порта."));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t("Порт RCON должен быть от 1 до 65535."));
  if (!elements.rconPasswordInput.value) throw new Error(t("Введите пароль RCON."));
}

function openPowerDialog(action) {
  if (!serverStatus?.capabilities?.powerActions) {
    showToast(t("Разрешите остановку и перезапуск на странице сервера"), "error");
    navigateTo("dashboard");
    return;
  }

  powerAction = action;
  const restarting = action === "restart";
  elements.powerDialogTitle.textContent = restarting ? t("Перезапустить сервер") : t("Остановить сервер");
  elements.powerDialogText.textContent = restarting
    ? t("Мир будет сохранён. Повторный запуск выполнит UDMC wrapper или панель хостинга.")
    : t("Мир будет сохранён, после чего Minecraft-сервер завершит работу.");
  elements.powerConfirmButton.textContent = restarting ? t("Перезапустить") : t("Остановить");
  elements.powerConfirmButton.className = restarting ? "button warning" : "button danger-solid";
  elements.powerDialog.showModal();
}

async function confirmPowerAction(event) {
  event.preventDefault();
  if (!powerAction) return;
  const action = powerAction;
  const delay = Number(document.getElementById("powerDelaySelect").value) || 0;
  setBusy(elements.powerConfirmButton, true);

  try {
    await adminJson(`/admin/server/${action}`, { delaySeconds: delay });
    elements.powerDialog.close();
    if (delay > 0) {
      addActivity(t("Запланировано: {0} через {1} с предупреждением игроков в чате.", action === "restart" ? t("перезапуск сервера") : t("остановка сервера"), countText("seconds", delay)), "success");
      showToast(t("Запланировано. Отменить можно на странице «Сервер»."));
    } else {
      powerWatch = { action, since: Date.now(), lastUptime: serverStatus?.uptimeSeconds ?? null };
      setStatus(action === "restart" ? t("Перезапуск...") : t("Остановка..."), "warn");
      addActivity(action === "restart" ? t("Запрошен перезапуск сервера.") : t("Запрошена остановка сервера."), "success");
      showToast(action === "restart" ? t("Сервер перезапускается") : t("Сервер останавливается"));
    }
    powerAction = null;
    refreshServerStatus(true);
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(elements.powerConfirmButton, false);
  }
}

async function cancelScheduledPower(action) {
  try {
    await adminJson(`/admin/server/${action}`, { cancel: true });
    addActivity(t("Запланированное действие сервера отменено."), "success");
    showToast(t("Отменено"));
    refreshServerStatus(true);
  } catch (error) {
    handleError(error);
  }
}

function openPublishDialog() {
  if (buildBusy) return;
  if (selectedFiles.length) {
    showToast(t("Сначала добавьте выбранные файлы в черновик или очистите выбор"), "error");
    return;
  }
  if (!manifest || !draftState) {
    showToast(t("Сначала подключитесь к серверу"), "error");
    navigateTo("generator");
    return;
  }
  if (!draftState.changes?.dirty) {
    showToast(t("В черновике нет изменений"), "error");
    return;
  }
  elements.publishVersionInput.value = bumpPatchVersion(manifest.pack.version);
  publishRevision = draftState.revision;
  publishConnectionRevision = connectionRevision;
  elements.publishChangeSummary.textContent = formatChangeSummary(draftState.changes);
  elements.publishRestartNote.hidden = !draftState.changes.serverRestartRecommended;
  const removedMods = draftState.files.some((file) => file.change === "removed" && file.path.startsWith("mods/"));
  elements.publishRestartNote.textContent = [
    draftState.changes.serverRestartRecommended ? t("После публикации перезапустите Minecraft-сервер.") : "",
    removedMods ? t("Удаление модов может нарушить зависимости и повредить содержимое мира. Сделайте резервную копию мира.") : ""
  ].filter(Boolean).join(" ");
  elements.publishRestartNote.hidden = !draftState.changes.serverRestartRecommended && !removedMods;
  // Publish-and-restart needs remote power actions; without them the reason is on the button.
  const restartButton = document.getElementById("publishRestartButton");
  restartButton.disabled = !canRestartFromPanel();
  restartButton.title = canRestartFromPanel()
    ? t("Опубликует сборку и сразу предложит перезапуск с предупреждением игроков.")
    : t("Остановка и перезапуск из панели выключены. Включите их на странице «Сервер» в блоке «Действия сервера».");
  elements.publishDialog.showModal();
  elements.publishVersionInput.select();
}

async function publishVersion(event) {
  event.preventDefault();
  if (buildBusy) return;
  if (publishConnectionRevision !== connectionRevision) {
    elements.publishDialog.close(); showToast(t("Подключение изменилось. Проверьте сборку заново."), "error"); return;
  }
  const submitButton = event.submitter;
  const withRestart = submitButton?.id === "publishRestartButton";
  const version = elements.publishVersionInput.value.trim();
  setBusy(submitButton, true);
  setBuildBusy(true);
  try {
    const needsServerRestart = draftState?.changes?.serverRestartRecommended === true;
    const payload = await adminJson("/admin/publish", { version, expectedRevision: publishRevision });
    elements.publishDialog.close();
    addActivity(t("Опубликована версия {0}.", payload.pack.version), "success");
    showToast(needsServerRestart && !withRestart
      ? t("Версия {0} опубликована. Изменения на сервере вступят в силу после перезапуска - см. страницу «Сервер».", payload.pack.version)
      : t("Версия {0} опубликована", payload.pack.version));
    await refresh({ silent: true });
    // The restart is offered only after the publication really succeeded.
    if (withRestart) openRestartWithDelay();
  } catch (error) {
    if (error.status === 409) { elements.publishDialog.close(); await refresh({ silent: true }); }
    handleError(error);
  } finally {
    setBusy(submitButton, false);
    setBuildBusy(false);
  }
}

async function uploadSelectedFiles() {
  if (buildBusy || !draftState) return;
  if (!selectedFiles.length) {
    showToast(t("Выберите файлы для загрузки"), "error");
    return;
  }
  const validation = validateSelectedFiles();
  if (validation.error) {
    showToast(validation.message, "error");
    return;
  }
  setBuildBusy(true);
  setStatus(t("Добавление в черновик..."), "warn");
  const uploadedIds = [];

  try {
    for (let index = 0; index < selectedFiles.length; index += 1) {
      const item = selectedFiles[index];
      const remotePath = `${item.root}${cleanFileName(item.file.name)}`;
      elements.uploadButtonLabel.textContent = `${index + 1} / ${selectedFiles.length}`;
      const payload = await adminRaw(`/admin/files?path=${encodeURIComponent(remotePath)}`, item.file, {
        "content-type": "application/octet-stream",
        "x-udmc-side": item.side
      });
      uploadedIds.push(item.id);
      addActivity(t("Добавлен в черновик {0}.", payload.file.path), "success");
    }
    const uploadedCount = selectedFiles.length;
    selectedFiles = selectedFiles.filter((item) => !uploadedIds.includes(item.id));
    elements.fileInput.value = "";
    updateDropZone();
    showToast(t("Добавлено в черновик: {0}", uploadedCount));
  } catch (error) {
    selectedFiles = selectedFiles.filter((item) => !uploadedIds.includes(item.id));
    updateDropZone();
    handleError(error);
  } finally {
    if (uploadedIds.length) await refresh({ silent: true });
    elements.uploadButtonLabel.textContent = t("Добавить в черновик");
    setBuildBusy(false);
  }
}

function openDeleteDialog(file) {
  deleteTarget = file;
  elements.deleteFileName.textContent = file.path;
  elements.deleteDialogText.textContent = file.change === "added"
    ? t("Файл ещё не публиковался и будет просто убран из черновика.")
    : t("Удаление попадёт в черновик. Сервер и клиенты применят его только после публикации.");
  if (file.unmanaged) elements.deleteDialogText.textContent = t("Удалится только этот файл на сервере, после публикации черновика. Перед удалением UDMC проверит его содержимое и сохранит резервную копию. Личные файлы игроков не затрагиваются.");
  if (file.change !== "added" && file.path.startsWith("mods/")) elements.deleteDialogText.textContent += t(" Другие моды или мир могут зависеть от него. Перед публикацией сохраните резервную копию мира.");
  elements.deleteDialog.showModal();
}

async function confirmDelete(event) {
  event.preventDefault();
  if (buildBusy) return;
  if (!deleteTarget) return elements.deleteDialog.close();
  const submitButton = event.submitter;
  setBusy(submitButton, true);
  setBuildBusy(true);
  try {
    if (deleteTarget.unmanaged) await adminJson("/admin/server/files/remove", { path: deleteTarget.path, sha256: deleteTarget.sha256 });
    else await workspaceAccess.mutate(`/admin/files?path=${encodeURIComponent(deleteTarget.path)}`, { method: "DELETE" });
    addActivity(t("Удаление {0} добавлено в черновик.", deleteTarget.path), "success");
    showToast(deleteTarget.change === "added" ? t("Файл убран из черновика") : t("Удаление подготовлено"));
    deleteTarget = null;
    elements.deleteDialog.close();
    serverTools.resetInventory();
    await refresh({ silent: true });
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(submitButton, false);
    setBuildBusy(false);
  }
}

async function detachDraftFile(file) {
  if (buildBusy) return;
  setBuildBusy(true);
  try {
    await adminJson("/admin/files/detach", { path: file.path });
    addActivity(t("{0} выводится из сборки без удаления.", file.path), "success");
    showToast(t("Файл выйдет из сборки при публикации и останется на сервере"));
    await refresh({ silent: true });
  } catch (error) {
    handleError(error);
  } finally {
    setBuildBusy(false);
  }
}

async function revertDraftFile(file) {
  if (buildBusy) return;
  setBuildBusy(true);
  try {
    await adminJson("/admin/files/revert", { path: file.path });
    addActivity(t("Отменено изменение {0}.", file.path), "success");
    showToast(t("Изменение отменено"));
    await refresh({ silent: true });
  } catch (error) {
    handleError(error);
  } finally {
    setBuildBusy(false);
  }
}

async function updateDraftFile(file, nextRoot, nextSide) {
  if (buildBusy) return;
  setBuildBusy(true);
  const relativePath = file.path.slice(managedRoot(file.path).length);
  const newPath = `${nextRoot}${relativePath}`;
  try {
    await adminJson("/admin/files/update", { path: file.path, newPath, side: nextSide });
    addActivity(t("Изменены параметры {0}.", file.path), "success");
    await refresh({ silent: true });
  } catch (error) {
    handleError(error);
    await refresh({ silent: true });
  } finally {
    setBuildBusy(false);
  }
}

async function resetDraft(event) {
  event.preventDefault();
  if (buildBusy) return;
  const submitButton = event.submitter;
  setBusy(submitButton, true);
  setBuildBusy(true);
  try {
    await adminJson("/admin/draft/reset", {});
    elements.resetDraftDialog.close();
    addActivity(t("Все изменения черновика отменены."), "success");
    showToast(t("Черновик сброшен"));
    await refresh({ silent: true });
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(submitButton, false);
    setBuildBusy(false);
  }
}

function fillManifest(nextManifest) {
  showPackName(nextManifest.pack.name || "");
  document.querySelector("#currentVersion").textContent = nextManifest.pack.version || "-";
  const draft = draftState?.draft || nextManifest;
  document.querySelector("#currentFileCount").textContent = String((draft.files || []).length);
  document.querySelector("#currentTotalSize").textContent = formatBytes((draft.files || []).reduce((total, file) => total + Number(file.size || 0), 0));
  document.querySelector("#currentPlatform").textContent = [
    `Minecraft ${nextManifest.minecraft.version}`,
    capitalize(nextManifest.minecraft.loader.type),
    nextManifest.minecraft.loader.version
  ].filter(Boolean).join(" · ");
}

function renderDraftState() {
  serverTools?.receiveRevision(draftState?.revision);
  const changes = draftState?.changes || { added: 0, updated: 0, removed: 0, total: 0, dirty: false };
  elements.draftBar.classList.toggle("clean", !changes.dirty);
  elements.draftStatusTitle.textContent = changes.dirty
    ? t("Черновик: {0}", pluralizeChanges(changes.total))
    : t("Черновик совпадает с опубликованной сборкой");
  elements.draftStatusText.textContent = changes.dirty
    ? t("Сервер и клиенты ещё используют опубликованную версию")
    : t("Игроки используют актуальную версию");
  if (!draftState) {
    elements.draftStatusTitle.textContent = t("Черновик недоступен");
    elements.draftStatusText.textContent = t("Нет подключения к серверу");
  }
  elements.draftChangeCounts.hidden = !changes.dirty;
  elements.resetDraftButton.hidden = !changes.dirty;
  updatePublishAvailability();
  elements.publishButtonLabel.textContent = changes.dirty ? t("Опубликовать · {0}", changes.total) : t("Опубликовать");
  elements.draftChangeCounts.replaceChildren();
  if (changes.dirty) {
    [
      [changes.added, t("добавлено")],
      [changes.updated, t("изменено")],
      [changes.removed, t("удаляется")]
    ].filter(([count]) => count > 0).forEach(([count, label]) => {
      const item = document.createElement("span");
      item.textContent = `${count} ${label}`;
      elements.draftChangeCounts.append(item);
    });
  }
  if (manifest) fillManifest(manifest);
  renderDraftValidationChip();
  renderPackRestartNotice();
  renderDashboard();
}

function renderServerStatus(status) {
  document.getElementById("manifestSecurityStatus").textContent = status.security?.signedManifest ? t("Ed25519 включена") : t("Без подписи");
  document.getElementById("apiTransportStatus").textContent = new URL(normalizedServerUrl()).protocol === "https:" ? t("HTTPS, шифрование") : t("HTTP, без шифрования");
  const players = status.players || { online: 0, max: 0, names: [] };
  const performance = status.performance || {};
  const stateLabels = { online: t("Работает"), starting: t("Запускается"), stopping: t("Останавливается") };
  const state = stateLabels[status.state] || t("Неизвестно");
  elements.serverState.textContent = state;
  elements.serverPlayers.textContent = `${players.online || 0} / ${players.max || 0}`;
  elements.serverTps.textContent = Number(performance.tps || 0).toFixed(1);
  elements.serverUptime.textContent = formatUptime(status.uptimeSeconds);
  elements.liveBadge.textContent = state;
  elements.liveBadge.className = `state-badge ${status.state === "online" ? "online" : "warning"}`;
  elements.serverMotd.textContent = status.motd || "-";
  elements.serverGamePort.textContent = status.gamePort || "-";
  // A server that has not reported its loader yet used to leave a separator hanging: "Minecraft - ·".
  elements.serverEnvironment.textContent = [`Minecraft ${status.minecraftVersion || "-"}`,
    [capitalize(status.loader?.type), status.loader?.version].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  elements.serverWorlds.textContent = String(status.worlds ?? "-");
  elements.serverTickTime.textContent = t("{0} мс", Number(performance.averageTickMs || 0).toFixed(2));
  elements.serverJava.textContent = status.javaVersion || "-";
  elements.serverMemoryText.textContent = `${formatBytes(performance.memoryUsedBytes)} / ${formatBytes(performance.memoryMaxBytes)}`;
  const memoryRatio = Number(performance.memoryMaxBytes) > 0 ? Number(performance.memoryUsedBytes) / Number(performance.memoryMaxBytes) : 0;
  elements.serverMemoryBar.style.width = `${Math.min(100, Math.max(0, memoryRatio * 100))}%`;
  elements.playerCountBadge.textContent = `${players.online || 0} / ${players.max || 0}`;
  elements.playersSummary.disabled = !(players.names || []).length;
  if (elements.playersSummary.disabled) togglePlayers(false);
  renderPlayers(players.names || []);

  // A dedicated server can always be stopped and restarted; an integrated one cannot. The
  // check is about what the runtime can do, and every such action asks for confirmation.
  const powerEnabled = Boolean(status.capabilities?.powerActions);
  elements.restartServerButton.disabled = buildBusy || !powerEnabled;
  elements.stopServerButton.disabled = buildBusy || !powerEnabled;
  elements.restartServerButton.title = powerEnabled ? t("Перезапустить сервер") : t("Этот сервер нельзя перезапустить из панели");
  elements.stopServerButton.title = powerEnabled ? t("Остановить сервер") : t("Этот сервер нельзя остановить из панели");
  renderPackRestartNotice();
  renderDashboard();

  const rconEnabled = Boolean(status.rcon?.enabled);
  elements.rconDetectedBadge.textContent = rconEnabled ? t("На сервере включён · {0}", status.rcon.port) : t("На сервере выключен");
  elements.rconDetectedBadge.className = `state-badge ${rconEnabled ? "online" : "neutral"}`;
  if (!localStorage.getItem(STORAGE_KEYS.rconPort) && status.rcon?.port) elements.rconPortInput.value = String(status.rcon.port);
  if (!elements.rconHostInput.value) elements.rconHostInput.value = inferredRconHost();
}

function resetManifest() {
  ["currentVersion", "currentFileCount", "currentTotalSize", "currentPlatform"].forEach((id) => {
    document.querySelector(`#${id}`).textContent = "-";
  });
  elements.packNameHeading.textContent = "-";
  renderDraftState();
  updateDropZone();
}

function resetServerStatus() {
  serverStatus = null;
  serverTools?.reset();
  document.getElementById("manifestSecurityStatus").textContent = t("Нет данных");
  document.getElementById("apiTransportStatus").textContent = "-";
  [elements.serverState, elements.serverPlayers, elements.serverTps, elements.serverUptime, elements.serverMotd,
    elements.serverGamePort, elements.serverEnvironment, elements.serverWorlds, elements.serverTickTime,
    elements.serverJava, elements.serverMemoryText].forEach((element) => { element.textContent = "-"; });
  elements.liveBadge.textContent = t("Нет данных");
  elements.liveBadge.className = "state-badge neutral";
  elements.serverMemoryBar.style.width = "0%";
  elements.playerCountBadge.textContent = "0 / 0";
  elements.playersSummary.disabled = true;
  togglePlayers(false);
  renderPlayers([]);
  elements.restartServerButton.disabled = true;
  elements.stopServerButton.disabled = true;
  renderDashboard();
}

// The running process keeps serving the release it started with, so a published
// pack only reaches players after a restart.
function serverRunsOldRelease() {
  const loaded = serverStatus?.loadedReleaseSequence;
  return Boolean(serverStatus && manifest && typeof loaded === "number" && loaded >= 0
    && manifest.releaseSequence > loaded && !serverStatus.power);
}

function canRestartFromPanel() {
  return serverStatus?.capabilities?.powerActions === true;
}

function openRestartWithDelay() {
  document.getElementById("powerDelaySelect").value = (serverStatus?.players?.online || 0) > 0 ? "60" : "0";
  openPowerDialog("restart");
}

function renderPackRestartNotice() {
  const notice = document.getElementById("packRestartNotice");
  const stale = serverRunsOldRelease();
  notice.hidden = !stale;
  if (!stale) return;
  document.getElementById("packRestartText").textContent = canRestartFromPanel()
    ? t("Сервер ещё работает на прежней версии сборки: изменения дойдут до игроков после перезапуска.")
    : t("Сервер ещё работает на прежней версии сборки: перезапустите его вручную, чтобы изменения дошли до игроков.");
  document.getElementById("packRestartButton").hidden = !canRestartFromPanel();
}

function renderDraftValidationChip() {
  const chip = document.getElementById("draftValidationChip");
  // A clean draft has nothing to publish: its issues mirror the server and live there.
  const issues = draftState?.changes?.dirty ? validationSnapshot.draft?.issues?.length || 0 : 0;
  chip.hidden = !issues;
  if (issues) chip.textContent = t("Проверка нашла проблемы: {0} - публикация будет отклонена", issues);
}

function renderDashboard() {
  const byId = id => document.getElementById(id);
  const changes = draftState?.changes;
  byId("dashPackName").textContent = manifest?.pack?.name || t("Нет данных");
  byId("serverPackName").textContent = manifest?.pack?.name || "-";
  elements.packSummary.disabled = !manifest;
  if (elements.packSummary.disabled) toggleSummary("packSummary", false);
  byId("dashPublishedVersion").textContent = manifest ? manifest.pack.version : "-";
  byId("dashFileCount").textContent = manifest ? String(manifest.files.length) : "-";
  byId("dashDraftState").textContent = !draftState ? "-"
    : changes?.dirty ? countText("changes", changes.total)
    : t("Совпадает");
  // With a clean draft the draft target mirrors the server: count each problem once.
  const dirty = Boolean(changes?.dirty);
  const draftIssues = dirty ? validationSnapshot.draft?.issues?.length || 0 : 0;
  const serverIssues = validationSnapshot.server?.issues?.length || 0;
  byId("dashValidation").textContent = !serverStatus ? "-"
    : !validationSnapshot.supported ? t("Недоступна на этом агенте")
    : validationSnapshot.draft?.pending || validationSnapshot.server?.pending ? t("Выполняется...")
    : draftIssues + serverIssues ? countText("problems", draftIssues + serverIssues)
    : validationSnapshot.draft || validationSnapshot.server ? t("Проблем нет") : "-";

  const rows = [];
  const add = (tone, icon, text, action) => rows.push({ tone, icon, text, action });
  if (powerWatch) {
    add("warn", "loader-circle", powerWatch.action === "restart"
      ? (powerWatch.sawDown ? t("Идёт перезапуск сервера: процесс завершился, ждём запуска. Обычно это занимает до пары минут.") : t("Идёт перезапуск сервера: мир сохраняется, процесс завершается..."))
      : (powerWatch.sawDown ? t("Сервер остановлен из панели. Запустите его штатным способом хостинга.") : t("Идёт остановка сервера: мир сохраняется, процесс завершается...")), null);
  }
  const openConnection = () => { navigateTo("generator"); setAgentMode("connect"); };
  if (!serverStatus) {
    if (!powerWatch) add("warn", "plug-zap", t("Нет подключения к серверу. Проверьте адрес и ключ в настройках сервера."), openConnection);
  } else {
    if (serverStatus.power?.executeAt) {
      const seconds = Math.max(0, Math.round((serverStatus.power.executeAt - Date.now()) / 1000));
      add("warn", "timer", t("{0} через {1}: игроки видят отсчёт в чате. Нажмите, чтобы отменить.",
        serverStatus.power.action === "restart" ? t("Перезапуск сервера") : t("Остановка сервера"), countText("seconds", seconds)),
        () => cancelScheduledPower(serverStatus.power.action));
    }
    if (draftIssues) add("error", "shield-alert", t("Черновик не пройдёт публикацию: {0}. Откройте проверку.", countText("problems", draftIssues)),
      () => { navigateTo("overview"); serverTools.showValidation("draft"); setBuildTab("validation"); });
    if (serverIssues) add("error", "shield-alert", t("Совместимость на сервере: {0}. Откройте проверку.", countText("problems", serverIssues)),
      () => { navigateTo("overview"); serverTools.showValidation("server"); setBuildTab("validation"); });
    if (changes?.dirty) add("warn", "file-pen-line", t("Игроки ещё не видят изменения черновика: {0}. Опубликуйте сборку.", countText("changes", changes.total)),
      () => { navigateTo("overview"); setBuildTab("draft"); });
    if (serverRunsOldRelease()) {
      add("warn", "refresh-cw", canRestartFromPanel()
        ? t("Сервер работает на прежней версии сборки: изменения вступят в силу после перезапуска. Нажмите, чтобы перезапустить с предупреждением игроков.")
        : t("Сервер работает на прежней версии сборки: перезапустите его вручную, чтобы игроки получили обновление."),
        canRestartFromPanel() ? openRestartWithDelay : null);
    }
    // Every signal opens exactly the section it is about: the dialog otherwise keeps
    // whichever section was open last.
    const openAgents = () => { navigateTo("generator"); setAgentMode("agents"); };
    if (agentUpdateSnapshot.pending) add("warn", "hourglass", t("Обновление агентов готово: перезапустите Minecraft-сервер, чтобы он начал работать на новой версии."),
      serverStatus.capabilities?.powerActions === true
        ? () => { document.getElementById("powerDelaySelect").value = (serverStatus.players?.online || 0) > 0 ? "60" : "0"; openPowerDialog("restart"); }
        : openAgents);
    else if (agentUpdateSnapshot.failed) add("error", "triangle-alert", t("Обновление агентов не завершилось. Откройте установку агента и повторите."), openAgents);
    else if (agentUpdateSnapshot.canUpdate) add("warn", "arrow-up-circle", t("Доступно обновление агентов: на сервере {0}, в приложении {1}.", agentUpdateSnapshot.version || "-", agentUpdateSnapshot.available || "-"), openAgents);
    const pending = serverStatus.access?.pending || 0;
    if (pending) add("warn", "user-plus", t("Новые заявки на доступ администраторов: {0}.", pending), () => navigateTo("devices"));
    try {
      const url = new URL(normalizedServerUrl());
      if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        add("warn", "shield-off", t("API работает по HTTP: трафик между панелью и сервером не шифруется."), openConnection);
      }
    } catch { /* The address form is empty; the connection row already covers it. */ }
  }
  const list = document.getElementById("attentionList");
  const badge = document.getElementById("attentionBadge");
  if (!serverStatus && !rows.length) return;
  const problems = rows.length;
  if (!problems) add("ok", "circle-check", t("Всё в порядке: сборка опубликована, проблем совместимости не найдено."), null);
  badge.textContent = !serverStatus ? t("Нет подключения") : problems ? countText("attentionItems", problems) : t("Всё в порядке");
  badge.className = `state-badge ${!serverStatus ? "neutral" : problems ? "warning" : "online"}`;
  list.replaceChildren(...rows.map(row => {
    const item = document.createElement(row.action ? "button" : "div");
    if (row.action) { item.type = "button"; item.addEventListener("click", row.action); }
    item.className = `attention-row ${row.tone}`;
    const icon = document.createElement("i"); icon.dataset.lucide = row.icon;
    if (row.icon === "loader-circle") icon.className = "spin-icon";
    const text = document.createElement("span"); text.textContent = row.text;
    item.append(icon, text);
    if (row.action) { const go = document.createElement("i"); go.dataset.lucide = "chevron-right"; go.className = "attention-go"; item.append(go); }
    return item;
  }));
  window.lucide?.createIcons();
}

/**
 * Who is on the server, kept behind the count in the summary strip.
 *
 * A full server is a thousand names, and building a thousand rows on every five-second refresh
 * would cost more than the answer is worth. Only a screenful is built; the rest is a number,
 * and the filter searches all of them.
 */
const PLAYER_ROWS = 100;

function renderPlayers(players) {
  playerNames = Array.isArray(players) ? players : [];
  const query = elements.playerFilter.value.trim().toLowerCase();
  const matching = query ? playerNames.filter(name => String(name).toLowerCase().includes(query)) : playerNames;
  // The filter only earns its place once scrolling stops being enough to find someone.
  elements.playerFilter.closest(".players-filter").hidden = playerNames.length <= 20;

  elements.playerList.replaceChildren();
  if (!matching.length) {
    const empty = document.createElement("div");
    empty.className = "empty-players";
    empty.textContent = playerNames.length ? t("Никто не подходит под поиск") : t("Никого нет на сервере");
    elements.playerList.append(empty);
    elements.playerListMore.hidden = true;
    return;
  }

  const shown = matching.slice(0, PLAYER_ROWS);
  const rows = document.createDocumentFragment();
  shown.forEach((player) => {
    const row = document.createElement("div");
    row.className = "player-row";
    const avatar = document.createElement("span");
    avatar.textContent = String(player).slice(0, 1).toUpperCase();
    const name = document.createElement("strong");
    name.textContent = player;
    row.append(avatar, name);
    rows.append(row);
  });
  elements.playerList.append(rows);
  elements.playerListMore.hidden = matching.length <= shown.length;
  elements.playerListMore.textContent = t("Показаны первые {0} из {1}. Уточните поиск, чтобы найти игрока.", shown.length, matching.length);
}

/**
 * Positioned against the viewport rather than the strip: the strip clips its own children to
 * keep its rounded corners, and a panel inside it would be cut off at the first row.
 */
function placePopover(entry) {
  const anchor = elements[entry.trigger].getBoundingClientRect();
  const panel = elements[entry.panel];
  const width = panel.offsetWidth || 340;
  panel.style.top = `${Math.round(anchor.bottom + 6)}px`;
  // Kept on screen when the column it belongs to sits near the right edge.
  panel.style.left = `${Math.round(Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)))}px`;
}

function toggleSummary(name, open) {
  const entry = SUMMARY_POPOVERS.find(item => item.trigger === name);
  const panel = elements[entry.panel];
  const next = open ?? panel.hidden;
  // Only one at a time: two panels hanging off the same strip would overlap.
  if (next) for (const other of SUMMARY_POPOVERS) if (other !== entry) elements[other.panel].hidden = true;
  panel.hidden = !next;
  for (const other of SUMMARY_POPOVERS) {
    elements[other.trigger].setAttribute("aria-expanded", String(!elements[other.panel].hidden));
  }
  if (!next) return;
  placePopover(entry);
  if (entry.focus) elements[entry.focus].focus();
}

// Declarations, not const arrows: the first refresh calls these before this line is reached,
// and a const is not yet initialised at that point.
function togglePlayers(open) { toggleSummary("playersSummary", open); }

function closeSummaries() { for (const entry of SUMMARY_POPOVERS) toggleSummary(entry.trigger, false); }

function renderFilteredFiles() {
  document.getElementById("draftTabCount").textContent = draftState?.changes?.total || 0;
  document.getElementById("publishedTabCount").textContent = draftState?.published?.files?.length ?? manifest?.files?.length ?? 0;
  // The draft tab lists only what the next publish will change; the published tab
  // is the full composition players currently receive, editable in place - an edit
  // marks the row as changed and lands in the draft.
  const files = buildTab === "published" ? (draftState?.published?.files || manifest?.files || []).map(file => {
    const draftRow = draftState?.files?.find(item => item.path === file.path);
    return draftRow ? { ...file, ...draftRow } : { ...file, change: "unchanged" };
  }) : (draftState?.files || []).filter(file => file.change && file.change !== "unchanged");
  const query = elements.fileSearchInput.value.trim().toLowerCase();
  const filtered = files.filter((file) => {
    const matchesQuery = !query || String(file.path).toLowerCase().includes(query);
    // Pending removals always stay visible: a side filter remembered from the
    // session must not hide what the next publish is about to delete.
    const matchesSide = sideFilter === "all" || file.change === "removed" || !file.side || file.side === sideFilter || file.side === "both";
    return matchesQuery && matchesSide;
  });
  for (const key of [...tableSelection.keys()]) {
    if (!filtered.some(file => file.path === key && file.change !== "removed")) tableSelection.delete(key);
  }
  renderFilesBulkBar();
  renderFiles(filtered);
  elements.visibleFileCount.textContent = pluralizeFiles(filtered.length);
}

function renderFilesBulkBar() {
  const bar = document.getElementById("filesBulkBar");
  bar.hidden = tableSelection.size === 0;
  document.getElementById("filesBulkCount").textContent = t("Выбрано: {0}", tableSelection.size);
}

function renderFiles(files) {
  elements.filesTable.replaceChildren();
  if (!files.length) {
    const row = document.createElement("tr");
    row.className = "empty-table";
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = !draftState ? t("Подключитесь к серверу")
      : buildTab === "draft" ? t("Изменений нет: черновик совпадает с опубликованной сборкой. Полный состав - на вкладке «Опубликовано».")
      : t("Файлы не найдены");
    row.append(cell);
    elements.filesTable.append(row);
    return;
  }
  for (const file of files) {
    const row = document.createElement("tr");
    row.className = `draft-row ${file.change || "unchanged"}`;
    row.append(fileCell(file, file.change !== "removed"));

    const rootCell = document.createElement("td");
    const rootSelect = createSelect([
      ["mods/", "mods"],
      ["config/", "config"],
      ["resourcepacks/", "resourcepacks"],
      ["shaderpacks/", "shaderpacks"]
    ], managedRoot(file.path));
    rootSelect.className = "inline-select";
    rootSelect.disabled = buildBusy || file.change === "removed" || file.serverRemoval;
    rootSelect.setAttribute("aria-label", t("Папка {0}", file.path));
    rootCell.append(rootSelect);

    const sideCell = document.createElement("td");
    const sideSelect = createSelect([
      ["both", t("Клиент + сервер")],
      ["client", t("Только клиент")],
      ["server", t("Только сервер")]
    ], file.side);
    sideSelect.className = "inline-select";
    sideSelect.disabled = buildBusy || file.change === "removed" || file.serverRemoval;
    sideSelect.setAttribute("aria-label", t("Назначение {0}", file.path));
    sideCell.append(sideSelect);
    if (file.source?.provider === "modrinth") {
      try {
        const policy = modSidePolicy({ environment: file.source.environment }, { title: file.path });
        const help = document.createElement("details"); help.className = "field-help file-side-help";
        const summary = document.createElement("summary"); summary.title = t("Назначение по данным автора Modrinth");
        summary.setAttribute("aria-label", summary.title); summary.append(createIcon("info"));
        const text = document.createElement("p"); text.textContent = policy.explanation;
        help.append(summary, text); sideCell.append(help);
      } catch { /* Unknown metadata must not prevent managing an existing file. */ }
    } else if (file.source?.provider === "github") {
      const help = document.createElement("details"); help.className = "field-help file-side-help";
      const summary = document.createElement("summary"); summary.title = t("Источник и назначение JAR");
      summary.setAttribute("aria-label", summary.title); summary.append(createIcon("info"));
      const text = document.createElement("p");
      text.textContent = t("GitHub: {0}. Назначение определено по JAR или выбрано администратором. Обязательные зависимости проверяются перед публикацией.", file.source.projectId);
      help.append(summary, text); sideCell.append(help);
    }
    rootSelect.addEventListener("change", () => updateDraftFile(file, rootSelect.value, sideSelect.value));
    sideSelect.addEventListener("change", () => updateDraftFile(file, rootSelect.value, sideSelect.value));

    const changeCell = document.createElement("td");
    changeCell.append(changePill(file.change, file.detached));
    row.append(rootCell, sideCell, changeCell, textCell(formatBytes(file.size)));

    const actionCell = document.createElement("td");
    const actions = document.createElement("span");
    actions.className = "row-actions";
    if (file.change !== "unchanged") {
      const revert = document.createElement("button");
      revert.className = "row-action revert";
      revert.type = "button";
      revert.disabled = buildBusy;
      revert.title = file.change === "removed" ? t("Вернуть файл") : t("Отменить изменение");
      revert.setAttribute("aria-label", `${revert.title}: ${file.path}`);
      revert.append(createIcon("undo"));
      revert.addEventListener("click", () => revertDraftFile(file));
      actions.append(revert);
    }
    // Server-side files can leave the pack without being deleted: players never had them.
    if (file.change !== "removed" && file.side === "server") {
      const detach = document.createElement("button");
      detach.className = "row-action detach";
      detach.type = "button";
      detach.disabled = buildBusy;
      detach.title = t("Вернуть во «Вне сборки»: файл останется на сервере, но UDMC перестанет им управлять");
      detach.setAttribute("aria-label", `${detach.title}: ${file.path}`);
      detach.append(createIcon("unlink"));
      detach.addEventListener("click", () => detachDraftFile(file));
      actions.append(detach);
    }
    if (file.change !== "removed") {
      const remove = document.createElement("button");
      remove.className = "row-action";
      remove.type = "button";
      remove.disabled = buildBusy;
      remove.title = t("Удалить из сборки");
      remove.setAttribute("aria-label", t("Удалить {0}", file.path));
      remove.append(createIcon("trash"));
      remove.addEventListener("click", () => openDeleteDialog(file));
      actions.append(remove);
    }
    actionCell.append(actions);
    row.append(actionCell);
    elements.filesTable.append(row);
  }
}

function fileCell(file, selectable = false) {
  const cell = document.createElement("td");
  const wrapper = document.createElement("div");
  wrapper.className = "file-cell";
  if (selectable) {
    const pick = document.createElement("input");
    pick.type = "checkbox";
    pick.className = "inventory-pick table-pick";
    pick.checked = tableSelection.has(file.path);
    pick.disabled = buildBusy;
    pick.setAttribute("aria-label", t("Выбрать для удаления: {0}", file.path));
    pick.addEventListener("change", () => {
      if (pick.checked) tableSelection.set(file.path, file); else tableSelection.delete(file.path);
      renderFilesBulkBar();
    });
    wrapper.append(pick);
  } else {
    wrapper.append(Object.assign(document.createElement("span"), { className: "pick-spacer" }));
  }
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.append(createIcon("file"));
  const meta = document.createElement("span");
  meta.className = "file-meta";
  const name = document.createElement("strong");
  name.textContent = file.path.split("/").pop();
  const filePath = document.createElement("small");
  filePath.textContent = `${file.path} · ${String(file.sha256 || "").slice(0, 10)}`;
  meta.append(name, filePath);
  wrapper.append(icon, meta);
  cell.append(wrapper);
  return cell;
}

async function setSelectedFiles(files, append = false) {
  if (buildBusy) return;
  const next = append ? [...selectedFiles] : [];
  const added = [];
  const known = new Set(next.map((item) => fileIdentity(item.file)));
  files.filter((file) => file && file.name).forEach((file) => {
    const identity = fileIdentity(file);
    if (known.has(identity)) return;
    known.add(identity);
    const inferred = initialFileSettings(file);
    const item = {
      id: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      file,
      root: inferred.root,
      side: inferred.side,
      inference: t("чтение метаданных..."),
      analyzing: true
    };
    next.push(item);
    added.push(item);
  });
  selectedFiles = next;
  elements.fileInput.value = "";
  updateDropZone();
  for (const item of added) {
    const result = await inspectFile(item.file, draftState?.draft?.minecraft?.loader?.type);
    if (!selectedFiles.includes(item)) continue;
    Object.assign(item, result, { analyzing: false });
    updateDropZone();
  }
}

function updateDropZone() {
  const hasFiles = selectedFiles.length > 0;
  const validation = validateSelectedFiles();
  elements.dropTitle.textContent = hasFiles ? t("Добавить ещё файлы") : t("Перетащите файлы сюда");
  elements.dropSubtitle.textContent = hasFiles
    ? `${pluralizeFiles(selectedFiles.length)} · ${formatBytes(selectedFiles.reduce((total, item) => total + item.file.size, 0))}`
    : t("или нажмите, чтобы выбрать на компьютере");
  elements.uploadButton.disabled = buildBusy || !draftState || !hasFiles || Boolean(validation.error);
  elements.fileInput.disabled = buildBusy;
  elements.bulkRootInput.disabled = buildBusy || selectedFiles.some((item) => item.analyzing);
  elements.bulkSideInput.disabled = elements.bulkRootInput.disabled;
  elements.clearSelectedButton.disabled = buildBusy;
  elements.dropZone.classList.toggle("busy", buildBusy);
  updatePublishAvailability();
  elements.selectedFiles.hidden = !hasFiles;
  elements.selectedFilesTitle.textContent = t("Выбрано: {0}", pluralizeFiles(selectedFiles.length));
  elements.stagedValidation.textContent = validation.message;
  elements.stagedValidation.className = `staged-validation${validation.error ? " error" : ""}`;
  elements.stagedFileList.replaceChildren();

  selectedFiles.forEach((item) => {
    const row = document.createElement("div");
    row.className = `staged-file-row${validation.conflicts.has(item.id) ? " conflict" : ""}`;
    const meta = document.createElement("span");
    meta.className = "staged-file-meta";
    const name = document.createElement("strong");
    name.textContent = item.file.name;
    const details = document.createElement("small");
    details.textContent = item.inspectionError || `${formatBytes(item.file.size)} · ${stagedActionLabel(item)} · ${item.inference}`;
    if (item.inspectionError) details.className = "file-error";
    meta.append(name, details);

    const rootSelect = createSelect([
      ["mods/", "mods"],
      ["config/", "config"],
      ["resourcepacks/", "resourcepacks"],
      ["shaderpacks/", "shaderpacks"]
    ], item.root);
    rootSelect.setAttribute("aria-label", t("Папка для {0}", item.file.name));
    rootSelect.disabled = buildBusy || item.analyzing;
    rootSelect.addEventListener("change", () => {
      item.root = rootSelect.value;
      item.inference = t("папка изменена вручную");
      updateDropZone();
    });

    const sideSelect = createSelect([
      ...(!item.side ? [["", t("Выберите назначение")]] : []),
      ["both", t("Клиент + сервер")],
      ["client", t("Только клиент")],
      ["server", t("Только сервер")]
    ], item.side);
    sideSelect.setAttribute("aria-label", t("Назначение для {0}", item.file.name));
    sideSelect.disabled = buildBusy || item.analyzing;
    sideSelect.addEventListener("change", () => {
      item.side = sideSelect.value;
      item.inference = t("назначение проверено вручную");
      updateDropZone();
    });

    const remove = document.createElement("button");
    remove.className = "row-action";
    remove.type = "button";
    remove.disabled = buildBusy;
    remove.title = t("Убрать из выбранных");
    remove.setAttribute("aria-label", t("Убрать {0}", item.file.name));
    remove.append(createIcon("close"));
    remove.addEventListener("click", () => {
      selectedFiles = selectedFiles.filter((selected) => selected.id !== item.id);
      updateDropZone();
    });
    row.append(meta, rootSelect, sideSelect, remove);
    elements.stagedFileList.append(row);
  });
}

function applyBulkSetting(field, select) {
  if (buildBusy || !select.value) return;
  selectedFiles.forEach((item) => {
    item[field] = select.value;
    item.inference = field === "root" ? t("папка задана для группы") : t("назначение задано для группы");
  });
  select.value = "";
  updateDropZone();
}

function validateSelectedFiles() {
  const conflicts = new Set();
  const paths = new Map();
  let oversized = false;
  selectedFiles.forEach((item) => {
    const remotePath = `${item.root}${cleanFileName(item.file.name)}`.toLowerCase();
    if (paths.has(remotePath)) {
      conflicts.add(paths.get(remotePath));
      conflicts.add(item.id);
    } else {
      paths.set(remotePath, item.id);
    }
    if (item.file.size > 512 * 1024 * 1024) oversized = true;
  });
  if (selectedFiles.some((item) => `${item.root}${cleanFileName(item.file.name)}`.toLowerCase() === "config/udmc-sync.json")) {
    return { error: true, message: t("Конфигурация UDMC содержит доступ к серверу и не может входить в сборку."), conflicts };
  }
  if (selectedFiles.some((item) => item.analyzing)) return { error: true, message: t("Чтение метаданных файлов..."), conflicts };
  if (selectedFiles.some((item) => item.inspectionError)) return { error: true, message: t("Уберите файлы с ошибками из списка."), conflicts };
  if (selectedFiles.some(item => !["client", "server", "both"].includes(item.side))) return { error: true, message: t("Выберите назначение каждого файла или задайте его для группы."), conflicts };
  const loader = draftState?.draft?.minecraft?.loader?.type;
  if (loader && selectedFiles.some(item => item.loaders && !item.loaders.includes(loader))) return { error: true, message: t("Загрузчик выбранного мода не совпадает с сервером."), conflicts };
  if (conflicts.size) return { error: true, message: t("Несколько файлов получат одинаковый путь. Измените папку или уберите дубликат."), conflicts };
  if (oversized) return { error: true, message: t("Один из файлов больше допустимых 512 МБ."), conflicts };
  return { error: false, message: selectedFiles.length ? t("Готово к добавлению в черновик") : "", conflicts };
}

function stagedActionLabel(item) {
  const remotePath = `${item.root}${cleanFileName(item.file.name)}`;
  const existing = (draftState?.draft?.files || []).some((file) => file.path.toLowerCase() === remotePath.toLowerCase());
  return existing ? t("обновит существующий файл") : t("новый файл");
}

function fileIdentity(file) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function addConsoleEntry(command, output, transport, error = false) {
  consoleEntries.push({
    command: String(command),
    output: String(output || t("Команда выполнена без текстового ответа.")),
    transport,
    error,
    time: Date.now()
  });
  consoleEntries = consoleEntries.slice(-80);
  renderConsole();
  renderServerReply();
}

// The answer belongs next to the button that asked for it. Without this, pressing one gave a
// toast and nothing else: what the server actually said appeared on a page nobody was on.
function renderServerReply() {
  const last = consoleEntries.at(-1);
  elements.serverReplyCommand.textContent = last ? `> ${last.command}` : "";
  elements.serverReplyText.textContent = last ? last.output : t("Здесь появится ответ на команду");
  elements.serverReplyText.classList.toggle("waiting", !last);
}

function renderConsole() {
  elements.consoleOutput.replaceChildren();
  if (!consoleEntries.length) elements.consoleOutput.innerHTML = t('<div class="console-empty">Консоль готова</div>');
  consoleEntries.forEach((entry) => {
    const block = document.createElement("div");
    block.className = `console-entry${entry.error ? " error" : ""}`;
    const heading = document.createElement("div");
    heading.className = "console-entry-head";
    const commandText = document.createElement("strong");
    commandText.textContent = `> ${entry.command}`;
    const meta = document.createElement("span");
    meta.textContent = `${entry.transport} · ${new Date(entry.time).toLocaleTimeString(getLocale())}`;
    const response = document.createElement("pre");
    response.textContent = entry.output;
    heading.append(commandText, meta);
    block.append(heading, response);
    elements.consoleOutput.append(block);
  });
  elements.consoleOutput.scrollTop = elements.consoleOutput.scrollHeight;
}

function clearConsole() {
  consoleEntries = [];
  elements.consoleOutput.innerHTML = t("<div class=\"console-empty\">Консоль готова</div>");
  renderServerReply();
}

function toggleTokenVisibility() {
  const visible = elements.tokenInput.type === "text";
  elements.tokenInput.type = visible ? "password" : "text";
  elements.tokenVisibilityButton.classList.toggle("visible", !visible);
  elements.tokenVisibilityButton.title = visible ? t("Показать токен") : t("Скрыть токен");
  elements.tokenVisibilityButton.setAttribute("aria-label", elements.tokenVisibilityButton.title);
}

function clearActivity() {
  activityEntries = [];
  elements.logOutput.innerHTML = t("<div class=\"empty-activity\">Операций пока нет</div>");
  updateActivityCount();
}

function addActivity(message, type = "info") {
  activityEntries.unshift({ message: String(message), type, time: Date.now() });
  activityEntries = activityEntries.slice(0, 100);
  renderActivity();
}

function renderActivity() {
  elements.logOutput.replaceChildren();
  if (!activityEntries.length) elements.logOutput.innerHTML = t('<div class="empty-activity">Операций пока нет</div>');
  activityEntries.forEach((item) => {
    const row = document.createElement("div");
    row.className = `activity-entry ${item.type}`;
    const time = document.createElement("span");
    time.className = "activity-time";
    time.textContent = new Date(item.time).toLocaleTimeString(getLocale());
    const symbol = document.createElement("span");
    symbol.className = "activity-symbol";
    symbol.append(createIcon(item.type === "error" ? "alert" : item.type === "success" ? "check" : "info"));
    const copy = document.createElement("span");
    copy.className = "activity-message";
    copy.textContent = item.message;
    row.append(time, symbol, copy);
    elements.logOutput.append(row);
  });
  updateActivityCount();
}

function updateActivityCount() {
  elements.activityCount.hidden = activityEntries.length === 0;
  elements.activityCount.textContent = String(activityEntries.length);
}

function saveUiSession() {
  try {
    profileSession.save({ view: activeView, tab: buildTab, side: sideFilter,
      fileSearch: elements.fileSearchInput.value, commandSearch: document.getElementById("commandSearch").value,
      settingsOpen: document.getElementById("serverProfileDialog").open, catalog: modrinthUi?.selected(),
      packName: document.getElementById("packNameInput").value, packNameDirty,
      profileName: document.getElementById("serverProfileName").value, profileNameDirty,
      activity: activityEntries, console: consoleEntries },
    [elements.tokenInput.value, elements.rconPasswordInput.value,
      document.getElementById("pairCodeInput").value, document.getElementById("inviteCode").value]);
  } catch { /* Session history is optional; a full store must not block server management. */ }
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.append(createIcon(type === "error" ? "alert" : "check"));
  const copy = document.createElement("span");
  copy.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.title = t("Закрыть");
  close.setAttribute("aria-label", t("Закрыть уведомление"));
  close.textContent = "×";
  close.addEventListener("click", () => toast.remove());
  toast.append(copy, close);
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function handleError(error) {
  const message = formatAgentError(error);
  addActivity(message, "error");
  showToast(message, "error");
}

async function requestJson(pathname) {
  return agentJson(apiUrl(pathname));
}

async function adminGet(pathname) {
  return agentJson(apiUrl(pathname), { headers: adminHeaders() });
}

async function adminJson(pathname, body) {
  return workspaceAccess.mutate(pathname, {
    method: "POST",
    redirect: "error",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function adminRaw(pathname, body, headers) {
  return workspaceAccess.mutate(pathname, {
    method: "POST",
    redirect: "error",
    headers: { ...adminHeaders(), ...headers },
    body
  }, UPLOAD_TIMEOUT);
}

function adminHeaders() {
  const url = new URL(normalizedServerUrl());
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !document.getElementById("allowHttpConnection").checked) {
    throw new Error(t("Ключ по HTTP не отправлен. Используйте HTTPS или разрешите HTTP для доверенной сети на странице «Агент и доступ»."));
  }
  return { "x-udmc-token": elements.tokenInput.value.trim(), ...workspaceAccess.headers() };
}

function closeStaleBuildDialogs() {
  agentUpdates?.invalidateConfirmation();
  for (const dialog of [elements.publishDialog, elements.deleteDialog, elements.resetDraftDialog, elements.powerDialog]) {
    if (dialog.open) dialog.close();
  }
  deleteTarget = null; publishRevision = null;
}

function renderWorkspaceAccess() {
  const banner = document.getElementById("workspacePresence");
  const state = workspaceAccess.status();
  // Older agents flag "mine" per session, so a leftover session of this very device
  // (a WebView reload) would show up as another admin for up to 90 seconds.
  const others = state?.online?.filter(device => !device.mine && device.deviceId !== accessIdentityId) || [];
  banner.hidden = !workspaceAccess.locked() && !others.length;
  banner.classList.toggle("workspace-locked", workspaceAccess.locked());
  document.getElementById("workspacePresenceText").textContent = workspaceAccess.locked()
    ? t("{0} сейчас изменяет сервер. Дождитесь окончания операции.", state.lease.name)
    : t("Также в панели: {0}", [...new Set(others.map(device => device.name))].join(", "));
}

function restoreConnection() {
  let oldGenerator = null;
  try { oldGenerator = JSON.parse(localStorage.getItem("udmc-generator-settings") || "null"); } catch { /* Old UI state may be absent. */ }
  document.getElementById("packNameInput").value = localStorage.getItem("udmc-pack-name") || oldGenerator?.generatorPackName || t("Основная сборка");
  document.getElementById("allowHttpConnection").checked = Boolean(localStorage.getItem("udmc-allow-http-url")) && localStorage.getItem("udmc-allow-http-url") === localStorage.getItem(STORAGE_KEYS.serverUrl);
  elements.serverUrlInput.value = localStorage.getItem(STORAGE_KEYS.serverUrl) || localStorage.getItem("udm-admin-server-url") || DEFAULT_SERVER_URL;
  elements.tokenInput.value = localStorage.getItem(STORAGE_KEYS.token) || localStorage.getItem("udm-admin-token") || "";
  updateServerLabel();
}

async function saveConnection() {
  const normalized = normalizedServerUrl();
  const connection = { url: normalized, token: elements.tokenInput.value.trim() };
  await persistConnection(connection, document.getElementById("allowHttpConnection").checked);
  elements.serverUrlInput.value = normalized;
  if (!elements.rconHostInput.value) elements.rconHostInput.value = inferredRconHost();
  updateServerLabel();
}

async function persistConnection(connection, allowHttp) {
  if (window.__TAURI__?.core?.invoke) {
    await profileInvoke("credential_write", { name: "admin-connection", value: JSON.stringify(connection) });
  }
  localStorage.setItem(STORAGE_KEYS.serverUrl, connection.url);
  if (allowHttp) localStorage.setItem("udmc-allow-http-url", connection.url);
  else localStorage.removeItem("udmc-allow-http-url");
  knownConnection = connection;
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem("udm-admin-token");
}

async function restoreSecureCredentials() {
  const invoke = window.__TAURI__?.core?.invoke ? profileInvoke : null;
  if (!invoke) return;
  try {
    const connection = await invoke("credential_read", { name: "admin-connection" });
    if (connection) {
      const saved = JSON.parse(connection);
      saved.url = normalizeAddress(saved.url);
      knownConnection = saved;
      if (!localStorage.getItem(STORAGE_KEYS.serverUrl)) elements.serverUrlInput.value = normalizeAddress(saved.url);
      if (saved.url === normalizedServerUrl()) elements.tokenInput.value = saved.token;
      updateServerLabel();
    } else if (elements.tokenInput.value) {
      await saveConnection();
    }
    const password = await invoke("credential_read", { name: "rcon-password" });
    if (password && elements.rememberRconPasswordInput.checked) {
      const saved = JSON.parse(password);
      if (saved.host === elements.rconHostInput.value.trim() && saved.port === Number(elements.rconPortInput.value)) elements.rconPasswordInput.value = saved.password;
    } else if (elements.rconPasswordInput.value && elements.rememberRconPasswordInput.checked) {
      await invoke("credential_write", { name: "rcon-password", value: JSON.stringify({ host: elements.rconHostInput.value.trim(), port: Number(elements.rconPortInput.value), password: elements.rconPasswordInput.value }) });
    }
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem("udm-admin-token");
    localStorage.removeItem(STORAGE_KEYS.rconPassword);
  } catch (error) { showToast(formatAppError(error), "error"); }
}

function restoreRconSettings() {
  elements.rconEnabledInput.checked = localStorage.getItem(STORAGE_KEYS.rconEnabled) === "true";
  elements.rconHostInput.value = localStorage.getItem(STORAGE_KEYS.rconHost) || inferredRconHost();
  elements.rconPortInput.value = localStorage.getItem(STORAGE_KEYS.rconPort) || String(DEFAULT_RCON_PORT);
  elements.rememberRconPasswordInput.checked = localStorage.getItem(STORAGE_KEYS.rconRemember) === "true";
  elements.rconPasswordInput.value = elements.rememberRconPasswordInput.checked ? localStorage.getItem(STORAGE_KEYS.rconPassword) || "" : "";
  updateRconFields();
}

function updateRconFields() {
  const enabled = elements.rconEnabledInput.checked;
  elements.rconFields.classList.toggle("disabled", !enabled);
  elements.rconFields.querySelectorAll("input").forEach((input) => { input.disabled = !enabled; });
  elements.testRconButton.disabled = !enabled;
  elements.commandTransportLabel.textContent = enabled ? "RCON" : "UDMC Agent";
  elements.commandTransportLabel.classList.toggle("rcon", enabled);
  renderRconStatus();
}

function updateServerLabel() {
  try {
    const url = new URL(normalizedServerUrl());
    elements.serverLabel.textContent = url.host;
    elements.serverLabel.title = url.href;
  } catch {
    elements.serverLabel.textContent = elements.serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  }
}

function normalizedServerUrl() {
  return normalizeAddress(elements.serverUrlInput.value || DEFAULT_SERVER_URL);
}

function apiUrl(pathname) {
  return new URL(String(pathname).replace(/^\/+/, ""), normalizedServerUrl());
}

function inferredRconHost() {
  try {
    return new URL(normalizedServerUrl()).hostname;
  } catch {
    return "127.0.0.1";
  }
}

function setStatus(text, mode) {
  elements.statusBadge.textContent = text;
  elements.statusDot.className = `status-dot ${mode || ""}`.trim();
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function setBuildBusy(busy) {
  const finished = buildBusy && !busy;
  buildBusy = busy;
  for (const id of ["serverProfileSelect", "addServerProfileButton", "serverProfileSettingsButton", "serverProfileCloseButton", "serverProfileName"]) document.getElementById(id).disabled = busy;
  if (finished) workspaceAccess.release().then(renderWorkspaceAccess).catch(() => {});
  elements.resetDraftButton.disabled = busy;
  elements.refreshButton.disabled = busy;
  elements.serverUrlInput.disabled = busy;
  elements.tokenInput.disabled = busy;
  document.querySelector("#connectButton").disabled = busy;
  document.querySelector("#localConnectionButton").disabled = busy;
  document.querySelectorAll("#generatorForm input, #generatorForm select, #generatorForm button, #recoverIdentityButton, #deviceNameInput, #allowHttpConnection, [data-agent-mode], #joinForm input, #joinForm textarea, #joinForm button, #deviceList button, #packSettingsForm input, #packSettingsForm button").forEach(input => { input.disabled = busy; });
  document.getElementById("agentCreateTab").disabled = busy;
  document.getElementById("inviteDeviceButton").disabled = busy || accessRole !== "owner";
  elements.restartServerButton.disabled = busy || !serverStatus?.capabilities?.powerActions;
  elements.stopServerButton.disabled = busy || !serverStatus?.capabilities?.powerActions;
  elements.uploadButton.setAttribute("aria-busy", String(busy));
  renderFilteredFiles();
  updateDropZone();
  protectedSettings?.syncLocks();
}

function updatePublishAvailability() {
  elements.publishOpenButton.disabled = buildBusy || selectedFiles.length > 0 || !draftState?.changes?.dirty;
  elements.publishOpenButton.title = selectedFiles.length
    ? t("Сначала добавьте выбранные файлы в черновик или очистите выбор")
    : draftState?.changes?.dirty ? t("Применить подготовленные изменения") : t("Нет изменений для публикации");
}

function textCell(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

function changePill(change = "unchanged", detached = false) {
  const pill = document.createElement("span");
  pill.className = `change-pill ${detached ? "detached" : change}`;
  pill.textContent = detached ? t("Выйдет из сборки")
    : { added: t("Добавлен"), updated: t("Изменён"), removed: t("Будет удалён"), unchanged: t("Опубликован") }[change] || t("Опубликован");
  return pill;
}

function createSelect(options, value) {
  const select = document.createElement("select");
  options.forEach(([optionValue, label]) => {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  });
  select.value = value;
  return select;
}

function managedRoot(path) {
  return `${String(path).split("/")[0]}/`;
}

function createIcon(name) {
  const paths = {
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v5M14 11v5"/>',
    undo: '<path d="M3 7v6h6M3 13a8 8 0 1 1 2.4 5.7"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><path d="M14 2v6h6"/>'
  };
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = paths[name] || paths.info;
  return icon;
}

function formatBytes(value) {
  const units = [t("Б"), t("КБ"), t("МБ"), t("ГБ")];
  let current = Number(value || 0);
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(value) {
  let seconds = Math.max(0, Number(value || 0));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return t("{0} д {1} ч", days, hours);
  if (hours) return t("{0} ч {1} мин", hours, minutes);
  return t("{0} мин", minutes);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(getLocale(), { day: "2-digit", month: "short", year: "numeric" });
}

function pluralizeFiles(count) {
  return countText("files", count);
}

function pluralizeChanges(count) {
  return countText("changes", count);
}

function formatChangeSummary(changes) {
  return t("Добавлено: {0}. Изменено: {1}. Удаляется: {2}. Изменения станут доступны серверу и клиентам.", changes.added, changes.updated, changes.removed);
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

function cleanFileName(name) {
  return String(name || "file.bin").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "_");
}

function bumpPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(String(version || "0.0.0"));
  if (!match) return `${version || "0.0.0"}.1`;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] || ""}`;
}
