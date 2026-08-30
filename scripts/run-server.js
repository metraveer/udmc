import { readFile } from "node:fs/promises";
import path from "node:path";
import { startFromEnv } from "../apps/sync-server/src/server.js";

await loadEnvFile(path.resolve(".env"));

if (!process.env.UDMC_ADMIN_TOKEN) {
  console.warn("UDMC_ADMIN_TOKEN is not set. Admin API will be disabled.");
}

await startFromEnv();

async function loadEnvFile(filePath) {
  let raw;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = stripQuotes(value);
    }
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
