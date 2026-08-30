import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const VALID_SIDES = new Set(["client", "server", "both"]);
export const VALID_TARGET_SIDES = new Set(["client", "server"]);
export const MANAGED_STATE_FILE = ".udmc-managed.json";
export const ALLOWED_MANAGED_ROOTS = ["mods/", "config/", "resourcepacks/", "shaderpacks/"];

export function makeDefaultManifest(now = new Date()) {
  return {
    schemaVersion: 1,
    releaseSequence: 0,
    pack: {
      id: process.env.UDMC_PACK_ID || "udmc-main",
      name: process.env.UDMC_PACK_NAME || "UDMC Main Modpack",
      version: "0.1.0"
    },
    minecraft: {
      version: process.env.UDMC_MINECRAFT_VERSION || "26.2",
      loader: {
        type: process.env.UDMC_LOADER_TYPE || "fabric",
        version: process.env.UDMC_LOADER_VERSION || "0.19.3"
      }
    },
    publishedAt: now.toISOString(),
    files: []
  };
}

export function normalizeManagedPath(input) {
  const raw = String(input || "").trim().replace(/\\/g, "/");

  if (!raw) {
    throw new Error("Managed path is required.");
  }

  if (raw.includes("\0") || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`Managed path must be relative: ${raw}`);
  }

  const normalized = raw;
  const parts = raw.split("/");

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    parts.some((part) => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part))
  ) {
    throw new Error(`Managed path is not safe: ${raw}`);
  }

  if (!ALLOWED_MANAGED_ROOTS.some((root) => normalized.startsWith(root))) {
    throw new Error(
      `Managed path must start with one of: ${ALLOWED_MANAGED_ROOTS.join(", ")}`
    );
  }

  if (path.posix.basename(normalized).toLowerCase() === MANAGED_STATE_FILE || normalized.toLowerCase() === "config/udmc-sync.json") {
    throw new Error("UDMC service files cannot be distributed.");
  }

  return normalized;
}

export function assertValidSide(side) {
  if (!VALID_SIDES.has(side)) {
    throw new Error(`Invalid side "${side}". Expected client, server, or both.`);
  }

  return side;
}

export function assertValidTargetSide(side) {
  if (!VALID_TARGET_SIDES.has(side)) {
    throw new Error(`Invalid target side "${side}". Expected client or server.`);
  }

  return side;
}

export function isSideNeeded(fileSide, targetSide) {
  assertValidSide(fileSide);
  assertValidTargetSide(targetSide);
  return fileSide === "both" || fileSide === targetSide;
}

export function safeResolve(rootDir, relativePath) {
  const resolvedRoot = path.resolve(rootDir);
  const candidate = path.resolve(resolvedRoot, ...String(relativePath).split("/"));
  const relative = path.relative(resolvedRoot, candidate);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Resolved path escapes target directory: ${relativePath}`);
  }

  return candidate;
}

export async function readJsonFile(filePath, fallbackValue = null) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }

    throw error;
  }
}

export async function writeJsonFileAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");

  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });

  return hash.digest("hex");
}

export function bumpPatchVersion(version) {
  const current = String(version || "0.0.0");
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(current);

  if (!match) {
    return `${current}.1`;
  }

  const [, major, minor, patch, suffix] = match;
  return `${major}.${minor}.${Number(patch) + 1}${suffix || ""}`;
}

export function sortManifestFiles(files) {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}
