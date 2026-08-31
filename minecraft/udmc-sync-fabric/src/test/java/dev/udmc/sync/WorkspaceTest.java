package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

public final class WorkspaceTest {
    private static final Gson GSON = new Gson();
    private static final String OWNER = "workspace-owner-test";
    private static final String ADMIN = "c".repeat(64);
    private static final String A = "owner-session-0001", B = "admin-session-0002";

    public static void main(String[] args) throws Exception {
        lease();
        Path directory = Files.createTempDirectory("udmc-workspace-test-");
        try { http(directory); }
        finally {
            TestMods.deleteTree(directory);
        }
        System.out.println("Workspace tests passed: all mutation preconditions, independent admins, sessions, leases, expiry, revocation during streamed upload, no stale writes.");
    }

    private static void lease() {
        var clock = new AtomicLong(1000);
        var workspace = new AdminWorkspace(clock::get);
        var owner = new AdminAccess.Principal("owner", "owner", false);
        var admin = new AdminAccess.Principal("admin", "admin", false);
        String before = workspace.revision();
        denied(428, () -> workspace.claim(owner, A, null, "Owner", "edit"));
        workspace.claim(owner, A, before, "Owner", "upload");
        denied(423, () -> workspace.claim(admin, B, before, "Friend", "edit"));
        denied(423, () -> workspace.claim(owner, B, before, "Other window", "edit"));
        workspace.release(admin, A);
        denied(423, () -> workspace.claim(admin, B, before, "Friend", "edit"));
        clock.addAndGet(AdminWorkspace.LEASE_MILLIS - 1);
        workspace.heartbeat(owner, A);
        clock.addAndGet(2);
        denied(423, () -> workspace.claim(admin, B, before, "Friend", "edit"));
        clock.addAndGet(AdminWorkspace.LEASE_MILLIS);
        workspace.commit(admin, B, before, "Friend", "edit");
        denied(409, () -> workspace.commit(owner, A, before, "Owner", "edit"));
        workspace.revoke(admin.id());
        workspace.commit(owner, A, workspace.revision(), "Owner", "edit");
        check(!new AdminWorkspace(clock::get).revision().equals(workspace.revision()), "Restart reused a revision");
    }

    private static void http(Path directory) throws Exception {
        var config = new UdmcConfig(); config.adminToken = OWNER; config.apiHost = "127.0.0.1"; config.apiPort = 0;
        var registry = new AdminAccess(directory, config);
        var owner = registry.authenticate(OWNER, "127.0.0.1");
        var invite = registry.invite(owner, "127.0.0.1");
        var friend = registry.request((String) invite.get("code"), ADMIN, "Friend PC", "127.0.0.1");
        registry.decide(owner, (String) friend.get("id"), "approve", "127.0.0.1");
        var store = new ManifestStore(directory, config);
        var api = new UdmcHttpApi(directory, config, store); api.start();
        try (var first = HttpClient.newHttpClient(); var second = HttpClient.newHttpClient()) {
            URI base = URI.create("http://127.0.0.1:" + api.port());
            String original = revision(first, base, OWNER);
            for (String path : new String[] {"/admin/files", "/admin/files/update", "/admin/files/revert", "/admin/draft/reset", "/admin/publish", "/admin/settings", "/admin/server/files/import", "/admin/server/files/remove", "/admin/server/command", "/admin/server/restart", "/admin/server/stop", "/admin/agents/client", "/admin/agents/update", "/admin/agents/settings"}) {
                call(first, base, "POST", path, OWNER, A, null, "{}", 428);
                call(first, base, "POST", path, OWNER, A, "stale", "{}", 409);
            }
            // Stopping the server is no longer gated by a switch in the config: a request with a
            // fresh revision reaches the runtime itself, and only a runtime that is not attached
            // refuses it. Before, it never got that far. Accepting it spends the revision.
            call(first, base, "POST", "/admin/server/stop", OWNER, A, original, "{\"delaySeconds\":0}", 503);
            original = revision(first, base, OWNER);
            call(first, base, "DELETE", "/admin/files?path=config/test.txt", OWNER, A, "stale", "", 409);
            check(store.loadDraft().files.isEmpty(), "Stale request changed the draft");
            call(first, base, "POST", "/admin/files?path=config/test.txt", OWNER, A, original, "first", 201);
            call(second, base, "POST", "/admin/files?path=config/test.txt", ADMIN, B, original, "lost update", 409);
            String current = revision(second, base, ADMIN);
            var locked = call(second, base, "POST", "/admin/files?path=config/test.txt", ADMIN, B, current, "locked", 423);
            check(locked.getAsJsonObject("workspace").getAsJsonObject("lease").get("name").getAsString().length() > 0, "Lock omitted owner name");
            check(locked.get("code").getAsString().equals("WORKSPACE_LOCKED"), "Lock omitted stable error code");
            check(locked.getAsJsonArray("args").size() == 1
                && locked.getAsJsonArray("args").get(0).getAsString().equals(locked.getAsJsonObject("workspace").getAsJsonObject("lease").get("name").getAsString()),
                "Lock error did not preserve the literal administrator name");
            call(second, base, "POST", "/admin/workspace/release", ADMIN, A, current, "", 200);
            call(second, base, "POST", "/admin/draft/reset", ADMIN, B, current, "{}", 423);
            call(first, base, "POST", "/admin/workspace/release", OWNER, A, current, "", 200);
            call(second, base, "POST", "/admin/files?path=config/second.txt", ADMIN, B, current, "second", 201);
            check(store.loadDraft().files.size() == 2, "Sequential admins lost files");

            try (var socket = new Socket("127.0.0.1", api.port())) {
                socket.setSoTimeout(5000);
                String beforeBody = revision(second, base, ADMIN);
                String headers = "POST /admin/settings HTTP/1.1\r\nHost: localhost\r\nx-udmc-token: " + ADMIN
                    + "\r\nx-udmc-session: " + B + "\r\nx-udmc-revision: " + beforeBody
                    + "\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{";
                socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().flush();
                long deadline = System.nanoTime() + Duration.ofSeconds(3).toNanos();
                JsonObject snapshot;
                do {
                    snapshot = call(first, base, "GET", "/admin/workspace", OWNER, A, null, "", 200);
                    if (snapshot.getAsJsonObject("lease").get("operation").getAsString().equals("POST /admin/settings")) break;
                    Thread.sleep(10);
                } while (System.nanoTime() < deadline);
                check(snapshot.getAsJsonObject("lease").get("operation").getAsString().equals("POST /admin/settings"), "Slow JSON did not claim the lease");
                check(snapshot.get("revision").getAsString().equals(beforeBody), "Incomplete JSON advanced the revision");
                call(first, base, "GET", "/admin/files", OWNER, A, null, "", 200);
                call(first, base, "POST", "/admin/draft/reset", OWNER, A, beforeBody, "{}", 423);
                socket.getOutputStream().write('}'); socket.getOutputStream().flush();
                check(new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8).startsWith("HTTP/1.1 200"), "Slow JSON did not commit");
                check(!revision(second, base, ADMIN).equals(beforeBody), "Completed JSON did not advance the revision");
            }

            try (var socket = new Socket("127.0.0.1", api.port())) {
                socket.setSoTimeout(5000);
                String headers = "POST /admin/files?path=config/revoked.txt HTTP/1.1\r\nHost: localhost\r\nx-udmc-token: " + ADMIN
                    + "\r\nx-udmc-session: " + B + "\r\nx-udmc-revision: " + revision(second, base, ADMIN)
                    + "\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc";
                socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().flush();
                long deadline = System.nanoTime() + Duration.ofSeconds(3).toNanos();
                while (!hasUpload(directory) && System.nanoTime() < deadline) Thread.sleep(10);
                check(hasUpload(directory), "Revocation upload did not start");
                call(first, base, "POST", "/admin/access/decision", OWNER, A, null, GSON.toJson(Map.of("id", friend.get("id"), "action", "revoke")), 200);
                socket.getOutputStream().write("def".getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().flush();
                check(new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8).startsWith("HTTP/1.1 401"), "Revoked upload committed");
            }
            check(store.loadDraft().files.size() == 2 && !hasUpload(directory), "Revoked upload retained draft or staging data");
            call(first, base, "POST", "/admin/draft/reset", OWNER, A, revision(first, base, OWNER), "{}", 200);
        } finally { api.stop(); }
    }

    private static boolean hasUpload(Path directory) throws Exception {
        try (var paths = Files.list(directory.resolve("udmc-sync"))) { return paths.anyMatch(p -> p.getFileName().toString().startsWith("upload-")); }
    }
    private static String revision(HttpClient client, URI base, String token) throws Exception {
        return call(client, base, "GET", "/admin/workspace", token, token.equals(OWNER) ? A : B, null, "", 200).get("revision").getAsString();
    }
    private static JsonObject call(HttpClient client, URI base, String method, String path, String token, String session, String revision, String body, int status) throws Exception {
        var builder = HttpRequest.newBuilder(base.resolve(path)).timeout(Duration.ofSeconds(5)).header("x-udmc-token", token).header("x-udmc-session", session);
        if (revision != null) builder.header("x-udmc-revision", revision);
        var response = client.send(builder.method(method, HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        check(response.statusCode() == status, path + ": expected " + status + ", got " + response.statusCode() + ": " + response.body());
        return GSON.fromJson(response.body(), JsonObject.class);
    }
    private static void denied(int status, Runnable action) {
        try { action.run(); throw new AssertionError("Expected conflict " + status); }
        catch (AdminWorkspace.Conflict error) { check(error.status == status, "Wrong status: " + error.status); }
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
