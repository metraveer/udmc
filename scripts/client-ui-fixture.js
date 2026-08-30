import { createServer } from "node:http";
import { generateKeyPairSync, sign, createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { zipSync, strToU8 } from "fflate";

// Isolated, non-gameplay fixtures for manually testing the client's conflict screen.
const { values } = parseArgs({ options: { language: { type: "string", default: "en_us" }, scenario: { type: "string", default: "conflict" }, minecraft: { type: "string", default: "26.2" } } });
if (!["en_us", "ru_ru"].includes(values.language) || !["conflict", "verified", "updated"].includes(values.scenario)) throw new Error("Unsupported fixture language or scenario");
const catalog = JSON.parse(await readFile("minecraft/agent-catalog.json", "utf8"));
const platform = catalog.find(entry => entry.loader === "fabric" && entry.minecraft === values.minecraft);
if (!platform) throw new Error("Use a bundled Fabric Minecraft version");
await mkdir(path.resolve(".qa"), { recursive: true });
const root = await mkdtemp(path.resolve(".qa/client-ui-"));
const jar = (version) => zipSync({ "fabric.mod.json": strToU8(JSON.stringify({ schemaVersion: 1, id: "udmc_test_example", version, name: "UDMC test fixture" })) });
const required = jar("2.0.0");
const hash = createHash("sha256").update(required).digest("hex");
const keys = generateKeyPairSync("ed25519");
const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, releaseSequence: 1, pack: { id: "udmc-test", name: "UDMC test", version: "1.0.0" },
  minecraft: { version: platform.minecraft, loader: { type: platform.loader, version: platform.loaderVersion } },
  files: [{ path: "mods/required-example.jar", side: "client", sha256: hash, size: required.length, downloadPath: `/files/${hash}.jar` }] }));
const signature = sign(null, manifest, keys.privateKey).toString("base64");
const stopToken = randomBytes(24).toString("hex");
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/__stop" && req.headers.authorization === `Bearer ${stopToken}`) {
    res.end("Stopped"); server.close(); return;
  }
  if (req.url === "/manifest") { res.setHeader("x-udmc-signature", signature); res.end(manifest); }
  else if (req.url === `/files/${hash}.jar`) res.end(required);
  else { res.statusCode = 404; res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await mkdir(path.join(root, "mods"), { recursive: true });
await mkdir(path.join(root, "config"), { recursive: true });
if (values.scenario === "conflict") await writeFile(path.join(root, "mods/personal-example.jar"), jar("1.0.0"));
if (values.scenario === "verified") await writeFile(path.join(root, "mods/required-example.jar"), required);
await writeFile(path.join(root, "options.txt"), `lang:${values.language}\nguiScale:2\nfullscreen:false\nonboardAccessibility:false\n`);
await writeFile(path.join(root, "fixture.json"), JSON.stringify({ kind: "udmc-client-ui-test", port: server.address().port, stopToken, ...values }));
await writeFile(path.join(root, "config/udmc-sync.json"), JSON.stringify({
  packId: "udmc-test", serverUrl: `http://127.0.0.1:${server.address().port}`, requireSignedManifest: true, allowInsecureHttp: true,
  minecraftVersion: platform.minecraft, loaderType: platform.loader, loaderVersion: platform.loaderVersion,
  manifestPublicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64")
}, null, 2));
console.log(`Isolated client profile: ${root}`);
console.log(`Fixture HTTP port: ${server.address().port}`);
