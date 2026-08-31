// Drives the end-to-end stand through its admin API: publish the client agent, set the
// login rule, and report what the server thinks the world looks like.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(".qa/fabric-26.2-e2e");
const fixture = JSON.parse(readFileSync(path.join(ROOT, "fixture.json"), "utf8"));
const session = randomUUID();

async function api(endpoint, { method = "GET", body, type } = {}) {
  const headers = { "x-udmc-token": fixture.token, "x-udmc-session": session };
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

// One process holds one session, so the workspace lease travels with it and is released
// at the end - the way Control behaves, instead of parking a 90-second lock per command.
for (const action of process.argv.slice(2).filter(a => a !== "status")) {
  if (action.startsWith("publish-client")) {
    const jar = readFileSync(action.includes("=") ? action.split("=")[1] : path.join(ROOT, "client-agent.jar"));
    const result = await api("/admin/agents/client", { method: "POST", body: jar, type: "application/octet-stream" });
    console.log("клиент опубликован:", result.client?.version, "| ссылка:", result.downloadUrl);
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
    ссылка: agents.downloadUrl,
  }, null, 1));
}
