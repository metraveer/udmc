import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loginProtocol } from "./test-support/mod-protocol.js";

// Facts this repository states in more than one place, checked against the one place that
// owns them. Every entry here is a mistake that has actually been made or is one edit away:
// a version added to the catalogue and not to the documentation, a channel renamed while a
// check kept speaking the old one, a loader version quoted in the interface from memory.
//
// The rule for anything added later: if a fact appears twice, it belongs here.
const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("the catalogue is the only place that decides which game versions exist", async () => {
  const catalog = JSON.parse(await read("minecraft/agent-catalog.json"));
  assert.ok(catalog.length >= 3, "The catalogue is the source; an empty one would make every check below vacuous");

  const versions = [...new Set(catalog.map(entry => entry.minecraft))];
  const documents = ["README.md", "README.ru.md", "docs/installation.md", "docs/modrinth.md", "docs/supported-minecraft-versions.md"];
  for (const document of documents) {
    const text = await read(document);
    for (const version of versions) {
      assert.ok(text.includes(version), `${document} does not mention Minecraft ${version}, which the catalogue supports`);
    }
  }

  // Loader and Java versions travel with the game version, and the interface quotes them on
  // its own page. Those numbers are read by people who then go and install exactly them.
  const html = await read("apps/admin-desktop/ui/index.html");
  const installation = await read("docs/installation.md");
  for (const entry of catalog) {
    const label = entry.loader === "fabric" ? `Fabric Loader ${entry.loaderVersion}` : `NeoForge ${entry.loaderVersion}`;
    assert.ok(html.includes(label), `The components page does not offer ${label}`);
    assert.ok(installation.includes(entry.loaderVersion), `The guide does not mention loader ${entry.loaderVersion}`);
    assert.ok(html.includes(`Java ${entry.java}`), `The components page does not offer Java ${entry.java}`);
    assert.ok(installation.includes(`Java ${entry.java}`), `The guide does not mention Java ${entry.java}`);
  }
});

test("the login protocol is spoken the same way by everything that speaks it", async () => {
  const login = await loginProtocol();
  // A parse that silently found nothing would make every assertion below pass on air.
  assert.equal(typeof login.protocol, "number");
  assert.ok(login.protocol >= 3 && login.queryProtocol === 2,
    "QUERY_PROTOCOL is frozen at 2: clients from 0.19.0 decode the question by position");
  assert.deepEqual(Object.keys(login.channels).sort(), ["answer", "project", "query", "register"]);
  // The registration a fresh client answers for itself goes over the game's own channel, in
  // the shape the networking libraries write - it is read by them, not by us.
  assert.equal(login.channels.register, "minecraft:register");
  assert.deepEqual(login.fields.register, ["bytes"]);

  // Two source sets carry these payloads - one for the loaders that still take a
  // ResourceLocation, one for the rest. They must put the same fields on the wire in the
  // same order: a difference here is a protocol that works on one game version and not on
  // another, which is the single most expensive shape a bug in this project can take.
  for (const name of Object.keys(login.channels)) {
    assert.deepEqual(login.variants[`${name}.classic`], login.variants[`${name}.modern`],
      `The ${name} payload differs between the classic and modern source sets`);
  }

  // The frozen question is frozen in shape, not only in number: a client from 0.19.0 reads
  // it by position, so an added field would take away the screen that tells it what to do.
  assert.deepEqual(login.fields.query, ["varint", "utf:64", "utf:64", "utf:2048", "bool"],
    "The question changed shape. Clients decode it by position - add new facts on another channel");

  const documentation = await read("docs/client-verification.md");
  assert.ok(documentation.includes("QUERY_PROTOCOL"), "The decision record must keep naming the frozen constant");
});

test("the mod is called the same thing wherever the name is produced", async () => {
  // The shape is written once - here - and both producers are held to it. The panel saves the
  // file; the server hands the same file to players. Two names for one file is how "which one
  // do you have?" stops having an answer, and the served name used to be "udmc-sync-client":
  // it called the shared file a client's and carried no version at all.
  const parts = ["loader", "game version", "mod version"];
  const generator = await read("apps/admin-desktop/src-tauri/src/generator.rs");
  // Read as a body rather than as one line: rustfmt decides where the arguments go, and a
  // test that decides that too fails on formatting instead of on meaning.
  const body = /fn file_name\(template: &Template\) -> String \{([\s\S]*?)\n\}/.exec(generator);
  assert.ok(body, "The panel no longer builds the file name in file_name()");
  assert.match(body[1], /"udmc-\{\}-\{\}-\{\}\.jar"/, `The panel must save the mod as udmc-<${parts.join(">-<")}>.jar`);
  assert.deepEqual([...body[1].matchAll(/template\.loader|template\.minecraft|env!\("CARGO_PKG_VERSION"\)/g)].map(match => match[0]),
    ["template.loader", "template.minecraft", 'env!("CARGO_PKG_VERSION")'],
    "The name must be built from the loader, the game version and this release's version, in that order");

  const distribution = await read("minecraft/udmc-sync-common/src/main/java/dev/udmc/sync/AgentDistribution.java");
  assert.match(distribution, /"udmc-" \+ config\.loaderType \+ "-" \+ config\.minecraftVersion \+ "-" \+ version \+ "\.jar"/,
    `The server must hand players the file under the same udmc-<${parts.join(">-<")}>.jar name`);

  const api = await read("minecraft/udmc-sync-common/src/main/java/dev/udmc/sync/UdmcHttpApi.java");
  assert.match(api, /filename=\\"" \+ agents\.fileName\(\)/, "The download must take its name from the one place that builds it");
  assert.doesNotMatch(api, /udmc-sync-client\.jar/, "The old single-purpose name is gone and must not come back");
});
