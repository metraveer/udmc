import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encodeInvitation, decodeInvitation, deviceSecret, requireSecureAccess, accessRequest } from "../apps/admin-desktop/ui/assets/access-protocol.js";

test("invitations preserve a normalized URL and a single secret", () => {
  const code = "c".repeat(64);
  const encoded = encodeInvitation("https://sync.example.com:8443/udmc/", code);
  assert.deepEqual(decodeInvitation(` ${encoded}\n`), { url: "https://sync.example.com:8443/udmc/", code });
  assert.throws(() => decodeInvitation("https://example.com"));
  assert.throws(() => decodeInvitation("UDMC1." + "a".repeat(4096)));
  assert.throws(() => encodeInvitation("https://secret:password@example.com", code));
  const malicious = "UDMC1." + Buffer.from(JSON.stringify({ url: "file:///C:/", code })).toString("base64url");
  assert.throws(() => decodeInvitation(malicious));
});

test("device secrets use independent 256-bit values", () => {
  const keys = Array.from({ length: 500 }, deviceSecret);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every(key => /^[a-f0-9]{64}$/.test(key)));
});

test("remote cleartext credentials require explicit consent", () => {
  assert.throws(() => requireSecureAccess({ url: "http://192.0.2.1:3077/" }));
  assert.equal(requireSecureAccess({ url: "http://192.0.2.1:3077/", allowHttp: true }).port, "3077");
  assert.equal(requireSecureAccess({ url: "127.0.0.1:3077" }).hostname, "127.0.0.1");
  assert.equal(requireSecureAccess({ url: "sync.example.com" }).protocol, "https:");
});

test("access requests retain proxy paths and never forward credentials on redirects", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
  });
  await accessRequest({ url: "https://example.com/sync/", token: "secret" }, "/access/status");
  assert.equal(requests[0].url, "https://example.com/sync/access/status");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.headers["x-udmc-token"], "secret");
  assert.ok(!requests[0].url.includes("secret"));
  await accessRequest({ url: "https://example.com/sync/", token: "owner" }, "/access/request", { method: "POST", token: null, body: { invite: "invitation" } });
  assert.equal(requests[1].options.headers["x-udmc-token"], undefined);
  assert.equal(JSON.parse(requests[1].options.body).invite, "invitation");
});

test("access errors retain HTTP status for recovery and revocation", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "Revoked" }), { status: 401 }));
  await assert.rejects(() => accessRequest({ url: "https://example.com", token: "secret" }, "/admin/access/me"), error => error.status === 401 && error.message === "Revoked");
});

test("one address and one pack name control remain in the interface", async () => {
  const html = await readFile(new URL("../apps/admin-desktop/ui/index.html", import.meta.url), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, "Duplicate element IDs");
  assert.ok(ids.includes("serverUrlInput") && ids.includes("packNameInput"));
  assert.ok(!ids.includes("generatorServerUrl") && !ids.includes("generatorPackName"));
  assert.ok(ids.includes("settingsView") && ids.includes("languageSelect"), "The application settings page hosts the language picker");
  const ui = await readFile(new URL("../apps/admin-desktop/ui/assets/modrinth-ui.js", import.meta.url), "utf8");
  assert.match(ui, /index: \$\("modrinthSort"\)\.value/);
  assert.match(ui, /onOpen: async/);
});

test("NSIS updates use the original directory without entering uninstall maintenance", async () => {
  const config = JSON.parse(await readFile(new URL("../apps/admin-desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.devDependencies["@tauri-apps/cli"], "2.11.4");
  assert.equal(config.bundle.windows.nsis.template, "windows/installer.nsi");
  const template = await readFile(new URL("../apps/admin-desktop/src-tauri/windows/installer.nsi", import.meta.url), "utf8");
  assert.match(template, /Function PageReinstall\s+\$\{IfThen\} \$UdmcUpgrade = 1 \$\{\|\} Abort/);
  assert.match(template, /Function PageLeaveReinstall\s+\$\{IfThen\} \$UdmcUpgrade = 1 \$\{\|\} Return/);
  assert.match(template, /\$R3 == \$INSTDIR/);
  assert.match(template, /SkipIfPassiveOrUpgrade\s+!insertmacro MUI_PAGE_DIRECTORY/);
  assert.equal(config.identifier, "dev.udmc.control");
  assert.ok(config.app.security.csp.includes("http://*:* https://*:*"), "Native UI must support the configured API port, not only 80/443");
  // Per-user installs keep silent auto-updates possible: a per-machine install would
  // raise a UAC prompt on every update the app performs for itself.
  assert.equal(config.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(config.plugins.updater.active, true);
  assert.equal(config.plugins.updater.dialog, false, "The panel shows its own update banner");
  assert.ok(config.plugins.updater.pubkey?.length > 40, "Updates must be signature-verified");
  assert.ok(config.plugins.updater.endpoints.every(endpoint => endpoint.startsWith("https://")),
    "Update metadata may only be fetched over HTTPS");
});
