import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

if (process.platform !== "win32") throw new Error("NSIS QA requires Windows");
const root = path.resolve(".qa/installer-upgrade", randomUUID());
const sourceDir = path.resolve("apps/admin-desktop/src-tauri/target/release/nsis/x64");
const nsis = path.join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe");
await access(nsis);
const source = await readFile(path.join(sourceDir, "installer.nsi"), "utf8");
if (!source.includes("Function DetectUdmcUpgrade")) throw new Error("Build the current installer first");
await mkdir(root, { recursive: true });
const suffix = path.basename(root).slice(0, 8);
const product = `UDMC Installer QA ${suffix}`;
const publisher = `udmc-installer-qa-${suffix}`;
const binary = `udmc-installer-qa-${suffix}`;
const payload = path.join(root, `${binary}.exe`);
await copyFile(path.join(process.env.WINDIR, "System32/whoami.exe"), payload);
for (const file of ["utils.nsh", "FileAssociation.nsh"]) await copyFile(path.join(sourceDir, file), path.join(root, file));

// Rename all installation ownership and process identities before executing any test installer.
for (const version of ["0.2.1", "0.2.2"]) {
  let text = source;
  const definitions = {
    MANUFACTURER: publisher, PRODUCTNAME: product, VERSION: version,
    VERSIONWITHBUILD: `${version}.0`, INSTALLMODE: "currentUser", MAINBINARYNAME: binary,
    MAINBINARYSRCPATH: payload, BUNDLEID: `dev.udmc.installer.qa.${suffix}`,
    OUTFILE: path.join(root, `${version}-setup.exe`), ESTIMATEDSIZE: "100"
  };
  for (const [key, value] of Object.entries(definitions)) {
    const expression = new RegExp(`^!define ${key} "[^"\\r\\n]*"$`, "m");
    if (!expression.test(text)) throw new Error(`Missing NSIS definition: ${key}`);
    text = text.replace(expression, () => `!define ${key} "${value}"`);
  }
  text = text.replace("  Call DetectUdmcUpgrade", `  Call DetectUdmcUpgrade\n  FileOpen $R9 "${root}\\${version}-detection.txt" w\n  FileWrite $R9 "$UdmcUpgrade"\n  FileClose $R9`);
  text = text.replace("Function un.onInit", `Function un.onInit\n  FileOpen $R9 "${root}\\uninstaller-ran.txt" w\n  FileWrite $R9 "${version}"\n  FileClose $R9`);
  text = text.replace("!define MUI_FINISHPAGE_RUN\r\n", "!define MUI_FINISHPAGE_RUN\r\n!define MUI_FINISHPAGE_RUN_NOTCHECKED\r\n");
  if (text.includes('!define MAINBINARYNAME "udmc-control"') || text.includes('!define PRODUCTNAME "UDMC Control"')) throw new Error("Production identity in test installer");
  const file = path.join(root, `${version}.nsi`);
  await writeFile(file, text);
  const result = spawnSync(nsis, ["/V2", file], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}
await mkdir(path.join(root, "installed"));
await writeFile(path.join(root, "installed", "keep-user-data.txt"), "UDMC installer QA sentinel\n");
const fixture = { root, product, publisher, binary, installDir: path.join(root, "installed"), registry: `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}` };
await writeFile(path.join(root, "fixture.json"), JSON.stringify(fixture, null, 2));
console.log(JSON.stringify(fixture, null, 2));
