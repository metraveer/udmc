// Builds an isolated end-to-end stand: a real server and a real client, both running the same
// UDMC file players would install, so the player's path can be walked instead of imagined.
//
// Nothing is prepared for them. The server has no project until it starts and makes one, and
// the client belongs to nothing until it joins and the player accepts what the server offers -
// which is exactly the sequence that has to be tried on real software, not described.
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const VERSION = process.argv[2] || "26.2";
// NeoForge has a verification path of its own - a configuration task rather than a tick - so a
// stand that can only raise Fabric leaves the loader with the different mechanism untested.
const LOADER = process.argv[3] === "neoforge" ? "neoforge" : "fabric";
const ROOT = path.resolve(".qa", `${LOADER}-${VERSION}-e2e`);
const TEMPLATE = path.resolve(`minecraft/udmc-sync-${LOADER}/build`, VERSION, "libs",
  `udmc-sync-${LOADER}-${VERSION}-${JSON.parse(readFileSync("package.json", "utf8")).version}.jar`);
const API_PORT = 43077, GAME_PORT = 43565, RCON_PORT = 43575;

rmSync(ROOT, { recursive: true, force: true });
for (const dir of ["server/config", "server/mods", "client/config", "client/mods"]) mkdirSync(path.join(ROOT, dir), { recursive: true });

// The same bytes in both places, and a spare copy for scenarios that swap files around.
copyFileSync(TEMPLATE, path.join(ROOT, "server/mods/udmc-sync.jar"));
copyFileSync(TEMPLATE, path.join(ROOT, "client/mods/udmc-sync.jar"));
copyFileSync(TEMPLATE, path.join(ROOT, "udmc-sync.jar"));

// The agent's own port is a server setting now, not something baked into a file, so the stand
// sets it the way an owner would: by writing it into the configuration before the first start.
// Everything else the agent fills in for itself, including the project it is about to create.
writeFileSync(path.join(ROOT, "server/config/udmc-sync.json"),
  JSON.stringify({ apiHost: "127.0.0.1", apiPort: API_PORT }, null, 2) + "\n");

const rconPassword = randomBytes(16).toString("hex");
writeFileSync(path.join(ROOT, "fixture.json"), JSON.stringify({
  isolatedRuntimeFixture: true, template: `${LOADER}-${VERSION}`, minecraft: VERSION, loader: LOADER,
  gamePort: GAME_PORT, url: `http://127.0.0.1:${API_PORT}`,
  rcon: { host: "127.0.0.1", port: RCON_PORT, password: rconPassword },
}, null, 2) + "\n");
writeFileSync(path.join(ROOT, "server/eula.txt"), "eula=true\n");
writeFileSync(path.join(ROOT, "server/server.properties"),
  ["online-mode=false", `server-port=${GAME_PORT}`, "server-ip=127.0.0.1", "level-name=e2e-world",
   "max-players=4", "view-distance=4", "simulation-distance=4", "sync-chunk-writes=false",
   "motd=UDMC end-to-end stand", "enable-status=true",
   // Pairing over RCON is one of the four ways an owner reaches the code, and the only one
   // the panel can walk unaided. The stand offers it so that path gets exercised too.
   "enable-rcon=true", `rcon.port=${RCON_PORT}`, `rcon.password=${rconPassword}`,
   // A paused server stops ticking, and the login check waits on ticks. Without this the
   // stand answers a joining player with a timeout, which reads like a fault in the agent.
   "pause-when-empty-seconds=0"].join("\n") + "\n");
// The client joins by itself and must not stumble over the third-party warning.
writeFileSync(path.join(ROOT, "client/options.txt"),
  ["skipMultiplayerWarning:true", "onboardAccessibility:false", "tutorialStep:none", "lang:ru_ru", "guiScale:2"].join("\n") + "\n");

console.log("стенд:", ROOT, `(${LOADER})`);
console.log("API:", API_PORT, "| игра:", GAME_PORT, "| RCON:", RCON_PORT);
console.log("мод:", path.basename(TEMPLATE), "— один и тот же файл на сервере и у клиента");
console.log("после запуска сервера: npm run e2e:admin -- pair");
