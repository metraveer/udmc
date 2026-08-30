import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { inspectFile } from "../apps/admin-desktop/ui/assets/file-intake.js";
import { normalizeManagedPath } from "../packages/core/src/manifest.js";

function archive(name, files) {
  return new File([zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])))], name);
}

for (const [environment, side] of [["client", "client"], ["server", "server"], ["*", "both"], [undefined, "both"]]) {
  test(`Fabric environment ${environment} selects ${side}`, async () => {
    const file = archive("example.jar", { "fabric.mod.json": JSON.stringify({ id: "example", environment }) });
    const result = await inspectFile(file);
    assert.equal(result.root, "mods/");
    assert.equal(result.side, side);
    assert.equal(result.modId, "example");
    assert.equal(result.inspectionError, undefined);
  });
}

test("ZIP contents distinguish shaders and resource packs", async () => {
  assert.equal((await inspectFile(archive("arbitrary.zip", { "shaders/program.vsh": "" }))).root, "shaderpacks/");
  assert.equal((await inspectFile(archive("resources.zip", { "pack.mcmeta": "{}" }))).root, "resourcepacks/");
});

test("broken archives and non-Fabric JARs are reported", async () => {
  assert.ok((await inspectFile(new File(["not a zip"], "broken.jar"))).inspectionError);
  assert.ok((await inspectFile(archive("forge.jar", { "META-INF/mods.toml": "" }))).inspectionError);
  assert.ok((await inspectFile(archive("invalid.jar", { "fabric.mod.json": "{" }))).inspectionError);
});

test("oversized metadata is not decompressed", async () => {
  assert.ok((await inspectFile(archive("huge.jar", { "fabric.mod.json": " ".repeat(300 * 1024) }))).inspectionError);
});

test("large uninspected JARs require an explicit destination", async () => {
  const result = await inspectFile({ name: "large.jar", size: 65 * 1024 * 1024,
    arrayBuffer() { throw new Error("Must not read the large archive"); } }, "neoforge");
  assert.equal(result.root, "mods/");
  assert.equal(result.side, "");
  assert.equal(result.sideKnown, false);
});

test("UDMC agents and renamed secret JARs are rejected before upload", async () => {
  assert.ok((await inspectFile(archive("renamed.jar", { "udmc-bootstrap.json": "secret", "fabric.mod.json": '{"id":"example"}' }))).inspectionError);
  assert.ok((await inspectFile(archive("agent.jar", { "fabric.mod.json": '{"id":"udmc_sync"}' }))).inspectionError);
});

test("ordinary configuration defaults to both sides", async () => {
  const result = await inspectFile(new File(["{}"], "settings.json"));
  assert.equal(result.root, "config/");
  assert.equal(result.side, "both");
});

const neoMetadata = 'modLoader="javafml"\nloaderVersion="[4,)"\n[[mods]]\nmodId="example"\nversion="1.0"';
test("NeoForge metadata supports multiple root mods and requires a side selection", async () => {
  const result = await inspectFile(archive("neo.jar", { "META-INF/neoforge.mods.toml": neoMetadata + '\n[[mods]]\nmodId="second"\nversion="2"' }), "neoforge");
  assert.equal(result.inspectionError, undefined);
  assert.equal(result.side, "");
  assert.deepEqual(result.modIds, ["example", "second"]);
  assert.deepEqual(result.loaders, ["neoforge"]);
});
test("wrong loaders, malformed TOML, unsupported language loaders and NeoForge agents are refused", async () => {
  const neo = archive("neo.jar", { "META-INF/neoforge.mods.toml": neoMetadata });
  assert.ok((await inspectFile(neo, "fabric")).inspectionError);
  assert.ok((await inspectFile(archive("fabric.jar", { "fabric.mod.json": '{"id":"example"}' }), "neoforge")).inspectionError);
  for (const metadata of ["[[invalid", neoMetadata.replace("example", "udmc_sync"), neoMetadata.replace("javafml", "unknownfml"), neoMetadata + '\n[[mods]]\nmodId="example"\nversion="2"']) {
    assert.ok((await inspectFile(archive("invalid.jar", { "META-INF/neoforge.mods.toml": metadata }), "neoforge")).inspectionError);
  }
});
test("multiloader archives use the metadata for the selected platform", async () => {
  const file = archive("multi.jar", { "fabric.mod.json": '{"id":"fabric_part","environment":"client"}', "META-INF/neoforge.mods.toml": neoMetadata });
  assert.equal((await inspectFile(file, "fabric")).modId, "fabric_part");
  assert.equal((await inspectFile(file, "neoforge")).modId, "example");
});

test("unsafe, reserved and nonportable paths are rejected", () => {
  for (const path of ["mods/../config/a.json", "mods/", "mods/con.jar", "mods/file.jar.", "mods/file:ads", "config/udmc-sync.json", "config/.udmc-managed.json"]) {
    assert.throws(() => normalizeManagedPath(path), undefined, path);
  }
  assert.equal(normalizeManagedPath("config/nested/settings.json"), "config/nested/settings.json");
});

test("Tauri leaves Windows file drops to the HTML interface", async () => {
  const config = JSON.parse(await readFile(new URL("../apps/admin-desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(config.app.windows[0].dragDropEnabled, false);
});
