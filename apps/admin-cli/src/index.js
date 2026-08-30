import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3077";

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const { positional, options } = parseArgs(rawArgs);
  const serverUrl = options.server || process.env.UDMC_SERVER_URL || DEFAULT_SERVER_URL;
  const token = options.token || process.env.UDMC_ADMIN_TOKEN;

  if (!token) {
    throw new Error("Admin token is required. Pass --token or set UDMC_ADMIN_TOKEN.");
  }

  if (command === "upload") {
    await uploadFile(serverUrl, token, positional[0], options);
    return;
  }

  if (command === "list") {
    await listFiles(serverUrl, token);
    return;
  }

  if (command === "remove" || command === "delete") {
    await removeFile(serverUrl, token, positional[0]);
    return;
  }

  if (command === "publish") {
    await publish(serverUrl, token, positional[0]);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function uploadFile(serverUrl, token, localPath, options) {
  if (!localPath) {
    throw new Error("Local file path is required.");
  }

  const body = await readFile(localPath);
  const remotePath = options.path || `mods/${path.basename(localPath)}`;
  const side = options.side || "both";
  const url = makeUrl(serverUrl, "/admin/files");
  url.searchParams.set("path", remotePath);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-udmc-token": token,
      "x-udmc-side": side
    },
    body
  });
  const payload = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(payload.error || `Upload failed with HTTP ${response.status}`);
  }

  console.log(`Added to draft: ${payload.file.path}. Publish to apply.`);
  console.log(`side=${payload.file.side}`);
  console.log(`sha256=${payload.file.sha256}`);
}

async function listFiles(serverUrl, token) {
  const response = await fetch(makeUrl(serverUrl, "/admin/files"), {
    headers: {
      "x-udmc-token": token
    }
  });
  const payload = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(payload.error || `List failed with HTTP ${response.status}`);
  }

  if (!payload.files.length) {
    console.log("Draft has no files.");
    return;
  }

  for (const file of payload.files) {
    console.log(`${String(file.change || "unchanged").padEnd(9)} ${file.side.padEnd(6)} ${String(file.size).padStart(10)} ${file.path}`);
  }
}

async function removeFile(serverUrl, token, remotePath) {
  if (!remotePath) {
    throw new Error("Remote path is required, for example mods/SomeMod.jar.");
  }

  const url = makeUrl(serverUrl, "/admin/files");
  url.searchParams.set("path", remotePath);

  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      "x-udmc-token": token
    }
  });
  const payload = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(payload.error || `Remove failed with HTTP ${response.status}`);
  }

  console.log(`Removed ${payload.removed} draft item(s) for ${payload.path}. Publish to apply.`);
}

async function publish(serverUrl, token, version) {
  const response = await fetch(makeUrl(serverUrl, "/admin/publish"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-udmc-token": token
    },
    body: JSON.stringify(version ? { version } : {})
  });
  const payload = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(payload.error || `Publish failed with HTTP ${response.status}`);
  }

  console.log(`Published ${payload.pack.id} ${payload.pack.version}`);
  console.log(`publishedAt=${payload.publishedAt}`);
}

function makeUrl(serverUrl, pathname) {
  return new URL(pathname.replace(/^\/+/, ""), ensureTrailingSlash(serverUrl));
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

async function readResponseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function parseArgs(args) {
  const positional = [];
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = args[index + 1];

    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { positional, options };
}

function printHelp() {
  console.log(`UDMC Control CLI

Commands:
  upload <local-file> --side both --path mods/File.jar
  list
  remove <remote-path>
  publish [version]

Options:
  --server <url>   Sync server URL. Default: ${DEFAULT_SERVER_URL}
  --token <token>  Admin token. Can also use UDMC_ADMIN_TOKEN.
  --side <side>    client, server, or both. Default: both.
  --path <path>    Manifest path. Default: mods/<file-name>.
`);
}
