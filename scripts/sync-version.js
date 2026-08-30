import { readFile, writeFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Release version must be major.minor.patch");
const check = process.argv.includes("--check");
async function update(file, transform) {
  const before = await readFile(file, "utf8");
  const after = transform(before);
  if (before === after) return;
  if (check) throw new Error(`${file} is not synchronized with package.json (${version})`);
  await writeFile(file, after);
}
for (const file of ["apps/admin-desktop/src-tauri/tauri.conf.json", "apps/admin-desktop/package.json"]) await update(file, (text) => {
  const config = JSON.parse(text);
  if (config.version === version) return text;
  config.version = version;
  return `${JSON.stringify(config, null, 2)}\n`;
});
await update("apps/admin-desktop/src-tauri/Cargo.toml", (text) => text.replace(/^version = "[^"]+"/m, `version = "${version}"`));
await update("apps/admin-desktop/src-tauri/Cargo.lock", (text) => text.replace(/(name = "udmc-control"\r?\nversion = ")[^"]+"/, `$1${version}"`));
await update("minecraft/udmc-sync-fabric/gradle.properties", (text) => text.replace(/^mod_version=.*$/m, `mod_version=${version}`));
await update("minecraft/udmc-sync-neoforge/gradle.properties", (text) => text.replace(/^mod_version=.*$/m, `mod_version=${version}`));
console.log(`UDMC version ${version}${check ? " verified" : " synchronized"}`);
