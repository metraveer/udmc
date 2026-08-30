import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import minecraft from "minecraft-protocol";
import { unzipSync } from "fflate";
import { parse as parseToml } from "smol-toml";

const require = createRequire(import.meta.url);
const { ProtoDef } = require("protodef");
const root = await realpath(path.resolve(process.argv[2] || "."));
const qa = await realpath(new URL("../.qa", import.meta.url));
assert.ok(root.startsWith(qa + path.sep), "Only an isolated .qa runtime fixture is allowed");
const fixture = JSON.parse(await readFile(path.join(root, "fixture.json"), "utf8"));
assert.equal(fixture.isolatedRuntimeFixture, true);
assert.equal(new URL(fixture.url).hostname, "127.0.0.1");
assert.ok(Number.isInteger(fixture.gamePort) && fixture.gamePort > 0);
const action = process.argv[3] || "login";
const session = randomUUID();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let revision;
async function request(endpoint, { method = "GET", body, public: isPublic = false, expected = 200 } = {}) {
  const headers = isPublic ? {} : { "x-udmc-token": fixture.token, "x-udmc-session": session };
  if (method !== "GET" && !isPublic) {
    const workspace = await request("/admin/workspace");
    headers["x-udmc-revision"] = workspace.revision;
  }
  if (body && !Buffer.isBuffer(body)) { headers["content-type"] = "application/json"; body = JSON.stringify(body); }
  const response = await fetch(fixture.url + endpoint, { method, headers, body, signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, expected, `${method} ${endpoint}: ${await response.clone().text()}`);
  revision = response.headers.get("x-udmc-revision") || revision;
  return response.headers.get("content-type")?.includes("json") ? response.json() : Buffer.from(await response.arrayBuffer());
}

function loginProtocol() {
  assert.ok(minecraft.supportedVersions.includes(fixture.minecraft),
    `Protocol test library does not support ${fixture.minecraft}; use API-only actions and the real Minecraft client`);
  const proto = new ProtoDef();
  proto.addTypes(require("minecraft-data")(fixture.minecraft).protocol.types);
  proto.addType("udmcQuery", ["container", [
  { name: "protocol", type: "varint" }, { name: "pack", type: "string" },
  { name: "hash", type: "string" }, { name: "url", type: "string" }, { name: "required", type: "bool" },
]]);
  proto.addType("udmcAnswer", ["container", [
  { name: "protocol", type: "varint" }, { name: "pack", type: "string" },
  { name: "version", type: "string" }, { name: "hash", type: "string" },
  ]]);
  return proto;
}

function agentVersion(bytes) {
  const entries = unzipSync(bytes);
  return entries["fabric.mod.json"]
    ? JSON.parse(Buffer.from(entries["fabric.mod.json"]).toString()).version
    : parseToml(Buffer.from(entries["META-INF/neoforge.mods.toml"]).toString()).mods[0].version;
}

async function login(mode, reject, warning = false) {
  const proto = loginProtocol();
  const events = { query: false, joined: false, warning: false, kicked: "" };
  const client = minecraft.createClient({ host: "127.0.0.1", port: fixture.gamePort,
    username: `UDMC_${mode}`, version: fixture.minecraft, auth: "offline", profilesFolder: path.join(root, "bot") });
  client.removeAllListeners("login_plugin_request");
  client.on("ping", packet => client.write("pong", { id: packet.id }));
  if (process.env.UDMC_PROTOCOL_TRACE) client.on("packet", (packet, metadata) => console.log(metadata.state, metadata.name, packet.channel || ""));
  await new Promise((resolve, fail) => {
    let completed = false, settle;
    const finish = error => {
      if (completed) return;
      completed = true; clearTimeout(timeout); clearTimeout(settle);
      client.end("UDMC isolated test finished");
      error ? fail(error) : resolve();
    };
    const timeout = setTimeout(() => finish(new Error(`Login timed out: ${mode} ${JSON.stringify(events)}`)), 20000);
    client.on("error", finish);
    client.on("login_plugin_request", packet => {
      if (packet.channel !== "udmc_sync:login") { client.write("login_plugin_response", { messageId: packet.messageId }); return; }
      events.query = true;
      const query = proto.parsePacketBuffer("udmcQuery", packet.data).data;
      assert.equal(query.protocol, 1);
      assert.ok(query.url.endsWith("/agents/install"));
      if (mode === "silent") return;
      const data = mode === "missing" ? undefined : proto.createPacketBuffer("udmcAnswer", {
        protocol: 1, pack: mode === "other" ? "other-project" : query.pack,
        version: "0.3.0", hash: mode === "outdated" ? "0".repeat(64) : query.hash,
      });
      client.write("login_plugin_response", { messageId: packet.messageId, data });
    });
    const disconnected = packet => { events.kicked = JSON.stringify(packet.reason); finish(); };
    client.on("disconnect", disconnected);
    client.on("kick_disconnect", disconnected);
    client.on("login", () => { events.joined = true; settle = setTimeout(() => finish(), 1200); });
    client.on("system_chat", packet => {
      const content = JSON.stringify(packet);
      if (content.includes("/agents/install")) {
        events.warning = true;
        assert.ok(content.includes("open_url"), "The optional-agent notice must have a clickable installation link");
      }
    });
    client.on("end", () => { if (!completed) finish(); });
  });
  assert.equal(events.query, true, `UDMC login query was not received: ${mode}`);
  assert.equal(events.joined, !reject, JSON.stringify(events));
  if (reject) assert.ok(events.kicked.includes("/agents/install"), JSON.stringify(events));
  else assert.equal(events.warning, warning, JSON.stringify(events));
  console.log(`PASS login ${mode}: ${reject ? "rejected before world entry" : warning ? "joined with clickable instructions" : "joined without warning"}`);
}

try {
  if (action === "login" || action === "delivery") {
    if (action === "login") loginProtocol();
    const initial = await request("/admin/agents");
    assert.equal(initial.canUpdate, true, JSON.stringify(initial));
    const bytes = await readFile(path.join(root, "delivery.jar"));
    await request("/admin/agents/client", { method: "POST", body: bytes, expected: 201 });
    assert.equal(hash(await request("/agents/download", { public: true })), hash(bytes));
    console.log("PASS automatic delivery package: authenticated upload, public exact-byte download");
    await request("/admin/agents/settings", { method: "POST", body: { requireClient: true } });
    if (action === "login") {
      await login("missing", true);
      await login("other", true);
      await login("outdated", true);
      await login("silent", true);
      await login("current", false);
      await request("/admin/agents/settings", { method: "POST", body: { requireClient: false } });
      await login("missing", false, true);
    }
  } else if (action === "required" || action === "optional") {
    const state = await request("/admin/agents/settings", { method: "POST", body: { requireClient: action === "required" } });
    assert.equal(state.requireClient, action === "required");
    console.log(`PASS saved client policy: ${action}`);
  } else if (action === "update") {
    const config = await readFile(path.join(root, "server/config/udmc-sync.json"));
    const installed = path.join(root, "server/mods/udmc-sync-server.jar");
    const oldHash = hash(await readFile(installed));
    const bundle = await readFile(path.join(root, "update.zip"));
    const entries = unzipSync(bundle);
    assert.deepEqual(Object.keys(entries).sort(), ["client.jar", "server.jar"]);
    const serverHash = hash(entries["server.jar"]), clientHash = hash(entries["client.jar"]);
    const version = agentVersion(entries["server.jar"]);
    assert.equal(agentVersion(entries["client.jar"]), version);
    await writeFile(path.join(root, "before-update.json"), JSON.stringify({ configHash: hash(config), oldHash, serverHash, clientHash, version }));
    const result = await request("/admin/agents/update", { method: "POST", body: bundle, expected: 202 });
    assert.ok(["scheduled", "waiting"].includes(result.update.state), JSON.stringify(result));
    assert.equal(hash(await readFile(installed)), oldHash, "Loaded server JAR changed before shutdown");
    assert.equal(result.client.sha256, clientHash);
    assert.equal(result.client.version, version);
    assert.equal(hash(await request("/agents/download", { public: true })), clientHash);
    console.log("PASS update scheduled: the loaded JAR is unchanged until JVM exit");
    await request("/admin/server/command", { method: "POST", body: { command: "stop" } });
    const resultFile = path.join(root, "server/udmc-sync/agent-update/result.properties");
    let state = "";
    for (let i = 0; i < 60; i++) {
      state = await readFile(resultFile, "utf8").catch(() => "");
      if (/state=applied/.test(state)) break;
      await delay(1000);
    }
    assert.match(state, /state=applied/);
    assert.equal(hash(await readFile(installed)), serverHash);
    assert.notEqual(serverHash, oldHash);
    assert.equal(hash(await readFile(path.join(root, "server/udmc-sync/agent-update/previous.jar"))), oldHash);
    assert.equal(hash(await readFile(path.join(root, "server/config/udmc-sync.json"))), hash(config));
    console.log("PASS server replacement after JVM exit: exact original backup and unchanged configuration/keys");
  } else if (action === "restart" || action === "restart-api") {
    if (action === "restart") loginProtocol();
    const before = JSON.parse(await readFile(path.join(root, "before-update.json"), "utf8"));
    const state = await request("/admin/agents");
    assert.equal(state.update.state, "applied", JSON.stringify(state));
    assert.equal(state.canUpdate, true);
    assert.equal(state.currentVersion, before.version);
    assert.equal(state.client.sha256, before.clientHash);
    assert.equal(hash(await readFile(path.join(root, "server/mods/udmc-sync-server.jar"))), before.serverHash);
    assert.equal(hash(await readFile(path.join(root, "server/config/udmc-sync.json"))), before.configHash);
    await request("/admin/agents/settings", { method: "POST", body: { requireClient: true } });
    if (action === "restart") await login("current", false);
    console.log(`PASS updated packaged server restart: version ${before.version}, exact JAR, API and saved credentials${action === "restart" ? ", login mixins" : "; game login must be tested separately"}`);
  } else if (action === "stop") {
    await request("/admin/settings", { method: "POST", body: { allowRemotePowerActions: true } });
    await request("/admin/server/stop", { method: "POST", expected: 202 });
  } else throw new Error(`Unknown runtime action: ${action}`);
} finally {
  await fetch(fixture.url + "/admin/workspace/release", { method: "POST", headers: {
    "x-udmc-token": fixture.token, "x-udmc-session": session, "x-udmc-revision": revision || "",
  }, signal: AbortSignal.timeout(1500) }).catch(() => {});
}
