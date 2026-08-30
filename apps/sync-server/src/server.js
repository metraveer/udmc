import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertValidSide,
  bumpPatchVersion,
  makeDefaultManifest,
  normalizeManagedPath,
  readJsonFile,
  sortManifestFiles,
  writeJsonFileAtomic
} from "../../../packages/core/src/manifest.js";

const DEFAULT_PORT = 3077;
const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const BLOB_NAME_PATTERN = /^[a-f0-9]{64}(\.[A-Za-z0-9_-]{1,16})?$/;

export function createAppContext(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.UDMC_DATA_DIR || "./data");

  return {
    dataDir,
    blobsDir: path.join(dataDir, "blobs"),
    manifestPath: path.join(dataDir, "manifest.json"),
    draftPath: path.join(dataDir, "draft.json"),
    adminToken: options.adminToken ?? process.env.UDMC_ADMIN_TOKEN ?? null,
    maxUploadBytes: Number(options.maxUploadBytes || process.env.UDMC_MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES),
    allowRemotePowerActions: Boolean(options.allowRemotePowerActions),
    storeQueue: Promise.resolve(),
    startedAt: Date.now()
  };
}

export function createSyncServer(options = {}) {
  const context = createAppContext(options);

  return createServer(async (request, response) => {
    setBaseHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/") {
        sendJson(response, 200, {
          service: "udmc-sync-server",
          role: "api-only",
          endpoints: ["/health", "/manifest", "/files/<sha256>"]
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "udmc-sync-server"
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/manifest") {
        const manifest = await withStoreLock(context, () => loadPublishedManifest(context));
        sendJson(response, 200, manifest);
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/files/")) {
        await handleFileDownload(response, context, url.pathname);
        return;
      }

      if (url.pathname.startsWith("/admin/")) {
        if (!requireAdmin(request, response, context)) {
          return;
        }

        if (request.method === "GET" && url.pathname === "/admin/files") {
          sendJson(response, 200, await withStoreLock(context, () => loadDraftState(context)));
          return;
        }

        if (request.method === "GET" && url.pathname === "/admin/status") {
          await withStoreLock(context, () => handleAdminStatus(response, context));
          return;
        }
        if (request.method === "GET" && url.pathname === "/admin/server/commands") {
          sendJson(response, 200, { source: "development", minecraftVersion: "26.2", commands: [
            { name: "help", usage: ["help [<command>]"] }, { name: "list", usage: ["list [uuids]"] },
            { name: "save-all", usage: ["save-all [flush]"] }, { name: "whitelist", usage: ["whitelist list", "whitelist add <targets>", "whitelist remove <targets>"] },
            { name: "stop", usage: ["stop"] }, { name: "examplemod:status", usage: ["examplemod:status"] }
          ] });
          return;
        }
        if (request.method === "GET" && url.pathname === "/admin/server/files") {
          sendJson(response, 200, { files: [], truncated: false });
          return;
        }

        if (request.method === "POST" && url.pathname === "/admin/files") {
          await withStoreLock(context, () => handleAdminUpload(request, response, context, url));
          return;
        }

        if (request.method === "DELETE" && url.pathname === "/admin/files") {
          await withStoreLock(context, () => handleAdminDelete(response, context, url));
          return;
        }

        if (request.method === "POST" && url.pathname === "/admin/files/update") {
          await withStoreLock(context, () => handleAdminFileUpdate(request, response, context));
          return;
        }

        if (request.method === "POST" && url.pathname === "/admin/files/revert") {
          await withStoreLock(context, () => handleAdminFileRevert(request, response, context));
          return;
        }

        if (request.method === "POST" && url.pathname === "/admin/draft/reset") {
          await withStoreLock(context, async () => {
            await saveDraftManifest(context, clone(await loadPublishedManifest(context)));
            sendJson(response, 200, await loadDraftState(context));
          });
          return;
        }

        if (request.method === "POST" && url.pathname === "/admin/publish") {
          await withStoreLock(context, () => handleAdminPublish(request, response, context));
          return;
        }

        if (request.method === "POST" && url.pathname === "/admin/settings") {
          await withStoreLock(context, () => handleAdminSettings(request, response, context));
          return;
        }

        if (request.method === "POST" && url.pathname === "/admin/server/command") {
          await handleAdminCommand(request, response);
          return;
        }

        if (request.method === "POST" && (url.pathname === "/admin/server/restart" || url.pathname === "/admin/server/stop")) {
          handleAdminPowerAction(response, context, url.pathname.endsWith("/restart") ? "restart" : "stop");
          return;
        }
      }

      sendJson(response, 404, {
        error: "Not found"
      });
    } catch (error) {
      sendJson(response, 500, {
        error: error.message || "Internal server error"
      });
    }
  });
}

export async function startFromEnv() {
  const host = process.env.UDMC_HOST || "127.0.0.1";
  const port = Number(process.env.UDMC_PORT || DEFAULT_PORT);
  const server = createSyncServer();

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });

  console.log(`UDMC sync server listening on http://${host}:${port}`);
}

async function ensureData(context) {
  await mkdir(context.blobsDir, { recursive: true });

  try {
    await access(context.manifestPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await writeJsonFileAtomic(context.manifestPath, makeDefaultManifest());
  }

  try {
    await access(context.draftPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await writeJsonFileAtomic(context.draftPath, clone(await readJsonFile(context.manifestPath, makeDefaultManifest())));
  }
}

async function loadPublishedManifest(context) {
  await ensureData(context);
  return readJsonFile(context.manifestPath, makeDefaultManifest());
}

async function loadDraftManifest(context) {
  await ensureData(context);
  return readJsonFile(context.draftPath);
}

async function savePublishedManifest(context, manifest) {
  manifest.files = sortManifestFiles(manifest.files || []);
  await writeJsonFileAtomic(context.manifestPath, manifest);
}

async function saveDraftManifest(context, manifest) {
  manifest.files = sortManifestFiles(manifest.files || []);
  await writeJsonFileAtomic(context.draftPath, manifest);
}

async function handleFileDownload(response, context, pathname) {
  const blobName = decodeURIComponent(pathname.slice("/files/".length));

  if (!BLOB_NAME_PATTERN.test(blobName)) {
    sendJson(response, 400, {
      error: "Invalid file name"
    });
    return;
  }

  const blobPath = path.join(context.blobsDir, blobName);
  let content;

  try {
    content = await readFile(blobPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, {
        error: "File not found"
      });
      return;
    }

    throw error;
  }

  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": content.length,
    "cache-control": "public, max-age=31536000, immutable"
  });
  response.end(content);
}

async function handleAdminUpload(request, response, context, url) {
  const managedPath = normalizeManagedPath(
    request.headers["x-udmc-path"] || url.searchParams.get("path")
  );
  const side = assertValidSide(request.headers["x-udmc-side"] || url.searchParams.get("side") || "both");
  const body = await collectBody(request, context.maxUploadBytes);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const extension = getSafeExtension(managedPath);
  const blobName = `${sha256}${extension}`;
  const blobPath = path.join(context.blobsDir, blobName);

  await mkdir(context.blobsDir, { recursive: true });
  await writeFile(blobPath, body);

  const manifest = await loadDraftManifest(context);
  assertUniquePath(manifest, managedPath);
  const now = new Date().toISOString();
  const entry = {
    path: managedPath,
    side,
    sha256,
    size: body.length,
    downloadPath: `/files/${blobName}`,
    updatedAt: now
  };

  manifest.files = [
    ...(manifest.files || []).filter((file) => file.path !== managedPath),
    entry
  ];
  await saveDraftManifest(context, manifest);

  sendJson(response, 201, {
    file: entry
  });
}

async function handleAdminDelete(response, context, url) {
  const managedPath = normalizeManagedPath(url.searchParams.get("path"));
  const manifest = await loadDraftManifest(context);
  const before = manifest.files.length;
  manifest.files = manifest.files.filter((file) => file.path !== managedPath);
  await saveDraftManifest(context, manifest);

  sendJson(response, 200, {
    removed: before - manifest.files.length,
    path: managedPath
  });
}

async function handleAdminFileUpdate(request, response, context) {
  const body = await collectJsonBody(request);
  const currentPath = normalizeManagedPath(body.path);
  const nextPath = normalizeManagedPath(body.newPath || currentPath);
  const side = assertValidSide(body.side);
  const draft = await loadDraftManifest(context);
  const entry = draft.files.find((file) => file.path === currentPath);

  if (!entry) {
    throw new Error(`Draft file not found: ${currentPath}`);
  }

  assertUniquePath(draft, nextPath, currentPath);

  entry.path = nextPath;
  entry.side = side;
  entry.updatedAt = new Date().toISOString();
  await saveDraftManifest(context, draft);
  sendJson(response, 200, { file: entry });
}

async function handleAdminFileRevert(request, response, context) {
  const body = await collectJsonBody(request);
  const managedPath = normalizeManagedPath(body.path);
  const published = await loadPublishedManifest(context);
  const draft = await loadDraftManifest(context);
  const publishedFile = published.files.find((file) => file.path === managedPath);

  draft.files = draft.files.filter((file) => file.path !== managedPath);
  if (publishedFile) {
    draft.files.push(clone(publishedFile));
  }

  await saveDraftManifest(context, draft);
  sendJson(response, 200, buildDraftState(published, draft));
}

async function handleAdminPublish(request, response, context) {
  const published = await loadPublishedManifest(context);
  const draft = await loadDraftManifest(context);
  const state = buildDraftState(published, draft);
  if (!state.changes.dirty) {
    throw new Error("Draft has no changes.");
  }
  await validateDraftBlobs(context, draft);
  const body = await collectJsonBody(request);
  const version = body.version ? String(body.version).trim() : bumpPatchVersion(published.pack.version);

  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) {
    throw new Error("Invalid pack version.");
  }

  draft.pack.version = version;
  draft.releaseSequence = (published.releaseSequence || 0) + 1;
  draft.publishedAt = new Date().toISOString();
  await savePublishedManifest(context, draft);
  await saveDraftManifest(context, clone(draft));

  sendJson(response, 200, {
    pack: draft.pack,
    publishedAt: draft.publishedAt
  });
}

async function handleAdminSettings(request, response, context) {
  const manifest = await loadPublishedManifest(context);
  const draft = await loadDraftManifest(context);
  const body = await collectJsonBody(request);

  if (body.packName !== undefined) {
    manifest.pack.name = requireNonEmptyString(body.packName, "packName");
    draft.pack.name = manifest.pack.name;
  }

  if (body.allowRemotePowerActions !== undefined) {
    context.allowRemotePowerActions = Boolean(body.allowRemotePowerActions);
  }

  await savePublishedManifest(context, manifest);
  await saveDraftManifest(context, draft);

  sendJson(response, 200, {
    pack: manifest.pack,
    minecraft: manifest.minecraft,
    allowRemotePowerActions: context.allowRemotePowerActions
  });
}

async function handleAdminStatus(response, context) {
  const manifest = await loadPublishedManifest(context);
  const memory = process.memoryUsage();

  sendJson(response, 200, {
    state: "online",
    motd: "UDMC development server",
    gamePort: 25565,
    minecraftVersion: manifest.minecraft.version,
    loader: manifest.minecraft.loader,
    javaVersion: process.version,
    uptimeSeconds: Math.floor((Date.now() - context.startedAt) / 1000),
    worlds: 1,
    players: {
      online: 0,
      max: 20,
      names: []
    },
    performance: {
      tps: 20,
      averageTickMs: 1.35,
      memoryUsedBytes: memory.heapUsed,
      memoryMaxBytes: memory.heapTotal
    },
    rcon: {
      enabled: false,
      port: 25575
    },
    capabilities: {
      commands: true,
      powerActions: context.allowRemotePowerActions
    }
  });
}

async function handleAdminCommand(request, response) {
  const body = await collectJsonBody(request);
  const command = String(body.command || "").trim().replace(/^\/+/, "");

  if (!command || command.length > 512 || /[\r\n]/.test(command)) {
    sendJson(response, 400, { error: "Invalid server command" });
    return;
  }

  const outputs = {
    help: "Available commands: help, list, save-all, whitelist, say, time, weather, stop",
    list: "There are 0 of a max of 20 players online:"
  };

  sendJson(response, 200, {
    command,
    output: outputs[command] || `[development] Executed: ${command}`
  });
}

function handleAdminPowerAction(response, context, action) {
  if (!context.allowRemotePowerActions) {
    sendJson(response, 403, { error: "Remote power actions are disabled" });
    return;
  }

  sendJson(response, 202, {
    accepted: true,
    action
  });
}

async function loadDraftState(context) {
  return buildDraftState(
    await loadPublishedManifest(context),
    await loadDraftManifest(context)
  );
}

function withStoreLock(context, operation) {
  const result = context.storeQueue.then(operation);
  context.storeQueue = result.catch(() => {});
  return result;
}

function assertUniquePath(manifest, nextPath, currentPath = nextPath) {
  if (manifest.files.some((file) => file.path !== currentPath && file.path.toLowerCase() === nextPath.toLowerCase())) {
    throw new Error(`A draft file already uses path: ${nextPath}`);
  }
}

function buildDraftState(published, draft) {
  const publishedFiles = new Map((published.files || []).map((file) => [file.path, file]));
  const draftFiles = new Map((draft.files || []).map((file) => [file.path, file]));
  const paths = [...new Set([...publishedFiles.keys(), ...draftFiles.keys()])].sort();
  const changes = {
    added: 0,
    updated: 0,
    removed: 0,
    total: 0,
    dirty: false,
    serverRestartRecommended: false
  };

  const files = paths.map((managedPath) => {
    const publishedFile = publishedFiles.get(managedPath);
    const draftFile = draftFiles.get(managedPath);
    let change = "unchanged";
    let source = draftFile;

    if (!publishedFile) {
      change = "added";
      changes.added += 1;
    } else if (!draftFile) {
      change = "removed";
      source = publishedFile;
      changes.removed += 1;
    } else if (!sameManifestFile(publishedFile, draftFile)) {
      change = "updated";
      changes.updated += 1;
    }

    if (change !== "unchanged" && (source.side === "server" || source.side === "both")) {
      changes.serverRestartRecommended = true;
    }
    if (change === "updated" && (publishedFile.side === "server" || publishedFile.side === "both")) {
      changes.serverRestartRecommended = true;
    }

    return { ...source, change };
  });

  changes.total = changes.added + changes.updated + changes.removed;
  changes.dirty = changes.total > 0;
  return { published, draft, files, changes };
}

async function validateDraftBlobs(context, draft) {
  for (const file of draft.files || []) {
    const blobName = String(file.downloadPath || "").replace(/^\/files\//, "");
    if (!BLOB_NAME_PATTERN.test(blobName)) {
      throw new Error(`Invalid draft blob for ${file.path}`);
    }

    const body = await readFile(path.join(context.blobsDir, blobName));
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== file.sha256) {
      throw new Error(`Draft blob hash mismatch for ${file.path}`);
    }
  }
}

function sameManifestFile(left, right) {
  return left.path === right.path &&
    left.side === right.side &&
    left.sha256 === right.sha256 &&
    Number(left.size) === Number(right.size) &&
    left.downloadPath === right.downloadPath;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireNonEmptyString(value, fieldName) {
  const text = String(value || "").trim();

  if (!text) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  return text;
}

function getSafeExtension(managedPath) {
  const extension = path.posix.extname(managedPath);

  if (!extension || !/^\.[A-Za-z0-9_-]{1,16}$/.test(extension)) {
    return ".bin";
  }

  return extension;
}

async function collectJsonBody(request) {
  const body = await collectBody(request, 1024 * 1024);

  if (body.length === 0) {
    return {};
  }

  return JSON.parse(body.toString("utf8"));
}

async function collectBody(request, maxBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > maxBytes) {
      throw new Error(`Request body is larger than ${maxBytes} bytes.`);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function requireAdmin(request, response, context) {
  if (!context.adminToken) {
    sendJson(response, 503, {
      error: "Admin API is disabled. Set UDMC_ADMIN_TOKEN."
    });
    return false;
  }

  const authHeader = request.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  const provided = bearer || request.headers["x-udmc-token"] || "";

  if (!safeTokenEquals(String(provided), String(context.adminToken))) {
    sendJson(response, 401, {
      error: "Invalid admin token"
    });
    return false;
  }

  return true;
}

function safeTokenEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function setBaseHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "authorization,content-type,x-udmc-path,x-udmc-side,x-udmc-token"
  );
}

function sendJson(response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  response.end(body);
}

const isMain = import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  startFromEnv().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
