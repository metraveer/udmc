// A stand-in agent for looking at the panel: enough of the API to fill every screen with
// plausible data, and nothing that touches a real server. Read-only by design - mutations
// answer with what the panel expects and change nothing that matters.
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || 46000);
const PLAYERS = Number(process.argv[3] || 0);
let paired = false;
let requireClient = false;
let gameAddress = "play.example.com:25565";

const DEMO = ["Steve_Craft", "AlexTheMiner", "Enderman42", "RedstoneNinja", "CreeperHugs", "IronGolem_77"];
const names = Array.from({ length: PLAYERS }, (_, i) => DEMO[i] ?? `Player${String(i + 1).padStart(4, "0")}`);

const send = (response, status, body) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "cache-control": "no-store",
    "x-udmc-revision": "1",
  });
  response.end(JSON.stringify(body));
};

const file = (path, side, size, extra = {}) => ({
  path, side, size, sha256: "0".repeat(64), downloadPath: `/files/${"0".repeat(64)}.jar`, ...extra,
});

const published = {
  schemaVersion: 1, releaseSequence: 3,
  pack: { id: "udmc-main", name: "Дракон и Пламя", version: "1.4.2" },
  minecraft: { version: "26.2", loader: { type: "fabric", version: "0.19.3" } },
  files: [
    // Named by mod id and version, and by the catalog it came from: what lets the panel tell
    // "the same mod at another version" when the owner adds it again from Modrinth.
    file("mods/fabric-api.jar", "both", 2535765, { modIds: ["fabric-api", "fabric"], modVersion: "0.158.0+26.2", source: { provider: "modrinth", projectId: "P7dR8mSH", versionId: "older", environment: "client_and_server" } }),
    file("mods/xaerominimap-fabric-26.2-26.3.0.jar", "client", 2_120_000, { modIds: ["xaerominimap"], modVersion: "26.3.0" }),
    file("mods/sodium.jar", "client", 1204880),
    file("mods/lithium.jar", "both", 512300),
    file("config/sodium-options.json", "client", 2048),
    file("mods/create.jar", "both", 18_432_000),
    file("mods/journeymap.jar", "client", 6_120_400),
    file("mods/ferritecore.jar", "both", 148_900),
    file("resourcepacks/dragon-fire.zip", "client", 24_800_000),
  ],
};

const draft = {
  ...published,
  files: [
    ...published.files,
    file("mods/farmers-delight.jar", "both", 3_204_800),
    file("mods/waystones.jar", "both", 1_920_400),
  ],
};

createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-expose-headers": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    });
    response.end();
    return;
  }

  if (url.pathname === "/health") return send(response, 200, { ok: true, accessControl: true, service: "udmc-sync-fabric" });
  if (url.pathname === "/manifest") return send(response, 200, published);

  if (url.pathname === "/admin/access/me") return send(response, 200, { id: "device-1", name: "METRAVEER", role: "owner", bootstrap: false, pending: 1 });
  if (url.pathname === "/admin/access") {
    return send(response, 200, {
      me: { id: "device-1", name: "METRAVEER", role: "owner", bootstrap: false, pending: 1 },
      devices: [
        { id: "device-1", name: "METRAVEER", role: "owner", status: "approved", active: true, lastIp: "178.234.120.34", lastSeen: Date.now() - 20_000, createdAt: Date.now() - 86_400_000 },
        { id: "device-2", name: "Ноутбук друга", role: "admin", status: "pending", active: false, verification: "4821", lastIp: "95.24.11.7", createdAt: Date.now() - 600_000, expiresAt: Date.now() + 1_200_000 },
      ],
      invites: [{ id: "inv-1", expiresAt: Date.now() + 900_000, used: false }],
      events: [
        { at: Date.now() - 60_000, device: "METRAVEER", action: "connected", ip: "178.234.120.34", status: 200 },
        { at: Date.now() - 3_600_000, device: "METRAVEER", action: "requested", ip: "178.234.120.34", status: 202 },
      ],
    });
  }
  if (url.pathname === "/admin/workspace") return send(response, 200, { revision: "1", editors: [], lock: null });
  if (url.pathname === "/admin/files") {
    return send(response, 200, {
      revision: "1", published, draft,
      files: draft.files.map((entry, index) => ({
        ...entry,
        change: index === draft.files.length - 1 ? "added"
          : index === draft.files.length - 2 ? "added"
            : index === 1 ? "updated" : "unchanged",
      })),
      changes: { dirty: true, added: 2, removed: 0, updated: 1, total: 3 },
    });
  }
  if (url.pathname === "/admin/agents") {
    return send(response, 200, {
      protocol: 1, currentVersion: "0.19.0", requireClient, gameAddress,
      serverUrl: `http://127.0.0.1:${PORT}`, downloadUrl: `http://127.0.0.1:${PORT}/agents/download`,
      instructionsUrl: `http://127.0.0.1:${PORT}/udmc`, signed: true,
      packId: "udmc-main", packName: "Дракон и Пламя",
      minecraftVersion: "26.2", loaderType: "fabric", loaderVersion: "0.19.3",
      client: { version: "0.19.0", sha256: "a".repeat(64), sequence: "1" },
      update: { state: "idle" }, canUpdate: true,
    });
  }
  if (url.pathname === "/admin/agents/settings" && request.method === "POST") {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      try {
        const value = JSON.parse(body || "{}");
        if (typeof value.requireClient === "boolean") requireClient = value.requireClient;
        if (typeof value.gameAddress === "string") gameAddress = value.gameAddress;
      } catch { /* the panel is what is being looked at, not this */ }
      send(response, 200, {
        protocol: 1, currentVersion: "0.19.0", requireClient, gameAddress,
        serverUrl: `http://127.0.0.1:${PORT}`, downloadUrl: `http://127.0.0.1:${PORT}/agents/download`,
        signed: true, packId: "udmc-main", packName: "Дракон и Пламя",
        minecraftVersion: "26.2", loaderType: "fabric", loaderVersion: "0.19.3",
        client: { version: "0.19.0", sha256: "a".repeat(64), sequence: "1" },
        update: { state: "idle" }, canUpdate: true,
      });
    });
    return;
  }
  if (url.pathname === "/admin/project/backup") {
    return send(response, 200, {
      format: "udmc-project-backup-1", packId: "udmc-main", packName: "Дракон и Пламя",
      adminToken: "f".repeat(64), manifestPublicKey: "MCowBQYDK2VwAyEA" + "A".repeat(28),
      manifestPrivateKey: "MC4CAQAwBQYDK2VwBCIEI" + "B".repeat(27),
      fingerprint: "ab:cd:ef:01:23:45:67:89",
    });
  }
  if (url.pathname === "/admin/status") {
    return send(response, 200, {
      state: "online", motd: "Дракон и Пламя | сезон 3", gamePort: 25565, worlds: 3, javaVersion: "25.0.4",
      minecraftVersion: "26.2", loader: { type: "fabric", version: "0.19.3" },
      uptimeSeconds: 2460, agentProtocol: 1,
      players: { online: names.length, max: Math.max(20, names.length), names },
      performance: { tps: 20, averageTickMs: 0.08, memoryUsedBytes: 286 * 1024 * 1024, memoryMaxBytes: 6 * 1024 * 1024 * 1024 },
      security: { signedManifest: true, algorithm: "Ed25519" },
      access: { id: "device-1", name: "METRAVEER", role: "owner", bootstrap: false, pending: 1 },
      rcon: { enabled: false, port: 25575 },
      capabilities: { commands: true, modValidation: true, powerActions: true },
    });
  }
  if (url.pathname === "/admin/server/commands") {
    return send(response, 200, {
      source: "server", minecraftVersion: "26.2",
      commands: [
        { name: "list", usage: ["list", "list uuids"] },
        { name: "save-all", usage: ["save-all", "save-all flush"] },
        { name: "whitelist", usage: ["whitelist add <player>", "whitelist remove <player>", "whitelist list"] },
        { name: "time", usage: ["time set <value>", "time add <value>", "time query <daytime|gametime|day>"] },
        { name: "ban", usage: ["ban <player> [<reason>]"] },
        { name: "weather", usage: ["weather clear [<duration>]", "weather rain [<duration>]", "weather thunder [<duration>]"] },
        { name: "difficulty", usage: ["difficulty", "difficulty <peaceful|easy|normal|hard>"] },
        { name: "gamemode", usage: ["gamemode <survival|creative|adventure|spectator> [<targets>]"] },
      ],
    });
  }
  if (url.pathname === "/admin/validation") {
    return send(response, 200, { target: url.searchParams.get("target") === "server" ? "server" : "draft", revision: "1", ok: false, checkedAt: new Date().toISOString(), issues: [
      { side: "server", level: "warning", code: "udmc_sync.diagnostic.not_delivered", args: ["mods/xaerominimap-fabric-26.2-26.4.2.jar", "xaerominimap", "12"], message: "xaerominimap adds 12 registry entries but is not handed to players." },
      { side: "server", level: "warning", code: "udmc_sync.diagnostic.not_delivered_namespace", args: ["xaeroworldmap", "4"], message: "The server holds 4 registry entries in the xaeroworldmap namespace that no file handed to players carries." },
      { side: "client", level: "error", code: "udmc_sync.diagnostic.required", args: ["mods/waystones.jar", "waystones", "balm", ">=21.0.0"], message: "waystones needs balm." },
    ] });
  }
  if (url.pathname === "/admin/server/files") return send(response, 200, { revision: "1", files: [
    { path: "mods/xaeroworldmap-fabric-26.2-26.1.0.jar", size: 3_400_000, sha256: "1".repeat(64), removalPending: false, modIds: ["xaeroworldmap"], modVersion: "26.1.0" },
  ] });
  if (url.pathname === "/admin/server/files/remove" && request.method === "POST") return send(response, 200, { revision: "1", files: [], changes: { added: 0, updated: 0, removed: 1, total: 1, dirty: true } });
  if (url.pathname === "/admin/server/command" && request.method === "POST") {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      let command = "";
      try { command = JSON.parse(body || "{}").command || ""; } catch { /* shown below as-is */ }
      const answers = {
        list: `There are ${names.length} of a max of 20 players online: ${names.join(", ")}`,
        "save-all": "Saving the game (this may take a moment!)" + String.fromCharCode(10) + "Saved the game",
        "time query daytime": "The time is 6042",
      };
      send(response, 200, { output: answers[command.trim()] ?? `[мок-агент] выполнено бы: ${command}` });
    });
    return;
  }

  if (url.pathname === "/pair" && request.method === "GET") {
    return send(response, 200, { unpaired: !paired, packName: "Дракон и Пламя", minecraftVersion: "26.2", loaderType: "fabric" });
  }
  if (url.pathname === "/pair" && request.method === "POST") {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      let code = "";
      try { code = JSON.parse(body || "{}").code || ""; } catch { /* handled below */ }
      if (paired) return send(response, 409, { error: "Этот сервер уже привязан.", code: "PAIRING_ALREADY_DONE", args: [] });
      if (code.replace(/-/g, "").toUpperCase() !== "ABCDEFGHJKMNPQRS") {
        return send(response, 403, { error: "Код не подходит к этому серверу.", code: "PAIRING_CODE_INVALID", args: [] });
      }
      paired = true;
      send(response, 200, {
        packId: "udmc-main", packName: "Дракон и Пламя", adminToken: "a".repeat(64),
        manifestPublicKey: "MCowBQYDK2VwAyEA" + "b".repeat(28), fingerprint: "4f".repeat(32),
        minecraftVersion: "26.2", loaderType: "fabric", loaderVersion: "0.19.3",
        apiPort: PORT, agentVersion: "0.20.0",
      });
    });
    return;
  }

  send(response, 404, { error: "Not found", code: "NOT_FOUND", args: [] });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`мок-агент: http://127.0.0.1:${PORT}/  игроков: ${PLAYERS}`);
  console.log("код привязки для проверки: ABCD-EFGH-JKMN-PQRS");
});
