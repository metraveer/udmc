import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { protectedGroups, validateProtectedValues as validate } from "../apps/admin-desktop/ui/assets/protected-settings.js";

test("project IDs retain the default format and reject unsafe or oversized values", () => {
  assert.deepEqual(validate("project", { generatorPackId: " udmc-main " }), { generatorPackId: "udmc-main" });
  assert.equal(validate("project", { generatorPackId: "A_1-second" }).generatorPackId, "A_1-second");
  assert.equal(validate("project", { generatorPackId: "a".repeat(64) }).generatorPackId.length, 64);
  for (const id of ["", " ", "../project", "two projects", "a".repeat(65), "\u043f\u0440\u043e\u0435\u043a\u0442"]) {
    assert.throws(() => validate("project", { generatorPackId: id }));
  }
});

test("editing creates a whitelisted copy without changing the original values", () => {
  const input = Object.freeze({ generatorPackId: " udmc-main ", tokenInput: "must-not-be-copied" });
  assert.deepEqual(validate("project", input), { generatorPackId: "udmc-main" });
  assert.equal(input.generatorPackId, " udmc-main ");
  for (const group of ["unknown", "__proto__", "constructor"]) assert.throws(() => validate(group, input));
});

test("connection edits normalize domains, proxy paths and local addresses", () => {
  assert.deepEqual(validate("connection", { serverUrlInput: "sync.example.com/udmc", allowHttpConnection: true }), {
    serverUrlInput: "https://sync.example.com/udmc/", allowHttpConnection: false
  });
  assert.equal(validate("connection", { serverUrlInput: "localhost" }).serverUrlInput, "http://localhost:3077/");
  assert.equal(validate("connection", { serverUrlInput: "127.0.0.1:3080" }).serverUrlInput, "http://127.0.0.1:3080/");
  assert.equal(validate("connection", { serverUrlInput: "https://sync.example.com:8443/" }).serverUrlInput, "https://sync.example.com:8443/");
});

test("remote HTTP needs explicit boolean consent and game ports are rejected", () => {
  for (const consent of [false, undefined, "true"]) {
    assert.throws(() => validate("connection", { serverUrlInput: "192.0.2.1:3077", allowHttpConnection: consent }));
  }
  assert.equal(validate("connection", { serverUrlInput: "192.0.2.1:3077", allowHttpConnection: true }).allowHttpConnection, true);
  for (const port of [25565, 25575]) assert.throws(() => validate("connection", { serverUrlInput: `localhost:${port}` }));
});

test("connection validation rejects URL credentials, other protocols and malformed ports", () => {
  for (const address of ["", "https://user:secret@example.com/", "file:///C:/", "https://example.com/?token=secret", "https://example.com/#part", "127.0.0.1:70000"]) {
    assert.throws(() => validate("connection", { serverUrlInput: address }));
  }
});

test("keys accept existing printable formats but reject whitespace and excess length", () => {
  assert.deepEqual(validate("token", { tokenInput: " a1-Test_123= " }), { tokenInput: "a1-Test_123=" });
  assert.equal(validate("token", { tokenInput: "a".repeat(1024) }).tokenInput.length, 1024);
  for (const token of ["", " ", "two keys", "first\nsecond", "a\u0000b", "a".repeat(1025)]) assert.throws(() => validate("token", { tokenInput: token }));
});

test("platform edits select a bundled template and derive the loader version", () => {
  const templates = [{ minecraft: "26.2", loader: "fabric", loaderVersion: "0.19.3" }];
  const input = { generatorMinecraft: "26.2", generatorLoader: "fabric", generatorLoaderVersion: "invalid" };
  assert.deepEqual(validate("platform", input, { templates }), { generatorMinecraft: "26.2", generatorLoader: "fabric", generatorLoaderVersion: "0.19.3" });
  assert.throws(() => validate("platform", { generatorMinecraft: "unknown" }, { templates }));
  assert.throws(() => validate("platform", input));
  assert.throws(() => validate("platform", { ...input, generatorLoader: "forge" }, { templates }));
  const neo = { minecraft: "1.21.1", loader: "neoforge", loaderVersion: "21.1.248" };
  assert.equal(validate("platform", { generatorMinecraft: "1.21.1", generatorLoader: "neoforge" }, { templates: [...templates, neo] }).generatorLoaderVersion, "21.1.248");
  assert.throws(() => validate("platform", { ...input, generatorLoader: "neoforge" }, { templates: [...templates, neo] }));
});

test("internal ports follow the shared address unless an override is explicitly enabled", () => {
  const input = { generatorApiHost: "0.0.0.0", generatorApiPort: "invalid", generatorPortOverride: false };
  assert.equal(validate("network", input, { serverUrl: "localhost:3080" }).generatorApiPort, "3080");
  assert.equal(validate("network", input, { serverUrl: "https://sync.example.com:8443" }).generatorApiPort, "3077");
  assert.equal(validate("network", { ...input, generatorPortOverride: true, generatorApiPort: "3081" }).generatorApiPort, "3081");
  assert.throws(() => validate("network", { ...input, generatorApiHost: "192.0.2.1" }, { serverUrl: "localhost" }));
});

test("network and RCON ports must be within range; API does not reuse game or RCON ports", () => {
  for (const port of ["", "0", "-1", "65536", "1.5", "NaN", "Infinity"]) {
    assert.throws(() => validate("network", { generatorApiHost: "127.0.0.1", generatorPortOverride: true, generatorApiPort: port }));
    assert.throws(() => validate("rcon", { rconPortInput: port }));
  }
  for (const port of ["1", "65535"]) {
    assert.equal(validate("network", { generatorApiHost: "127.0.0.1", generatorPortOverride: true, generatorApiPort: port }).generatorApiPort, port);
  }
  for (const port of ["25565", "25575"]) assert.throws(() => validate("network", { generatorApiHost: "127.0.0.1", generatorPortOverride: true, generatorApiPort: port }));
});

test("RCON edits preserve the password and require a separate host and port", () => {
  const input = { rconEnabledInput: true, rconHostInput: " localhost ", rconPortInput: "25575", rconPasswordInput: " test password ", rememberRconPasswordInput: true };
  assert.deepEqual(validate("rcon", input), { ...input, rconHostInput: "localhost" });
  assert.equal(validate("rcon", { ...input, rconHostInput: "[::1]" }).rconHostInput, "[::1]");
  for (const host of ["", "https://example.com", "example.com:25575", "user@example.com", "example.com/path", "example.com?x", "bad host"]) {
    assert.throws(() => validate("rcon", { ...input, rconHostInput: host }));
  }
  assert.throws(() => validate("rcon", { ...input, rconPasswordInput: "" }));
  assert.equal(validate("rcon", { ...input, rconEnabledInput: false, rconPasswordInput: "" }).rconEnabledInput, false);
});

test("sensitive controls are locked before JavaScript starts and each has an explicit editor", async () => {
  const html = await readFile(new URL("../apps/admin-desktop/ui/index.html", import.meta.url), "utf8");
  for (const [group, { fields }] of Object.entries(protectedGroups)) {
    assert.ok(html.includes(`data-edit-setting="${group}"`), `Missing edit button: ${group}`);
    for (const [id] of fields) {
      const tag = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0];
      assert.ok(tag, `Missing control: ${id}`);
      assert.match(tag, /\b(readonly|disabled)\b/, `Initially editable: ${id}`);
    }
  }
  assert.match(html, /id="generatorPackId"[^>]+value="udmc-main"/);
  assert.match(html, /id="protectedProjectConfirmed" type="checkbox"/);
  assert.match(html, /id="protectedSettingsCancel"[^>]+type="button"/);
});
