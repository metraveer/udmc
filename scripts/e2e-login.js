// Walks the player's path end to end, unattended: builds a stand, starts a real Minecraft
// server running the same mod file players install, claims it the way the panel does, joins
// as every kind of client there is, and stops the server again.
//
// This exists because the handshake is where the expensive bugs live and where no unit test
// reaches. It used to be walked by hand, on a stand someone remembered to raise - which is
// how a check could go on speaking a channel the agent had abandoned two releases earlier
// without anybody noticing.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

const version = process.argv[2] || "1.21.1";
const root = path.resolve(".qa", `fabric-${version}-e2e`);
const windows = process.platform === "win32";

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(windows ? "cmd.exe" : command, windows ? ["/d", "/c", command, ...args] : args, { stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)));
});

const fixture = async () => JSON.parse(await readFile(path.join(root, "fixture.json"), "utf8"));

console.log(`[e2e] stand for Minecraft ${version}`);
await run("node", ["scripts/e2e-stand.js", version]);
const { url } = await fixture();

const gradle = path.resolve("minecraft/udmc-sync-fabric", windows ? "gradlew.bat" : "gradlew");
const server = spawn(windows ? "cmd.exe" : gradle,
  (windows ? ["/d", "/c", gradle] : []).concat(["runServer", `-Pminecraft_version=${version}`,
    "-Pudmc_packaged_test", `-Pudmc_run_dir=${path.join(root, "server")}`]),
  { cwd: path.resolve("minecraft/udmc-sync-fabric"), stdio: ["ignore", "pipe", "pipe"] });
// The console goes to a file inside the stand as well as to ours: the verdict for every join
// is written there, and reading it is how the check knows what the player was told even when
// the protocol library loses the packets on the phase switch.
const consoleLog = createWriteStream(path.join(root, "server-console.log"));
server.stdout.pipe(consoleLog); server.stderr.pipe(consoleLog);
server.stdout.pipe(process.stdout); server.stderr.pipe(process.stdout);
let serverExit = null;
server.on("exit", code => { serverExit = code; });

/** The API belongs to the agent, so an answer from it means the mod loaded and made a project. */
async function waitForServer() {
  const deadline = Date.now() + 7 * 60_000;
  while (Date.now() < deadline) {
    if (serverExit !== null) throw new Error(`The server exited before it was ready (${serverExit})`);
    try {
      if ((await fetch(url + "/health", { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch { /* not up yet */ }
    await delay(2000);
  }
  throw new Error("The server did not open its API within seven minutes");
}

/**
 * Stops it through the API rather than by killing the process: that is the request the panel
 * sends, so a broken one fails here instead of in front of an owner.
 */
async function stopServer() {
  try {
    const { url: api, token } = await fixture();
    // A session id the workspace will accept: it insists on 16 to 80 characters, and a short
    // one is refused as "no session at all" - a 428 that reads like a missing revision.
    const headers = { "x-udmc-token": token, "x-udmc-session": randomUUID() };
    const workspace = await (await fetch(api + "/admin/workspace", { headers, signal: AbortSignal.timeout(5000) })).json();
    await fetch(api + "/admin/server/stop", { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { ...headers, "content-type": "application/json", "x-udmc-revision": workspace.revision },
      body: JSON.stringify({ delaySeconds: 0 }) });
  } catch (error) {
    console.warn("[e2e] the API did not take the stop request, ending the process instead:", error.message);
    server.kill();
  }
  const deadline = Date.now() + 90_000;
  while (serverExit === null && Date.now() < deadline) await delay(1000);
  if (serverExit === null) server.kill();
}

let failure = null;
try {
  await waitForServer();
  console.log("[e2e] server up; claiming it the way the panel does");
  await run("node", ["scripts/e2e-admin.js", "pair", version]);
  console.log("[e2e] joining as every kind of client");
  await run("node", ["scripts/runtime-agent-check.js", root, "login"]);
} catch (error) {
  failure = error;
} finally {
  await stopServer();
}

if (failure) {
  console.error("[e2e] failed:", failure.message);
  process.exitCode = 1;
} else {
  console.log("[e2e] the whole login matrix passed against a real server");
}
