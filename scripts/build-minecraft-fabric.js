import { access, readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const localGradle = path.resolve("minecraft/udmc-sync-fabric", process.platform === "win32" ? "gradlew.bat" : "gradlew");
const runtimeGradle = path.resolve(
  ".gradle-runtime",
  "gradle-9.7.1",
  "bin",
  process.platform === "win32" ? "gradle.bat" : "gradle"
);

const catalog = JSON.parse(await readFile("minecraft/agent-catalog.json", "utf8"));
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const templatesDir = path.resolve("apps/admin-desktop/src-tauri/agent-templates");
await mkdir(templatesDir, { recursive: true });
const command = await exists(localGradle) ? localGradle : await exists(runtimeGradle) ? runtimeGradle : "gradle";
for (const template of catalog) {
  if (!["fabric", "neoforge"].includes(template.loader)) throw new Error(`Unsupported agent loader: ${template.loader}`);
  const projectDir = path.resolve(`minecraft/udmc-sync-${template.loader}`);
  // UDMC_AGENT_GRADLE_ARGS lets a release build ask for jars only ("-x check"):
  // the agent test suite is the continuous-integration job's responsibility and
  // its fixtures need a machine that can bind local ports.
  const extra = (process.env.UDMC_AGENT_GRADLE_ARGS || "").split(" ").filter(Boolean);
  await run(command, ["build", `-Pminecraft_version=${template.minecraft}`, `-Ploader_version=${template.loaderVersion}`, `-Pmod_version=${version}`, ...extra], projectDir);
  await copyFile(path.join(projectDir, "build", template.minecraft, "libs", `udmc-sync-${template.loader}-${template.minecraft}-${version}.jar`),
    path.join(templatesDir, `${template.id}.jar`));
}
await writeFile(path.join(templatesDir, "catalog.json"), JSON.stringify({ version, templates: catalog }, null, 2));

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const isWindowsBatch = process.platform === "win32" && command.toLowerCase().endsWith(".bat");
    const executable = isWindowsBatch ? "cmd.exe" : command;
    const finalArgs = isWindowsBatch ? ["/d", "/c", command, ...args] : args;
    const child = spawn(executable, finalArgs, {
      cwd,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}
