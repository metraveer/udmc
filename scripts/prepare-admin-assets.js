import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const vendorDir = new URL("../apps/admin-desktop/ui/vendor/", import.meta.url);
await mkdir(vendorDir, { recursive: true });
await copyFile(new URL("../node_modules/fflate/esm/browser.js", import.meta.url), new URL("fflate.js", vendorDir));
await copyFile(new URL("../node_modules/fflate/LICENSE", import.meta.url), new URL("fflate.LICENSE", vendorDir));
await cp(new URL("../node_modules/smol-toml/dist/", import.meta.url), new URL("smol-toml/", vendorDir), { recursive: true, filter: source => !/\.(?:map|ts|cjs)$/.test(String(source)) });
await copyFile(new URL("../node_modules/smol-toml/LICENSE", import.meta.url), new URL("smol-toml.LICENSE", vendorDir));
await copyFile(new URL("../node_modules/lucide/dist/umd/lucide.min.js", import.meta.url), new URL("lucide.js", vendorDir));
await copyFile(new URL("../node_modules/lucide/LICENSE", import.meta.url), new URL("lucide.LICENSE", vendorDir));
await copyFile(new URL("../node_modules/marked/lib/marked.esm.js", import.meta.url), new URL("marked.js", vendorDir));
await copyFile(new URL("../node_modules/marked/LICENSE", import.meta.url), new URL("marked.LICENSE", vendorDir));
await copyFile(new URL("../node_modules/dompurify/dist/purify.es.mjs", import.meta.url), new URL("dompurify.js", vendorDir));
await copyFile(new URL("../node_modules/dompurify/LICENSE", import.meta.url), new URL("dompurify.LICENSE", vendorDir));
await copyFile(new URL("../node_modules/i18next/dist/esm/i18next.js", import.meta.url), new URL("i18next.js", vendorDir));
await copyFile(new URL("../node_modules/i18next/LICENSE", import.meta.url), new URL("i18next.LICENSE", vendorDir));
const resources = {};
for (const language of ["ru", "en"]) {
  const translation = JSON.parse(await readFile(new URL(`../apps/admin-desktop/ui/locales/${language}.json`, import.meta.url), "utf8"));
  const game = JSON.parse(await readFile(new URL(`../minecraft/udmc-sync-common/src/main/resources/assets/udmc_sync/lang/${language}_${language === "ru" ? "ru" : "us"}.json`, import.meta.url), "utf8"));
  // Compile the shared diagnostic strings from Minecraft's indexed placeholders to i18next's.
  for (const [key, message] of Object.entries(game)) if (key.startsWith("udmc_sync.diagnostic.")) {
    if (Object.hasOwn(translation, key)) throw new Error(`Duplicate message: ${key}`);
    translation[key] = message.replace(/%(\d+)\$s/g, (_, index) => `{${Number(index) - 1}}`);
  }
  resources[language] = { translation };
}
await writeFile(new URL("../apps/admin-desktop/ui/locales/resources.js", import.meta.url), `// Generated from ru.json and en.json by admin:prepare.\nexport const resources = ${JSON.stringify(resources)};\n`);
console.log(`Prepared offline UI dependencies: ${fileURLToPath(vendorDir)}`);
