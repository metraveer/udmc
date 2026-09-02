// Walks the real handshake against a real running server: a protocol client joins, answers
// the question the way a given client would, and the verdict is read off the wire.
//
// It speaks the configuration-phase channel the agent actually uses, and it does not write
// the format down: channel names, protocol numbers and the field order all come from the
// agent's own source through test-support/mod-protocol.js. That is deliberate. The previous
// version of this file hard-coded the login-phase channel and protocol 1; the check moved
// phases and this harness kept asserting against a channel that no longer existed. It did
// not fail - it stopped meaning anything, and was counted as coverage for two releases.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import minecraft from "minecraft-protocol";
import { unzipSync } from "fflate";
import { parse as parseToml } from "smol-toml";
import { loginProtocol } from "./test-support/mod-protocol.js";
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

const wire = await loginProtocol();

function requireProtocolSupport() {
  assert.ok(minecraft.supportedVersions.includes(fixture.minecraft),
    `Protocol test library does not support ${fixture.minecraft}; use API-only actions and the real Minecraft client`);
}

// The wire, built from the field list the agent's payload classes declare. A field added to
// the question is picked up here instead of silently shifting every value after it.
const varint = value => {
  const out = [];
  let rest = value;
  do { let byte = rest & 0x7f; rest >>>= 7; if (rest) byte |= 0x80; out.push(byte); } while (rest);
  return Buffer.from(out);
};
const encode = (fields, values) => Buffer.concat(fields.map((field, index) => {
  if (field === "varint") return varint(values[index]);
  if (field === "bool") return Buffer.from([values[index] ? 1 : 0]);
  const text = Buffer.from(String(values[index]), "utf8");
  return Buffer.concat([varint(text.length), text]);
}));
const decode = (fields, buffer) => {
  let offset = 0;
  const readVarint = () => {
    let result = 0, shift = 0, byte;
    do { byte = buffer[offset++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return result;
  };
  return fields.map(field => {
    if (field === "varint") return readVarint();
    if (field === "bool") return buffer[offset++] === 1;
    const length = readVarint();
    const text = buffer.toString("utf8", offset, offset + length);
    offset += length;
    return text;
  });
};

/**
 * The agent jar this fixture is running, found rather than assumed. Its name has changed
 * three times; a hard-coded one stops pointing at anything and takes the check with it.
 */
async function installedAgent() {
  const mods = path.join(root, "server/mods");
  const found = (await readdir(mods)).filter(name => name.startsWith("udmc") && name.endsWith(".jar"));
  assert.equal(found.length, 1, `Exactly one UDMC agent must be installed: ${found.join(", ") || "none"}`);
  return path.join(mods, found[0]);
}

function agentVersion(bytes) {
  const entries = unzipSync(bytes);
  return entries["fabric.mod.json"]
    ? JSON.parse(Buffer.from(entries["fabric.mod.json"]).toString()).version
    : parseToml(Buffer.from(entries["META-INF/neoforge.mods.toml"]).toString()).mods[0].version;
}

/**
 * One join, played by a client of a given kind. Every value the client answers with is taken
 * from the question the server just asked, so the only thing a mode changes is the one field
 * it is about.
 */
const ANSWER = {
  current: (query, version) => [wire.protocol, query.packId, version, query.clientHash],
  // The state every new player starts in: installed, belonging to no project yet. Answering
  // with the default id instead of an empty one would let it pass for a member of any server
  // that also kept the default - installed, with nothing synced.
  unclaimed: (query, version) => [wire.protocol, "", version, ""],
  other: (query, version) => [wire.protocol, "another-project", version, ""],
  outdated: query => [wire.protocol, query.packId, "0.0.1", "0".repeat(64)],
  // A launcher that installed a newer build than the server hands out. The question is frozen,
  // so this client understands the server perfectly - and used to be turned away for it.
  ahead: query => [wire.protocol, query.packId, "99.0.0", "0".repeat(64)],
  // The version the server hands out, from a file with different bytes. Bytes are not part of
  // the verdict any more: one file serves everyone, so the same version is the same file.
  otherBuild: (query, version) => [wire.protocol, query.packId, version, "0".repeat(64)],
  incompatible: (query, version) => [wire.protocol + 1, query.packId, version, query.clientHash],
  silent: () => null,
};

/** What the player must be told, beyond being let in or turned away. */
const NOTICE = {
  current: null,
  unclaimed: { key: "udmc_sync.login.unclaimed", url: false },
  other: { key: "udmc_sync.login.foreign", url: true },
  outdated: { key: "udmc_sync.login.outdated", url: false },
  ahead: null,
  otherBuild: null,
  incompatible: { key: "udmc_sync.login.incompatible", url: true },
  silent: { key: "udmc_sync.login.missing", url: true },
};

// The version the server hands out, which is what "same version, different file" is measured
// against. Read from the server rather than from a file this fixture might not have.
let offeredVersion = "";

/**
 * What the server wrote about the joins since the last time we looked. The console reaches the
 * file through a pipe, so a verdict decided a moment ago may not be on disk yet: wanted means
 * "wait for at least one line", and draining between joins does not wait at all.
 */
const consolePath = path.join(root, "server-console.log");
let consoleRead = 0;
async function verdicts(wanted = false) {
  const deadline = Date.now() + (wanted ? 5000 : 0);
  do {
    let text = "";
    try { text = await readFile(consolePath, "utf8"); } catch { return null; }
    // The player is named by address in the configuration phase, and an address has colons in
    // it: the value is found by its own shape rather than by counting separators.
    const found = [...text.slice(consoleRead).matchAll(/UDMC login verdict for .+?: (udmc_sync\.\S+|ok)/g)].map(match => match[1]);
    if (found.length || Date.now() >= deadline) { consoleRead = text.length; return found; }
    await delay(100);
  } while (true);
}

/**
 * The verdict lands on a server tick while the player is still in the configuration phase, or
 * - if the client finished that phase inside one tick - at the door, where they are placed and
 * disconnected at once. A real client is never that fast; a bot on loopback is, and when the
 * refusal falls into the protocol switch the library can close the socket with the packet
 * still undecoded. So what the player was told is read from the server's own log, and the
 * packet is checked only when the library did surface it.
 */
async function login(mode, reject, warning = false) {
  requireProtocolSupport();
  await verdicts();
  const version = offeredVersion;
  assert.ok(version, "The offered client version must be known before a client can imitate one");
  const events = { project: false, query: false, order: [], joined: false, warning: false, kicked: "", configured: false };
  let settle, finish = () => {};
  const client = minecraft.createClient({ host: "127.0.0.1", port: fixture.gamePort,
    // Minecraft names stop at 16 characters, and a longer one fails the handshake with a
    // decoder error that reads like a protocol fault rather than a name that is too long.
    username: `UDMC_${mode}`.slice(0, 16), version: fixture.minecraft, auth: "offline", profilesFolder: path.join(root, "bot") });
  client.on("ping", packet => client.write("pong", { id: packet.id }));
  client.on("packet", (packet, metadata) => {
    // Some packets arrive with no body at all, and reading a field off one used to end the run.
    if (process.env.UDMC_PROTOCOL_TRACE) console.log(metadata.state, metadata.name, packet?.channel || "");
    // Read by packet name rather than by event, and in every phase: the refusal can arrive in
    // the configuration phase or at the door, and the two are not named the same way by every
    // protocol library. Listening for one of them left the other looking like a silent close.
    if (metadata.name === "disconnect" || metadata.name === "kick_disconnect") {
      events.kicked = JSON.stringify(packet);
      events.kickedIn = metadata.state;
      finish();
      return;
    }
    // The game's own configuration work, and the thing a refusal must come before. A player
    // who does not have the server's mods yet is thrown out by the registry check with a
    // message of the game's own - so if any of this has been sent by the time UDMC refuses
    // someone, then on a server with mods UDMC would never get to say anything at all, and
    // the player could never accept the project that would have given them those mods.
    if (metadata.name === "registry_data" || metadata.name === "select_known_packs") events.configured = true;
    // Fabric API synchronises registries in a task of its own, ahead of the game's, on a
    // channel of its own - and that is the check whose "unknown registry entries" a new
    // player used to meet instead of UDMC's question. It counts as configuration too.
    if (metadata.name === "custom_payload" && /registry/.test(String(packet?.channel))) events.configured = true;
    // Entering the world is the play state beginning, not the login handshake succeeding.
    // The verdict is reached in the configuration phase, which comes after login success:
    // taking that for arrival made every rejected client look as though it had got in.
    if (metadata.state === "play" && !events.joined) {
      events.joined = true;
      settle = setTimeout(() => finish(), 1500);
    }
  });
  await new Promise((resolve, fail) => {
    let completed = false;
    finish = error => {
      if (completed) return;
      completed = true; clearTimeout(timeout); clearTimeout(settle);
      client.end("UDMC isolated test finished");
      error ? fail(error) : resolve();
    };
    // A verdict costs one round trip now, including for a client that never answers: the
    // question is followed by a ping, and the ping comes back whether UDMC is there or not.
    const timeout = setTimeout(() => finish(new Error(`Login timed out: ${mode} ${JSON.stringify(events)}`)), 25000);
    client.on("error", finish);
    client.on("custom_payload", packet => {
      const channel = packet.channel;
      if (channel !== wire.channels.query && channel !== wire.channels.project) return;
      events.order.push(channel);
      const data = Buffer.from(packet.data);
      if (channel === wire.channels.project) {
        const [, packId, , apiUrl] = decode(wire.fields.project, data);
        assert.ok(packId && apiUrl, `The offered project must name itself and where it lives: ${packId} ${apiUrl}`);
        events.project = true;
        return;
      }
      const [protocol, packId, clientHash, url, required] = decode(wire.fields.query, data);
      events.query = true;
      assert.equal(protocol, wire.queryProtocol, "The question must keep the frozen protocol number");
      assert.ok(url.endsWith("/udmc"), `The question must carry an address a player can retype: ${url}`);
      assert.equal(typeof required, "boolean");
      const answer = ANSWER[mode]({ packId, clientHash }, version);
      if (answer) client.write("custom_payload", { channel: wire.channels.answer, data: encode(wire.fields.answer, answer) });
    });
    // Recognised by the notice's own key, not by the address inside it: the reason given to a
    // client that only has to accept a project carries no address at all any more.
    client.on("system_chat", packet => {
      const content = JSON.stringify(packet);
      if (!content.includes("udmc_sync.login.")) return;
      events.warning = true;
      events.notice = content;
    });
    client.on("end", () => { if (!completed) finish(); });
  });

  // The offer has to arrive before the question. A client that has never seen this server
  // needs to know who is asking before it answers, and the player who is then turned away
  // has to find that offer waiting for them.
  assert.equal(events.project, true, `The project was never offered: ${mode} ${JSON.stringify(events)}`);
  assert.equal(events.order[0], wire.channels.project, `The offer must precede the question: ${events.order.join(", ")}`);
  assert.equal(events.query, true, `The question was never asked: ${mode}`);
  const notice = NOTICE[mode];
  // The server's own record of what it decided. The protocol library can lose the refusal on
  // the configuration-to-play switch; this line cannot be lost, and it is what an owner reads
  // when a player sends them a screenshot.
  const decided = await verdicts(true);
  if (decided !== null) {
    const expected = reject || warning ? notice.key : "ok";
    assert.ok(decided.includes(expected),
      `The server must record its verdict as ${expected}, not ${decided.join(", ") || "nothing"}`);
  }
  if (!reject) assert.equal(events.joined, true, `A correct client must reach the world: ${JSON.stringify(events)}`);
  if (reject) {
    // Where the refusal happens is not a detail: the check holds the configuration phase open
    // and nothing else has been sent yet, so the refusal is the next thing the client reads.
    // Sent any later it competes with the game's own reasons for ending the connection - and
    // on a server whose mods the player does not have yet, it loses that race every time.
    assert.equal(events.configured, false,
      `UDMC must refuse before the game configures anything: ${JSON.stringify(events)}`);
    assert.equal(events.joined, false, `A refused client must never reach the world: ${JSON.stringify(events)}`);
    assert.equal(events.kickedIn, "configuration",
      `The refusal must arrive in the configuration phase, not ${events.kickedIn || "nowhere"}`);
    assert.ok(events.kicked.includes(notice.key), `The refusal must name why: expected ${notice.key} in ${events.kicked}`);
    // A player whose file is already the right one is not sent to download it again.
    assert.equal(events.kicked.includes("/udmc"), notice.url,
      `${notice.key} ${notice.url ? "must" : "must not"} send the player to the install page: ${events.kicked}`);
  } else {
    assert.equal(events.warning, warning, JSON.stringify(events));
    if (warning) {
      assert.ok(events.notice.includes(notice.key), `The notice in chat must say the same thing the refusal would: ${events.notice}`);
      // Where a player is sent to fetch a file, the address has to be clickable: on this
      // screen retyping it is the alternative.
      if (notice.url) assert.ok(events.notice.includes("open_url"), "An address shown in chat must be clickable");
    }
  }
  console.log(`PASS login ${mode}: ${reject ? `turned away with ${notice.key} in the ${events.kickedIn} phase, before the game configured anything`
    : warning ? `joined and told why (${notice.key})` : "joined without a notice"}`);
  return true;
}

try {
  if (action === "login" || action === "delivery") {
    if (action === "delivery") {
      const initial = await request("/admin/agents");
      assert.equal(initial.canUpdate, true, JSON.stringify(initial));
      const bytes = await readFile(path.join(root, "delivery.jar"));
      await request("/admin/agents/client", { method: "POST", body: bytes, expected: 201 });
      assert.equal(hash(await request("/agents/download", { public: true })), hash(bytes));
      console.log("PASS automatic delivery package: authenticated upload, public exact-byte download");
    }
    await request("/admin/agents/settings", { method: "POST", body: { requireClient: true } });
    if (action === "login") {
      requireProtocolSupport();
      // A server publishes the file it runs, so there is nothing to upload first: what
      // players download is what the server started with, and the question is asked about it.
      const agents = await request("/admin/agents");
      assert.ok(agents.client?.sha256, `The server must publish its own file before it can ask about one: ${JSON.stringify(agents)}`);
      offeredVersion = agents.client.version;
      // Every verdict a player can receive, walked over the wire against a running server.
      for (const mode of ["unclaimed", "other", "outdated", "incompatible", "silent"]) await login(mode, true);
      await login("current", false);
      // Neither of these may be turned away: one is ahead of the server, the other is the
      // same version from a different build. Both used to be refused on an exact hash.
      await login("ahead", false);
      await login("otherBuild", false);
      // With the rule off nothing is turned away: the same wrong client gets in and is told
      // what to do there, which is the only reason it ever reaches the instructions.
      await request("/admin/agents/settings", { method: "POST", body: { requireClient: false } });
      await login("unclaimed", false, true);
      await login("silent", false, true);
      await request("/admin/agents/settings", { method: "POST", body: { requireClient: true } });
    }
  } else if (action === "required" || action === "optional") {
    const state = await request("/admin/agents/settings", { method: "POST", body: { requireClient: action === "required" } });
    assert.equal(state.requireClient, action === "required");
    console.log(`PASS saved client policy: ${action}`);
  } else if (action === "update") {
    const config = await readFile(path.join(root, "server/config/udmc-sync.json"));
    const installed = await installedAgent();
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
    assert.equal(hash(await readFile(await installedAgent())), before.serverHash);
    assert.equal(hash(await readFile(path.join(root, "server/config/udmc-sync.json"))), before.configHash);
    await request("/admin/agents/settings", { method: "POST", body: { requireClient: true } });
    if (action === "restart") await login("current", false);
    console.log(`PASS updated packaged server restart: version ${before.version}, exact JAR, API and saved credentials${action === "restart" ? ", login mixins" : "; game login must be tested separately"}`);
  } else if (action === "stop") {
    // No switch to flip first: a request with a fresh revision reaches the runtime itself.
    await request("/admin/server/stop", { method: "POST", expected: 202 });
  } else throw new Error(`Unknown runtime action: ${action}`);
} finally {
  await fetch(fixture.url + "/admin/workspace/release", { method: "POST", headers: {
    "x-udmc-token": fixture.token, "x-udmc-session": session, "x-udmc-revision": revision || "",
  }, signal: AbortSignal.timeout(1500) }).catch(() => {});
}
