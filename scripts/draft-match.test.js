import test from "node:test";
import assert from "node:assert/strict";
import { findInDraft, findOnServer, replacementFor } from "../apps/admin-desktop/ui/assets/draft-match.js";

// The draft as the panel sees it: rows named by what they are, not only by what they are called.
const draft = [
  { path: "mods/fabric-api-0.158.0+26.2.jar", side: "both", sha256: "a".repeat(64), change: "unchanged", modIds: ["fabric-api", "fabric"], modVersion: "0.158.0+26.2",
    source: { provider: "modrinth", projectId: "P7dR8mSH", versionId: "old" } },
  { path: "mods/sodium.jar", side: "client", sha256: "b".repeat(64), change: "unchanged", modIds: ["sodium"], modVersion: "0.6.0" },
  { path: "mods/gone.jar", side: "both", sha256: "c".repeat(64), change: "removed", modIds: ["gone"], modVersion: "1.0" },
];

test("the same mod is found by catalog project, by mod id and by path, and a removed row never counts", () => {
  assert.equal(findInDraft(draft, { provider: "modrinth", projectId: "P7dR8mSH" }).file.path, "mods/fabric-api-0.158.0+26.2.jar");
  assert.equal(findInDraft(draft, { modIds: ["fabric-api"] }).file.path, "mods/fabric-api-0.158.0+26.2.jar");
  assert.equal(findInDraft(draft, { path: "MODS/Sodium.jar" }).file.path, "mods/sodium.jar");
  assert.equal(findInDraft(draft, { modIds: ["gone"], path: "mods/gone.jar" }), null);
  assert.equal(findInDraft(draft, { modIds: ["lithium"] }), null);
});

test("the same version is told from another one by bytes, by catalog version or by declared version", () => {
  assert.equal(findInDraft(draft, { modIds: ["sodium"], sha256: "b".repeat(64) }).same, true);
  assert.equal(findInDraft(draft, { modIds: ["sodium"], sha256: "d".repeat(64) }).same, false);
  assert.equal(findInDraft(draft, { provider: "modrinth", projectId: "P7dR8mSH", versionId: "old" }).same, true);
  assert.equal(findInDraft(draft, { provider: "modrinth", projectId: "P7dR8mSH", versionId: "new" }).same, false);
  assert.equal(findInDraft(draft, { modIds: ["sodium"], version: "0.6.0" }).same, true);
  assert.equal(findInDraft(draft, { modIds: ["sodium"], version: "0.6.5" }).same, false);
  // A name alone says nothing about the version.
  assert.equal(findInDraft(draft, { path: "mods/sodium.jar" }).same, false);
});

test("a replacement names the old path only when the new file arrives under another name", () => {
  const other = findInDraft(draft, { modIds: ["fabric-api"], version: "0.159.0+26.2" });
  assert.equal(replacementFor(other, "mods/fabric-api-0.159.0+26.2.jar"), "mods/fabric-api-0.158.0+26.2.jar");
  assert.equal(replacementFor(other, "MODS/fabric-api-0.158.0+26.2.jar"), null, "The same path is an update, not a replacement");
  assert.equal(replacementFor(findInDraft(draft, { modIds: ["sodium"], sha256: "b".repeat(64) }), "mods/sodium-new.jar"), null, "The same version replaces nothing");
  assert.equal(replacementFor(null, "mods/new.jar"), null);
});

test("a server file outside the pack is the same mod only by id, never by name", () => {
  const server = [{ path: "mods/xaerominimap-26.3.0.jar", sha256: "e".repeat(64), modIds: ["xaerominimap"], modVersion: "26.3.0" }, { path: "mods/unknown.jar", sha256: "f".repeat(64), modIds: [] }];
  assert.equal(findOnServer(server, { modIds: ["xaerominimap"] }).path, "mods/xaerominimap-26.3.0.jar");
  assert.equal(findOnServer(server, { modIds: ["unknown"] }), null);
  assert.equal(findOnServer(server, { modIds: [] }), null);
});
