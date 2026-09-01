// Drives the end-to-end stand the way Control drives a real server: claim it with the pairing
// code, tell it its own public address, set the login rule, and report what it thinks the world
// looks like. Every step here is one the panel performs, so a failure here is a failure there.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// The stand's game version, not a constant: hard-coding one made every command silently
// address a stand that might not be the one running. Pass it after the action.
const VERSION = process.argv.slice(2).find(argument => /^\d/.test(argument)) || "26.2";
const ROOT = path.resolve(".qa", `fabric-${VERSION}-e2e`);
const FIXTURE = path.join(ROOT, "fixture.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
const session = randomUUID();

async function api(endpoint, { method = "GET", body, type } = {}) {
  const headers = { "x-udmc-session": session };
  if (fixture.token) headers["x-udmc-token"] = fixture.token;
  if (method !== "GET") {
    const workspace = await api("/admin/workspace");
    headers["x-udmc-revision"] = workspace.revision;
    headers["content-type"] = type || "application/json";
  }
  const response = await fetch(fixture.url + endpoint, {
    method, headers, body: body && (type ? body : JSON.stringify(body)), signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${endpoint} -> ${response.status} ${text.slice(0, 300)}`);
  return text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
}

/** Claims the server with the code it wrote for its owner, exactly as the panel would. */
async function pair() {
  const note = readFileSync(path.join(ROOT, "server/config/udmc-pairing.txt"), "utf8");
  const code = /\b[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}\b/.exec(note)?.[0];
  if (!code) throw new Error("В записке привязки нет кода:\n" + note);
  const response = await fetch(fixture.url + "/pair", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }), signal: AbortSignal.timeout(30000),
  });
  const project = await response.json();
  if (!response.ok) throw new Error(`привязка отклонена: ${response.status} ${JSON.stringify(project)}`);
  fixture.token = project.adminToken;
  fixture.packId = project.packId;
  fixture.publicKey = project.manifestPublicKey;
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n");
  console.log("привязано:", project.packId, "| отпечаток:", project.fingerprint.slice(0, 16), "...");
  // A server cannot know its own public address; the panel sends the one that just reached it.
  await api("/admin/agents/settings", { method: "POST", body: { serverUrl: fixture.url } });
  console.log("адрес для игроков:", fixture.url);
}

// One process holds one session, so the workspace lease travels with it and is released
// at the end - the way Control behaves, instead of parking a 90-second lock per command.
for (const action of process.argv.slice(2).filter(a => a !== "status" && a !== VERSION)) {
  if (action === "pair") {
    await pair();
  } else if (action.startsWith("require")) {
    const result = await api("/admin/agents/settings", { method: "POST", body: { requireClient: !action.endsWith("off") } });
    console.log("вход только с клиентом:", result.requireClient);
  }
}
try { await api("/admin/workspace/release", { method: "POST", body: {} }); } catch { /* Nothing held. */ }
{
  const agents = await api("/admin/agents");
  console.log(JSON.stringify({
    проект: agents.packId, версияАгента: agents.currentVersion,
    раздаётсяКлиент: agents.client?.version || null, требоватьКлиент: agents.requireClient,
    адресДляИгроков: agents.serverUrl, ссылка: agents.downloadUrl,
  }, null, 1));
}
