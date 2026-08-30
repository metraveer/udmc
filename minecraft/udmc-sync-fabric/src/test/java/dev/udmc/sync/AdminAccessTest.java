package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

public final class AdminAccessTest {
    private static final String ROOT = "root-test-only";
    private static final String OWNER = "a".repeat(64);
    private static final String FRIEND = "b".repeat(64);
    private static final Gson GSON = new Gson();

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("udmc-access-test-");
        try {
            lifecycle(root.resolve("registry"));
            expiry(root.resolve("expiry"));
            projectBinding(root.resolve("binding"));
            http(root.resolve("http"));
            System.out.println("Admin access tests passed: owner approval, role isolation, single-use invites, revocation, persistence, expiry, HTTP authorization.");
        } finally {
            try (var paths = Files.walk(root)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
        }
    }

    private static UdmcConfig config() { var config = new UdmcConfig(); config.adminToken = ROOT; config.apiHost = "127.0.0.1"; config.apiPort = 0; return config; }
    private static void lifecycle(Path path) throws Exception {
        var config = config();
        var access = new AdminAccess(path, config);
        var recovery = access.authenticate(ROOT, "127.0.0.1");
        expect(recovery.owner() && recovery.bootstrap(), "Root recovery lost owner role");
        var owner = access.enrollOwner(recovery, OWNER, "Owner PC", "127.0.0.1");
        var principal = access.authenticate(OWNER, "127.0.0.1");
        expect(principal.owner() && !principal.bootstrap(), "Owner enrollment failed");
        expect(access.enrollOwner(recovery, OWNER, "Owner PC", "127.0.0.1").get("id").equals(owner.get("id")), "Enrollment retry duplicated owner");
        var invite = access.invite(principal, "127.0.0.1");
        String code = (String) invite.get("code");
        var request = access.request(code, FRIEND, "Friend PC", "192.0.2.1");
        String id = (String) request.get("id");
        expect(request.get("status").equals("pending"), "Request auto-approved");
        denied(401, () -> access.authenticate(FRIEND, "192.0.2.1"));
        expect(access.request(code, FRIEND, "Friend PC", "192.0.2.1").get("id").equals(id), "Request retry not idempotent");
        denied(403, () -> access.request(code, "c".repeat(64), "Intruder", "192.0.2.2"));
        access.decide(principal, id, "approve", "127.0.0.1");
        var friend = access.authenticate(FRIEND, "192.0.2.1");
        expect(!friend.owner(), "Friend elevated to owner");
        denied(403, () -> access.invite(friend, "192.0.2.1"));
        denied(403, () -> access.list(friend));
        denied(403, () -> access.decide(friend, principal.id(), "revoke", "192.0.2.1"));
        denied(403, () -> access.enrollOwner(friend, "d".repeat(64), "Other PC", "192.0.2.1"));
        denied(409, () -> access.decide(principal, principal.id(), "revoke", "127.0.0.1"));
        var loaded = new AdminAccess(path, config);
        loaded.authenticate(FRIEND, "192.0.2.8");
        expect(loaded.statusFor(FRIEND, "192.0.2.8").get("lastIp").equals("192.0.2.8"), "New IP not recorded");
        String json = Files.readString(path.resolve("udmc-sync/admin-access.json"));
        expect(!json.contains(FRIEND) && !json.contains(OWNER) && !json.contains(code) && !json.contains(ROOT), "Registry contains plaintext secrets");
        String publicList = GSON.toJson(loaded.list(principal));
        expect(!publicList.contains("tokenHash") && !publicList.contains("inviteHash"), "List leaked authentication hashes");
        loaded.decide(principal, id, "revoke", "127.0.0.1");
        denied(401, () -> new AdminAccess(path, config).authenticate(FRIEND, "192.0.2.1"));
        expect(loaded.statusFor(FRIEND, "192.0.2.1").get("status").equals("revoked"), "Revocation status missing");
        denied(403, () -> loaded.request(code, FRIEND, "Again", "192.0.2.1"));
        var nextInvite = loaded.invite(principal, "127.0.0.1");
        loaded.revokeInvite(principal, (String) nextInvite.get("id"), "127.0.0.1");
        denied(403, () -> loaded.request((String) nextInvite.get("code"), "e".repeat(64), "Other", "192.0.2.3"));
    }

    private static void expiry(Path path) throws Exception {
        var time = new AtomicLong(1_000_000);
        var access = new AdminAccess(path, config(), time::get);
        var owner = access.authenticate(ROOT, "127.0.0.1");
        var invite = access.invite(owner, "127.0.0.1");
        time.addAndGet(AdminAccess.INVITE_TTL);
        denied(403, () -> access.request((String) invite.get("code"), FRIEND, "Late", "192.0.2.4"));
        var fresh = access.invite(owner, "127.0.0.1");
        var pending = access.request((String) fresh.get("code"), FRIEND, "Waiting", "192.0.2.4");
        time.addAndGet(AdminAccess.REQUEST_TTL);
        denied(409, () -> access.decide(owner, (String) pending.get("id"), "approve", "127.0.0.1"));
        expect(access.statusFor(FRIEND, "192.0.2.4").get("status").equals("expired"), "Expired request still pending");
        for (int i = 0; i < 12; i++) denied(401, () -> access.authenticate("wrong", "192.0.2.9"));
        denied(429, () -> access.authenticate("wrong", "192.0.2.9"));
    }

    private static void http(Path path) throws Exception {
        var config = config();
        var store = new ManifestStore(path, config);
        var api = new UdmcHttpApi(path, config, store);
        api.start();
        try (var client = HttpClient.newHttpClient()) {
            URI base = URI.create("http://127.0.0.1:" + api.port());
            var invitation = call(client, base, "POST", "/admin/access/invitations", ROOT, "{}", 201);
            String request = GSON.toJson(Map.of("invite", invitation.get("code").getAsString(), "token", FRIEND, "name", "HTTP friend", "role", "owner"));
            var device = call(client, base, "POST", "/access/request", null, request, 202);
            call(client, base, "GET", "/admin/files", FRIEND, null, 401);
            call(client, base, "POST", "/admin/files?path=config/test.txt", FRIEND, "data", 401);
            expect(store.loadDraft().files.isEmpty(), "Pending request mutated draft");
            String decision = GSON.toJson(Map.of("id", device.get("id").getAsString(), "action", "approve"));
            call(client, base, "POST", "/admin/access/decision", ROOT, decision, 200);
            var beforeEdit = call(client, base, "GET", "/admin/files", FRIEND, null, 200);
            var me = call(client, base, "GET", "/admin/access/me", FRIEND, null, 200);
            expect(me.get("role").getAsString().equals("admin"), "Client-provided role elevated privileges");
            var statusRequests = new java.util.ArrayList<java.util.concurrent.CompletableFuture<Void>>();
            for (int i = 0; i < 20; i++) {
                String expectedRole = i % 2 == 0 ? "owner" : "admin";
                var statusRequest = HttpRequest.newBuilder(base.resolve("/admin/status"))
                    .header("x-udmc-token", i % 2 == 0 ? ROOT : FRIEND)
                    .timeout(java.time.Duration.ofSeconds(5)).GET().build();
                statusRequests.add(client.sendAsync(statusRequest, HttpResponse.BodyHandlers.ofString()).thenAccept(response -> {
                    expect(response.statusCode() == 200, "Concurrent status failed");
                    var payload = GSON.fromJson(response.body(), JsonObject.class);
                    expect(payload.getAsJsonObject("access").get("role").getAsString().equals(expectedRole), "Concurrent status mixed administrator identities");
                }));
            }
            java.util.concurrent.CompletableFuture.allOf(statusRequests.toArray(java.util.concurrent.CompletableFuture[]::new)).get(10, java.util.concurrent.TimeUnit.SECONDS);
            call(client, base, "POST", "/admin/files?path=config/test.txt", FRIEND, "data", 201);
            String stale = GSON.toJson(Map.of("version", "test-release", "expectedRevision", beforeEdit.get("revision").getAsString()));
            call(client, base, "POST", "/admin/publish", ROOT, stale, 409);
            expect(store.loadPublished().files.isEmpty(), "Stale draft was published");
            var afterEdit = call(client, base, "GET", "/admin/files", ROOT, null, 200);
            String fresh = GSON.toJson(Map.of("version", "test-release", "expectedRevision", afterEdit.get("revision").getAsString()));
            call(client, base, "POST", "/admin/publish", ROOT, fresh, 200);
            expect(store.loadPublished().files.size() == 1, "Current draft did not publish");
            call(client, base, "POST", "/admin/access/invitations", FRIEND, "{}", 403);
            call(client, base, "POST", "/admin/access/decision", FRIEND, decision, 403);
            String revoke = GSON.toJson(Map.of("id", device.get("id").getAsString(), "action", "revoke"));
            call(client, base, "POST", "/admin/access/decision", ROOT, revoke, 200);
            call(client, base, "GET", "/admin/files", FRIEND, null, 401);
            call(client, base, "POST", "/admin/draft/reset", FRIEND, "{}", 401);
            expect(store.loadDraft().files.size() == 1, "Revoked device mutated draft");
        } finally { api.stop(); }
    }

    private static void projectBinding(Path path) throws Exception {
        var config = config();
        var access = new AdminAccess(path, config);
        access.enrollOwner(access.authenticate(ROOT, "127.0.0.1"), OWNER, "Owner", "127.0.0.1");
        var changed = config(); changed.adminToken = "another-root";
        invalidRegistry(path, changed);
        changed = config(); changed.packId = "another-project";
        invalidRegistry(path, changed);
        changed = config(); changed.manifestPublicKey = "another-key";
        invalidRegistry(path, changed);
        expect(new AdminAccess(path, config).authenticate(OWNER, "127.0.0.1").owner(), "Failed loading a different project modified grants");
    }

    private static void invalidRegistry(Path path, UdmcConfig config) throws Exception {
        try { new AdminAccess(path, config); throw new AssertionError("Changed project keys accepted old grants"); }
        catch (IOException expected) { expect(expected.getMessage().contains("changed project keys"), "Unexpected registry error"); }
    }

    private static JsonObject call(HttpClient client, URI base, String method, String path, String token, String body, int expected) throws Exception {
        var builder = HttpRequest.newBuilder(base.resolve(path));
        if (token != null) builder.header("x-udmc-token", token);
        boolean mutation = token != null && expected != 401 && !"GET".equals(method) && path.startsWith("/admin/") && !path.startsWith("/admin/access/");
        if (mutation) {
            var current = client.send(HttpRequest.newBuilder(base.resolve("/admin/workspace")).header("x-udmc-token", token).GET().build(), HttpResponse.BodyHandlers.ofString());
            builder.header("x-udmc-session", "access-test-session").header("x-udmc-revision", GSON.fromJson(current.body(), JsonObject.class).get("revision").getAsString());
        }
        var response = client.send(builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        expect(response.statusCode() == expected, path + ": expected " + expected + ", got " + response.statusCode() + ": " + response.body());
        if (mutation) {
            client.send(HttpRequest.newBuilder(base.resolve("/admin/workspace/release")).header("x-udmc-token", token)
                .header("x-udmc-session", "access-test-session").header("x-udmc-revision", response.headers().firstValue("x-udmc-revision").orElse(""))
                .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.discarding());
        }
        return GSON.fromJson(response.body(), JsonObject.class);
    }
    private interface Action { void run() throws Exception; }
    private static void denied(int status, Action action) throws Exception {
        try { action.run(); throw new AssertionError("Expected denial " + status); }
        catch (AdminAccess.Denied error) { expect(error.status == status, "Wrong denial: " + error.status + " " + error.getMessage()); }
    }
    private static void expect(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
