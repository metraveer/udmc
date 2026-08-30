// Builds an isolated end-to-end stand: real server and client JARs customised exactly the
// way Control customises them, so the player's path can be walked instead of imagined.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

const VERSION = process.argv[2] || "26.2";
const ROOT = path.resolve(".qa", `fabric-${VERSION}-e2e`);
const TEMPLATE = path.resolve("minecraft/udmc-sync-fabric/build", VERSION, "libs",
  `udmc-sync-fabric-${VERSION}-${JSON.parse(readFileSync("package.json", "utf8")).version}.jar`);
const API_PORT = 43077, GAME_PORT = 43565, PACK_ID = "udmc-e2e";

rmSync(ROOT, { recursive: true, force: true });
for (const dir of ["server/config", "server/mods", "client/config", "client/mods"]) mkdirSync(path.join(ROOT, dir), { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const identity = {
  publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  token: randomBytes(32).toString("hex"),
};

const loaderVersion = /loader_version=(.+)/.exec(readFileSync(`minecraft/udmc-sync-fabric/gradle.properties`, "utf8"))?.[1]?.trim() || "0.19.3";

// Same field order and hashing as Control: the bootstrapId is a digest of the value.
const bootstrap = server => {
  const value = {
    role: server ? "server" : "client",
    packId: PACK_ID, packName: "UDMC End To End",
    serverUrl: `http://127.0.0.1:${API_PORT}`,
    templateId: `fabric-${VERSION}`,
    manifestPublicKey: identity.publicKey,
    requireSignedManifest: true, allowInsecureHttp: true,
    minecraftVersion: VERSION, loaderType: "fabric", loaderVersion,
  };
  if (server) {
    value.apiHost = "127.0.0.1"; value.apiPort = API_PORT;
    value.adminToken = identity.token; value.manifestPrivateKey = identity.privateKey;
  }
  value.bootstrapId = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return value;
};

// The same rewrite Control performs: role-specific metadata, one mixin config, no leftovers.
const customise = (templateBytes, value) => {
  const entries = unzipSync(templateBytes);
  const server = value.role === "server";
  const out = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/") || name === "udmc-bootstrap.json") continue;
    if (name === "fabric.mod.json") {
      const metadata = JSON.parse(strFromU8(bytes));
      metadata.environment = server ? "server" : "client";
      metadata.name = server ? "UDMC Server" : "UDMC Client";
      metadata.mixins = [server ? "udmc_sync.mixins.json" : "udmc_sync.client.mixins.json"];
      delete metadata.entrypoints[server ? "client" : "server"];
      out[name] = strToU8(JSON.stringify(metadata));
    } else out[name] = bytes;
  }
  out["udmc-bootstrap.json"] = strToU8(JSON.stringify(value, null, 2));
  return zipSync(out, { level: 6 });
};

const template = readFileSync(TEMPLATE);
writeFileSync(path.join(ROOT, "server/mods/udmc-sync-server.jar"), customise(template, bootstrap(true)));
writeFileSync(path.join(ROOT, "client/mods/udmc-sync-client.jar"), customise(template, bootstrap(false)));
// Kept aside so scenarios can restore or swap it without rebuilding the stand.
writeFileSync(path.join(ROOT, "client-agent.jar"), customise(template, bootstrap(false)));
writeFileSync(path.join(ROOT, "raw-agent.jar"), template);

writeFileSync(path.join(ROOT, "fixture.json"), JSON.stringify({
  isolatedRuntimeFixture: true, template: `fabric-${VERSION}`, minecraft: VERSION,
  gamePort: GAME_PORT, url: `http://127.0.0.1:${API_PORT}`,
  token: identity.token, publicKey: identity.publicKey, packId: PACK_ID,
}, null, 2) + "\n");
writeFileSync(path.join(ROOT, "server/eula.txt"), "eula=true\n");
writeFileSync(path.join(ROOT, "server/server.properties"),
  ["online-mode=false", `server-port=${GAME_PORT}`, "server-ip=127.0.0.1", "level-name=e2e-world",
   "max-players=4", "view-distance=4", "simulation-distance=4", "sync-chunk-writes=false",
   "motd=UDMC end-to-end stand", "enable-status=true",
   // A paused server stops ticking, and the login check waits on ticks. Without this the
   // stand answers a joining player with a timeout, which reads like a fault in the agent.
   "pause-when-empty-seconds=0"].join("\n") + "\n");
// The client joins by itself and must not stumble over the third-party warning.
writeFileSync(path.join(ROOT, "client/options.txt"),
  ["skipMultiplayerWarning:true", "onboardAccessibility:false", "tutorialStep:none", "lang:ru_ru", "guiScale:2"].join("\n") + "\n");

console.log("стенд:", ROOT);
console.log("проект:", PACK_ID, "| API:", API_PORT, "| игра:", GAME_PORT);
console.log("серверный JAR и клиентский JAR собраны из", path.basename(TEMPLATE));
