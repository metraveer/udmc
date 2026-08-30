import { mkdir, writeFile } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";

const root = new URL("../tmp/ui-fixtures/", import.meta.url);
await mkdir(root, { recursive: true });
for (const [name, environment] of [["client-render", "client"], ["server-tools", "server"], ["shared-content", "*"]]) {
  const metadata = { schemaVersion: 1, id: name.replaceAll("-", "_"), version: "1.0.0", environment };
  await writeFile(new URL(`${name}.jar`, root), zipSync({ "fabric.mod.json": strToU8(JSON.stringify(metadata)) }));
}
await writeFile(new URL("resources.zip", root), zipSync({ "pack.mcmeta": strToU8("{}") }));
await writeFile(new URL("shaders.zip", root), zipSync({ "shaders/test.vsh": strToU8("// UI fixture") }));
await writeFile(new URL("settings.toml", root), "enabled = true\n");
console.log("Created UI test fixtures in tmp/ui-fixtures (not playable mods).");
