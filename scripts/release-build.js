import { spawn } from "node:child_process";

const option = process.argv[2] || "patch";
if (!["patch", "minor", "major", "--retry"].includes(option)) throw new Error("Use patch, minor, major or --retry");
const run = (args) => new Promise((resolve, reject) => {
  const windows = process.platform === "win32";
  const child = spawn(windows ? "cmd.exe" : "npm", windows ? ["/d", "/c", "npm", ...args] : args, { stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(" ")} failed (${code}). Retry with npm run release:build -- --retry`)));
});
if (option !== "--retry") await run(["version", option, "--no-git-tag-version"]);
await run(["run", "version:sync"]);
await run(["test"]);
await run(["run", "minecraft:build"]);
await run(["run", "admin:test"]);
await run(["run", "admin:build"]);
