import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { parse } from "smol-toml";

// What the mod says about itself is read by two audiences the panel cannot correct: the
// launcher's mod list and, once it is published, a mod site. Both loaders must say the same
// thing, and it has to be the truth - the file carried "All-Rights-Reserved" while the
// repository was MIT, and NeoForge still described the two personal jars of 0.19.
const root = new URL("../minecraft/", import.meta.url);

test("both loaders describe the same mod, under the licence the repository actually grants", async () => {
  const licence = (await readFile(new URL("../LICENSE", import.meta.url), "utf8")).split("\n")[0].trim();
  assert.equal(licence, "MIT License", "The check below hard-codes MIT; update both if the repository relicenses");

  const fabric = JSON.parse(await readFile(new URL("udmc-sync-fabric/src/main/resources/fabric.mod.json", root), "utf8"));
  const neoforge = parse(await readFile(new URL("udmc-sync-neoforge/src/main/resources/META-INF/neoforge.mods.toml", root), "utf8"));
  const [mod] = neoforge.mods;

  assert.equal(fabric.license, "MIT");
  assert.equal(neoforge.license, "MIT");
  assert.equal(fabric.name, mod.displayName);
  assert.equal(fabric.description, mod.description, "One mod, one description");
  assert.ok(fabric.description.length > 40 && fabric.description.endsWith("."), fabric.description);
  // Read by people in any language; the panel translates, a jar does not.
  assert.doesNotMatch(fabric.description, /[А-Яа-яЁё]/);
  // The old model leaked through this sentence for a whole release.
  assert.doesNotMatch(fabric.description, /client jar|server jar|configured by UDMC Control/i);

  assert.equal(fabric.icon, mod.logoFile, "The same icon ships to both loaders");
  await access(new URL(`udmc-sync-common/src/main/resources/${fabric.icon}`, root));
});
