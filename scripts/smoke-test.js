import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createSyncServer } from "../apps/sync-server/src/server.js";

const ADMIN_TOKEN = "smoke-token";

let tempRoot;
let server;

try {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "udmc-smoke-"));
  const dataDir = path.join(tempRoot, "data");

  server = createSyncServer({
    dataDir,
    adminToken: ADMIN_TOKEN
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const jarBody = Buffer.from("fake jar payload for smoke test\n", "utf8");

  const upload = await adminUpload(serverUrl, "mods/example.jar", "both", jarBody);
  await adminUpload(serverUrl, "mods/server-only.jar", "server", Buffer.from("server only\n", "utf8"));
  assert.equal((await getJson(serverUrl, "/manifest")).files.length, 0, "Uploads must not change the public manifest");
  assert.equal((await adminList(serverUrl)).changes.added, 2);
  await adminPublish(serverUrl, "0.1.1");

  const manifest = await getJson(serverUrl, "/manifest");

  if (manifest.pack.version !== "0.1.1") {
    throw new Error(`Expected version 0.1.1, got ${manifest.pack.version}`);
  }

  if (manifest.files.length !== 2) {
    throw new Error(`Expected 2 files, got ${manifest.files.length}`);
  }

  const downloaded = await getBytes(serverUrl, upload.file.downloadPath);

  if (Buffer.compare(Buffer.from(downloaded), jarBody) !== 0) {
    throw new Error("Downloaded file content does not match uploaded content.");
  }

  const list = await adminList(serverUrl);

  if (list.files.length !== 2) {
    throw new Error(`Expected admin list to contain 2 files, got ${list.files.length}`);
  }
  assert.equal(list.changes.dirty, false);

  await adminDelete(serverUrl, "mods/example.jar");
  assert.equal((await getJson(serverUrl, "/manifest")).files.length, 2);
  assert.equal((await adminList(serverUrl)).files.find((file) => file.path === "mods/example.jar").change, "removed");
  await adminPost(serverUrl, "/admin/files/revert", { path: "mods/example.jar" });
  assert.equal((await adminList(serverUrl)).changes.dirty, false);

  await adminPost(serverUrl, "/admin/files/update", { path: "mods/example.jar", side: "client" });
  assert.equal((await getJson(serverUrl, "/manifest")).files.find((file) => file.path === "mods/example.jar").side, "both");
  await adminUpload(serverUrl, "config/nested/settings.json", "both", Buffer.from("{}"));
  await adminDelete(serverUrl, "mods/server-only.jar");
  const changes = (await adminList(serverUrl)).changes;
  assert.deepEqual([changes.added, changes.updated, changes.removed], [1, 1, 1]);
  await adminPublish(serverUrl);
  const nextRelease = await getJson(serverUrl, "/manifest");
  assert.equal(nextRelease.pack.version, "0.1.2");
  assert.equal(nextRelease.files.length, 2);
  assert.equal(nextRelease.files.find((file) => file.path === "mods/example.jar").side, "client");

  await adminPost(serverUrl, "/admin/files/update", { path: "config/nested/settings.json", newPath: "resourcepacks/nested/settings.json", side: "client" });
  assert.equal((await adminList(serverUrl)).changes.total, 2);
  await adminPost(serverUrl, "/admin/draft/reset", {});
  assert.equal((await adminList(serverUrl)).changes.dirty, false);

  await Promise.all(Array.from({ length: 8 }, (_, index) => adminUpload(serverUrl, `config/concurrent-${index}.json`, "client", Buffer.from("{}"))));
  assert.equal((await adminList(serverUrl)).changes.added, 8, "Concurrent uploads must not lose files");
  assert.equal((await getJson(serverUrl, "/manifest")).files.length, 2);
  await assert.rejects(() => adminUpload(serverUrl, "config/CONCURRENT-0.json", "client", Buffer.from("{}")));
  await assert.rejects(() => adminPublish(serverUrl, "invalid version"));
  await adminPost(serverUrl, "/admin/draft/reset", {});
  assert.equal((await adminList(serverUrl)).changes.dirty, false);
  await assert.rejects(() => adminPublish(serverUrl));
  await assert.rejects(() => adminUpload(serverUrl, "config/udmc-sync.json", "both", Buffer.from("{}")));
  const unicodePath = "config/\u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438.json";
  await adminUpload(serverUrl, unicodePath, "client", Buffer.from("{}"));
  assert.ok((await adminList(serverUrl)).draft.files.some((file) => file.path === unicodePath));
  await adminPost(serverUrl, "/admin/draft/reset", {});
  assert.equal((await fetch(new URL("/admin/files", serverUrl))).status, 401);

  const status = await adminGet(serverUrl, "/admin/status");

  if (status.minecraftVersion !== "26.2" || status.performance.tps !== 20) {
    throw new Error("Server status endpoint returned unexpected values.");
  }

  const command = await adminPost(serverUrl, "/admin/server/command", { command: "list" });

  if (!command.output.includes("0 of a max of 20")) {
    throw new Error("Server command endpoint returned an unexpected response.");
  }

  console.log("Smoke test passed.");
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function adminUpload(serverUrl, remotePath, side, body) {
  const url = new URL("/admin/files", serverUrl);
  url.searchParams.set("path", remotePath);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-udmc-token": ADMIN_TOKEN,
      "x-udmc-side": side
    },
    body
  });

  return readJsonResponse(response, "Upload failed");
}

async function adminPublish(serverUrl, version) {
  const response = await fetch(new URL("/admin/publish", serverUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-udmc-token": ADMIN_TOKEN
    },
    body: JSON.stringify({ version })
  });

  return readJsonResponse(response, "Publish failed");
}

async function adminDelete(serverUrl, managedPath) {
  const url = new URL("/admin/files", serverUrl);
  url.searchParams.set("path", managedPath);
  const response = await fetch(url, { method: "DELETE", headers: { "x-udmc-token": ADMIN_TOKEN } });
  return readJsonResponse(response, "Admin delete failed");
}

async function adminList(serverUrl) {
  const response = await fetch(new URL("/admin/files", serverUrl), {
    headers: {
      "x-udmc-token": ADMIN_TOKEN
    }
  });

  return readJsonResponse(response, "Admin list failed");
}

async function adminGet(serverUrl, pathname) {
  const response = await fetch(new URL(pathname, serverUrl), {
    headers: {
      "x-udmc-token": ADMIN_TOKEN
    }
  });

  return readJsonResponse(response, "Admin GET failed");
}

async function adminPost(serverUrl, pathname, body) {
  const response = await fetch(new URL(pathname, serverUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-udmc-token": ADMIN_TOKEN
    },
    body: JSON.stringify(body)
  });

  return readJsonResponse(response, "Admin POST failed");
}

async function getJson(serverUrl, pathname) {
  const response = await fetch(new URL(pathname, serverUrl));
  return readJsonResponse(response, "GET failed");
}

async function getBytes(serverUrl, pathname) {
  const response = await fetch(new URL(pathname, serverUrl));

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${await response.text()}`);
  }

  return response.arrayBuffer();
}

async function readJsonResponse(response, label) {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${label}: ${response.status} ${text}`);
  }

  return JSON.parse(text);
}
