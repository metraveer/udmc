import test from "node:test";
import assert from "node:assert/strict";
import { createProfileStore, profileCommand } from "../apps/admin-desktop/ui/assets/server-profiles.js";
import { createProfileSession } from "../apps/admin-desktop/ui/assets/profile-session.js";
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

test("legacy project migrates without moving or overwriting its settings", () => {
  const data = storage({ "udmc-control-server-url": "https://old.test/", "udmc-generator-settings": '{"generatorPackId":"old"}' });
  const profiles = createProfileStore(data, () => first);
  assert.equal(profiles.active(), "legacy");
  assert.equal(profiles.storage.getItem("udmc-control-server-url"), "https://old.test/");
  const id = profiles.create("New server"); profiles.select(id);
  assert.equal(profiles.storage.getItem("udmc-control-server-url"), null);
  profiles.storage.setItem("udmc-control-server-url", "https://new.test/");
  const restored = createProfileStore(data);
  assert.equal(restored.active(), first);
  assert.equal(restored.storage.getItem("udmc-control-server-url"), "https://new.test/");
  restored.select("legacy");
  assert.equal(restored.storage.getItem("udmc-control-server-url"), "https://old.test/");
  assert.equal(restored.storage.getItem("udmc-generator-settings"), '{"generatorPackId":"old"}');
});

test("credentials, agent keys and delayed storage writes cannot cross profiles", () => {
  const data = storage(), ids = [first, second];
  const profiles = createProfileStore(data, () => ids.shift());
  profiles.create("A"); profiles.create("B"); profiles.select(first);
  const bound = profiles.storageFor(first);
  profiles.select(second); bound.setItem("rcon", "A secret setting");
  assert.equal(profiles.storage.getItem("rcon"), null);
  assert.equal(profileCommand("credential_read", { name: "admin-connection" }, "legacy").name, "admin-connection");
  assert.notEqual(profileCommand("credential_read", { name: "admin-connection" }, first).name, profileCommand("credential_read", { name: "admin-connection" }, second).name);
  // Saving the mod is the same file whatever the profile, so nothing about it is scoped:
  // only stored secrets are, and those still are.
  assert.deepEqual(profileCommand("save_agent", { request: { templateId: "fabric-26.2" } }, first),
    { request: { templateId: "fabric-26.2" } });
  assert.throws(() => profileCommand("credential_read", {}, "../other"));
});

test("failed profile persistence does not switch the current server", () => {
  const data = storage();
  const profiles = createProfileStore(data, () => first);
  profiles.create("A");
  data.setItem = () => { throw new Error("disk full"); };
  assert.throws(() => profiles.select(first), /disk full/);
  assert.equal(profiles.active(), "legacy");
});

test("a damaged registry never silently overwrites profiles or exposes legacy credentials", () => {
  for (const raw of ["{broken", "null", "{}", JSON.stringify({ active: first, profiles: [{ id: second, name: "B" }] })]) {
    const data = storage({ "udmc-server-profiles-v1": raw, "udmc-control-token": "legacy-secret" });
    const profiles = createProfileStore(data, () => first);
    assert.ok(profiles.error());
    assert.equal(profiles.storage.getItem("udmc-control-token"), null);
    assert.equal(profiles.storageFor("legacy").getItem("udmc-control-token"), null);
    assert.throws(() => profiles.create("New server"));
    assert.throws(() => profiles.select("legacy"));
    assert.throws(() => profiles.storageFor("legacy").setItem("rcon", "different"));
    assert.equal(data.getItem("udmc-server-profiles-v1"), raw);
    assert.equal(data.getItem("udmc-control-token"), "legacy-secret");
  }
});

test("session views and histories are profile-scoped and known credentials are redacted before truncation", () => {
  const data = storage(), a = createProfileSession(data, first), b = createProfileSession(data, second);
  const key = "test-secret-token";
  a.save({ view: "console", tab: "published", fileSearch: key,
    console: [{ command: `say ${key}`, output: "x".repeat(16380) + key, time: 1, transport: "RCON" }],
    activity: [{ time: 2, message: `Invalid ${key}`, type: "error" }] }, [key]);
  assert.equal(b.read().view, "dashboard");
  assert.deepEqual(b.read().console, []);
  const restored = createProfileSession(data, first).read();
  assert.equal(restored.view, "console");
  assert.equal(restored.tab, "published");
  assert.equal(restored.console[0].command, "say [redacted]");
  assert.ok(!JSON.stringify(restored).includes("test-secret"));
  assert.ok(restored.console[0].output.length <= 16384);
});
