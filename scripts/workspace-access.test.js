import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceAccess } from "../apps/admin-desktop/ui/assets/workspace-access.js";
import { deferred } from "./test-support/admin-dom.js";

test("workspace mutations use the displayed revision; polling never silently advances it", async () => {
  const requests = [];
  const access = createWorkspaceAccess({ getBinding: () => 0, onConflict() {}, request: async (_, options) => {
    requests.push(options); return { workspaceRevision: "epoch:2" };
  } });
  access.receive({ revision: "epoch:1" }); access.acceptDraft("epoch:1");
  access.receive({ revision: "epoch:2" });
  assert.equal(access.changed(), true);
  await access.mutate("/admin/files", { method: "POST" });
  assert.equal(requests[0].headers["x-udmc-revision"], "epoch:1");
  assert.match(requests[0].headers["x-udmc-session"], /^[a-zA-Z0-9_-]{16,80}$/);
  assert.equal(access.changed(), false);
});

test("conflicts invalidate the view and are not retried", async () => {
  let calls = 0, conflicts = 0;
  const access = createWorkspaceAccess({ getBinding: () => 0, onConflict() { conflicts++; }, request: async () => {
    calls++; throw Object.assign(new Error("stale"), { status: 409, workspace: { revision: "new" } });
  } });
  access.receive({ revision: "old" }); access.acceptDraft("old");
  await assert.rejects(access.mutate("/admin/files"), /stale/);
  await assert.rejects(access.mutate("/admin/files"), /Обновите/);
  assert.equal(calls, 1); assert.equal(conflicts, 1);
});

test("late responses cannot transfer revisions or locks between servers", async () => {
  const pending = deferred(); let binding = 1;
  const access = createWorkspaceAccess({ getBinding: () => binding, onConflict() {}, request: () => pending.promise });
  access.receive({ revision: "A" }); access.acceptDraft("A");
  const firstSession = access.headers()["x-udmc-session"];
  const write = access.mutate("/admin/files");
  await assert.rejects(access.mutate("/admin/files"), /Дождитесь/);
  binding++; access.reset(); access.receive({ revision: "B" }); access.acceptDraft("B");
  pending.resolve({ workspaceRevision: "A2" }); await write;
  assert.equal(access.changed(), false);
  assert.notEqual(access.headers()["x-udmc-session"], firstSession);
});
