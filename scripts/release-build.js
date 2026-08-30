import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const option = process.argv[2] || "patch";
if (!["patch", "minor", "major", "--retry"].includes(option)) throw new Error("Use patch, minor, major or --retry");

// The bundler always produces updater artifacts, so the last step needs the signing key.
// On the owner's machine it lives in a file; CI passes it as a secret in the environment.
// Without either, say so before spending fifteen minutes on a build that cannot finish.
const signingKey = () => {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) return process.env.TAURI_SIGNING_PRIVATE_KEY;
  const file = path.join(homedir(), ".udmc", "updater.key");
  try { return readFileSync(file, "utf8").trim(); }
  catch { throw new Error(`No signing key: set TAURI_SIGNING_PRIVATE_KEY or restore ${file} from your backup.`); }
};
const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: signingKey(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" };

const run = (args) => new Promise((resolve, reject) => {
  const windows = process.platform === "win32";
  const child = spawn(windows ? "cmd.exe" : "npm", windows ? ["/d", "/c", "npm", ...args] : args, { stdio: "inherit", env });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(" ")} failed (${code}). Retry with npm run release:build -- --retry`)));
});
if (option !== "--retry") await run(["version", option, "--no-git-tag-version"]);
await run(["run", "version:sync"]);
await run(["test"]);
await run(["run", "minecraft:build"]);
await run(["run", "admin:test"]);
await run(["run", "admin:build"]);
