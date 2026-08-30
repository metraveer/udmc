import test from "node:test";
import assert from "node:assert/strict";
import { resolveMods, primaryJar, modSide, modSidePolicy } from "../apps/admin-desktop/ui/assets/modrinth.js";
import { normalizeAddress, connectionDefaults } from "../apps/admin-desktop/ui/assets/connection.js";

function fixture(loader = "fabric", minecraft = "26.2") {
  const projects = Object.fromEntries(["root", "library", "other"].map((id) => [id, { id, title: id, project_type: "mod", environment: "client_and_server" }]));
  const versions = Object.fromEntries(Object.keys(projects).map((id) => [id, {
    id: `${id}V1`, project_id: id, name: id, version_number: "1.0.0", version_type: "release", date_published: "2026-01-01",
    game_versions: [minecraft], loaders: [loader], dependencies: [],
    files: [{ filename: `${id}.jar`, size: 123, hashes: { sha512: "a".repeat(128) }, primary: true, url: `https://cdn.modrinth.com/data/${id}/versions/v1/${id}.jar` }]
  }]));
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    const [type, id, suffix] = path.split("/");
    if (type === "version") return structuredClone(Object.values(versions).find((v) => v.id === id));
    if (suffix) return [structuredClone(versions[id])];
    return structuredClone(projects[id]);
  };
  const resolve = () => resolveMods({ projectId: "root", versionId: "rootV1", minecraft, loader, get });
  return { projects, versions, resolve, calls };
}

test("addresses share safe defaults and reject embedded credentials", () => {
  assert.equal(normalizeAddress("sync.example.com"), "https://sync.example.com/");
  assert.equal(normalizeAddress("sync.example.com:3078"), "http://sync.example.com:3078/");
  assert.equal(normalizeAddress("192.168.1.5"), "http://192.168.1.5:3077/");
  assert.equal(normalizeAddress("[::1]"), "http://[::1]:3077/");
  assert.equal(normalizeAddress("https://example.com/sync"), "https://example.com/sync/");
  assert.equal(connectionDefaults("host.example:4010").apiPort, 4010);
  assert.equal(connectionDefaults("https://host.example:8443").apiPort, 3077);
  for (const value of ["https://user:pass@host", "https://host?token=secret", "https://host/#x", "ftp://host", ""]) assert.throws(() => normalizeAddress(value));
});

test("required dependencies are recursive, deduplicated and inherit client side", async () => {
  const f = fixture(); f.projects.root.environment = "client_only";
  f.projects.library.environment = "client_or_server_prefers_both";
  f.projects.other.environment = "client_or_server_prefers_both";
  f.versions.root.dependencies = [{ project_id: "library", dependency_type: "required" }, { project_id: "other", dependency_type: "required" }];
  f.versions.other.dependencies = [{ project_id: "library", dependency_type: "required" }];
  const plan = await f.resolve();
  assert.equal(plan.nodes.length, 3);
  assert.ok(plan.nodes.every((n) => n.side === "client"));
  assert.equal(f.calls.filter((p) => p === "project/library").length, 1);
});

test("version environments override project aggregates and optional sides remain explicit", () => {
  const project = { title: "Optional", environment: ["client_only", "server_only"] };
  assert.throws(() => modSidePolicy({}, project));
  const policy = modSidePolicy({ environment: "client_only_server_optional" }, project);
  assert.equal(policy.defaultSide, "client");
  assert.deepEqual(policy.options, ["client", "both"]);
  assert.deepEqual(modSidePolicy({}, { client_side: "optional", server_side: "required" }).options, ["server", "both"]);
  assert.equal(modSide({}, { environment: ["server_only"] }), "server");
  assert.equal(modSide({}, { environment: "client_or_server" }), "server");
});

test("a dependency explicitly required on both sides is not narrowed to only the parent side", async () => {
  const f = fixture(); f.projects.root.environment = "client_only";
  f.versions.root.dependencies = [{ project_id: "library", dependency_type: "required" }];
  const result = await f.resolve();
  assert.equal(result.nodes.find(n => n.project.id === "library").side, "both");
  assert.ok(result.warnings.some(w => w.includes("обе стороны")));
});

test("modpacks, missing versions and external required dependencies fail closed", async () => {
  for (const change of [
    (f) => { f.projects.root.project_type = "modpack"; },
    (f) => { f.versions.root.game_versions = ["1.20.1"]; },
    (f) => { f.versions.root.dependencies = [{ file_name: "external.jar", dependency_type: "required" }]; }
  ]) { const f = fixture(); change(f); await assert.rejects(f.resolve()); }
});

test("incompatible and cyclic dependencies are rejected", async () => {
  const f = fixture();
  f.versions.root.dependencies = [{ project_id: "library", dependency_type: "required" }, { project_id: "library", dependency_type: "incompatible" }];
  await assert.rejects(f.resolve(), /несовместим/);
  f.versions.root.dependencies.pop();
  f.versions.library.dependencies = [{ project_id: "root", dependency_type: "required" }];
  await assert.rejects(f.resolve(), /Циклические/);
});

test("optional dependencies are disclosed but not installed; dependencies do not silently select beta", async () => {
  const f = fixture();
  f.versions.root.dependencies = [{ project_id: "library", dependency_type: "optional" }];
  const plan = await f.resolve(); assert.equal(plan.nodes.length, 1); assert.equal(plan.warnings.length, 1);
  f.versions.root.dependencies[0].dependency_type = "required"; f.versions.library.version_type = "beta";
  await assert.rejects(f.resolve(), /нет подходящей/);
});

test("unknown side and non-CDN or unsafe files are refused", () => {
  assert.throws(() => modSide({}, { title: "Unknown", environment: "unknown" }));
  const original = fixture().versions.root;
  for (const patch of [{ filename: "../mod.jar" }, { filename: "CON.jar" }, { size: 100 * 1024 * 1024 }, { hashes: { sha512: "fake" } }, { url: "https://example.com/data/mod.jar" }]) {
    const v = structuredClone(original); Object.assign(v.files[0], patch); assert.throws(() => primaryJar(v));
  }
});

test("NeoForge resolves required dependencies without accepting Fabric variants", async () => {
  const f = fixture("neoforge", "1.21.1");
  f.versions.root.dependencies = [{ project_id: "library", dependency_type: "required" }];
  assert.equal((await f.resolve()).nodes.length, 2);
  f.versions.library.loaders = ["fabric"];
  await assert.rejects(f.resolve(), /нет подходящей/);
});
