const views = new Set(["dashboard", "overview", "modrinth", "console", "devices", "dependencies", "activity", "settings"]);
const tabs = new Set(["draft", "published", "server", "validation"]);
const sides = new Set(["all", "client", "server"]);
const text = (value, limit = 4096) => typeof value === "string" ? value.slice(0, limit) : "";
function sanitize(value = {}, secrets = []) {
  const redact = value => secrets.filter(secret => typeof secret === "string" && secret.length).sort((a, b) => b.length - a.length)
    .reduce((result, secret) => result.replaceAll(secret, "[redacted]"), typeof value === "string" ? value : "").slice(0, 16384);
  const entries = (name, limit, convert) => Array.isArray(value[name]) ? value[name].filter(entry => entry && Number.isFinite(entry.time)).slice(-limit).map(convert) : [];
  return {
    view: views.has(value.view) ? value.view : "dashboard",
    tab: tabs.has(value.tab) ? value.tab : "draft",
    side: sides.has(value.side) ? value.side : "all",
    settingsOpen: value.settingsOpen === true,
    catalog: ["modrinth", "github", "curseforge"].includes(value.catalog) ? value.catalog : "modrinth",
    packName: text(value.packName, 128), packNameDirty: value.packNameDirty === true,
    profileName: text(value.profileName, 80), profileNameDirty: value.profileNameDirty === true,
    powerDraft: value.powerDraft === true, powerDirty: value.powerDirty === true,
    fileSearch: redact(value.fileSearch).slice(0, 200), commandSearch: redact(value.commandSearch).slice(0, 200),
    activity: entries("activity", 100, entry => ({ time: entry.time, message: redact(entry.message), type: ["error", "success", "info"].includes(entry.type) ? entry.type : "info" })),
    console: entries("console", 80, entry => ({ time: entry.time, command: redact(entry.command), output: redact(entry.output), transport: text(entry.transport, 80), error: entry.error === true }))
  };
}

// Session storage survives WebView reloads/profile switches, not a new app session.
export function createProfileSession(storage, profile) {
  const key = `udmc-ui-session:${profile}`;
  return {
    read() {
      try { const value = JSON.parse(storage.getItem(key) || "null"); const restored = Boolean(value && typeof value === "object" && !Array.isArray(value)); return { ...sanitize(restored ? value : {}), restored }; }
      catch { return sanitize(); }
    },
    save(value, secrets) { storage.setItem(key, JSON.stringify(sanitize(value, secrets))); }
  };
}
