package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.KeyPairGenerator;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;

public final class HttpLifecycleTest {
    private static final Gson GSON = new Gson();
    private static final String TOKEN = "http-lifecycle-test-only";
    private static final String SESSION = "http-lifecycle-session";
    private static final byte[] EMPTY = new byte[0];

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("udmc-http-lifecycle-");
        Path serverDir = root.resolve("server");
        var config = new UdmcConfig();
        config.adminToken = TOKEN;
        config.apiHost = "127.0.0.1";
        config.apiPort = 0;
        var keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        config.manifestPrivateKey = Base64.getEncoder().encodeToString(keys.getPrivate().getEncoded());
        config.manifestPublicKey = Base64.getEncoder().encodeToString(keys.getPublic().getEncoded());
        config.requireSignedManifest = true;
        var store = new ManifestStore(serverDir, config);
        var api = new UdmcHttpApi(serverDir, config, store);
        api.start();
        try (var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()) {
            URI base = URI.create("http://127.0.0.1:" + api.port());
            lifecycle(root, serverDir, config, client, base);
            slowUploadDoesNotBlock(api.port(), serverDir, client, base);
            largeTransfer(root, client, base);
            failedStreamLeavesNoDraftOrBlob(store, serverDir);
            oversizedRequest(api.port());
            System.out.println("HTTP lifecycle tests passed: signed publication, side selection, client sync/removal, personal files, stale revisions, empty/large files, concurrent slow upload, failed upload cleanup, size limits.");
        } finally {
            api.stop();
            TestMods.deleteTree(root);
        }
    }

    private static void lifecycle(Path root, Path serverDir, UdmcConfig config, HttpClient client, URI base) throws Exception {
        problem(json(call(client, base, "POST", "/admin/files?path=config/no.txt", null, "denied".getBytes(StandardCharsets.UTF_8), 401)),
            "ACCESS_DEVICE_NOT_APPROVED");
        var before = json(call(client, base, "GET", "/admin/files", TOKEN, EMPTY, 200));
        for (String side : new String[] {"client", "server", "both"}) {
            upload(client, base, "mods/" + side + ".jar", side, TestMods.jar(side + "_mod", "1.0.0"));
        }
        upload(client, base, "config/empty.txt", "both", EMPTY);
        upload(client, base, "config/modified.txt", "both", "original".getBytes(StandardCharsets.UTF_8));
        // The same mod at another version takes the old file's place in one request.
        upload(client, base, "mods/rep-1.jar", "both", TestMods.jar("rep", "1.0.0"));
        upload(client, base, "mods/rep-2.jar&replace=mods/rep-1.jar", "both", TestMods.jar("rep", "2.0.0"));
        var afterReplace = json(call(client, base, "GET", "/admin/files", TOKEN, EMPTY, 200)).getAsJsonArray("files");
        boolean hasNew = false, hasOld = false, named = false;
        for (var element : afterReplace) {
            var row = element.getAsJsonObject();
            if (row.get("path").getAsString().equals("mods/rep-2.jar")) { hasNew = true; named = row.getAsJsonArray("modIds").toString().contains("rep") && "2.0.0".equals(row.get("modVersion").getAsString()); }
            if (row.get("path").getAsString().equals("mods/rep-1.jar")) hasOld = true;
        }
        check(hasNew && !hasOld, "Replacing must add the new path and drop the old one");
        check(named, "Draft rows must carry the mod id and version");
        call(client, base, "DELETE", "/admin/files?path=mods/rep-2.jar", TOKEN, EMPTY, 200);
        check(json(call(client, base, "GET", "/manifest", null, EMPTY, 200)).getAsJsonArray("files").isEmpty(), "Upload published without confirmation");
        check(!Files.exists(serverDir.resolve("mods/both.jar")), "Upload changed active server files");
        call(client, base, "POST", "/admin/publish", TOKEN, GSON.toJson(Map.of("expectedRevision", before.get("revision").getAsString())).getBytes(StandardCharsets.UTF_8), 409);
        publish(client, base);
        check(Files.exists(serverDir.resolve("mods/server.jar")) && Files.exists(serverDir.resolve("mods/both.jar")), "Server mods not applied");
        check(!Files.exists(serverDir.resolve("mods/client.jar")), "Client-only mod installed on server");
        // Players are told about client-side files only, and handed only those.
        boolean serverListed = false;
        for (var element : json(call(client, base, "GET", "/manifest", null, EMPTY, 200)).getAsJsonArray("files")) {
            if (element.getAsJsonObject().get("path").getAsString().equals("mods/server.jar")) serverListed = true;
        }
        check(!serverListed, "A server-only file must not be listed in the public manifest");
        String serverBlob = null, bothBlob = null;
        for (var element : json(call(client, base, "GET", "/admin/files", TOKEN, EMPTY, 200)).getAsJsonArray("files")) {
            var row = element.getAsJsonObject();
            if (row.get("path").getAsString().equals("mods/server.jar")) serverBlob = row.get("downloadPath").getAsString();
            if (row.get("path").getAsString().equals("mods/both.jar")) bothBlob = row.get("downloadPath").getAsString();
        }
        check(serverBlob != null && bothBlob != null, "Both rows must be known to the panel");
        call(client, base, "GET", serverBlob, null, EMPTY, 404);
        call(client, base, "GET", bothBlob, null, EMPTY, 200);

        Path player = root.resolve("player");
        Files.createDirectories(player.resolve("mods"));
        Files.write(player.resolve("mods/personal.jar"), TestMods.jar("personal", "1.0.0"));
        var playerConfig = new UdmcConfig();
        playerConfig.serverUrl = base.toString();
        playerConfig.allowInsecureHttp = true;
        playerConfig.requireSignedManifest = true;
        playerConfig.manifestPublicKey = config.manifestPublicKey;
        var result = ModSynchronizer.syncClient(player, playerConfig);
        check(result.downloaded == 4, "Client did not receive expected files");
        check(!Files.exists(player.resolve("mods/server.jar")), "Server-only mod installed on client");
        check(Files.size(player.resolve("config/empty.txt")) == 0, "Empty download failed");
        check(ModSynchronizer.syncClient(player, playerConfig).downloaded == 0, "Unchanged files downloaded again");
        Files.writeString(player.resolve("config/modified.txt"), "player settings");
        Files.writeString(serverDir.resolve("config/modified.txt"), "server settings");
        for (String path : new String[] {"mods/client.jar", "mods/server.jar", "mods/both.jar", "config/modified.txt"}) {
            call(client, base, "DELETE", "/admin/files?path=" + path, TOKEN, EMPTY, 200);
        }
        check(Files.exists(serverDir.resolve("mods/both.jar")), "Draft deletion affected live files");
        publish(client, base);
        result = ModSynchronizer.syncClient(player, playerConfig);
        check(result.removed == 2 && result.retainedModified == 1, "Removal counts wrong");
        check(!Files.exists(serverDir.resolve("mods/both.jar")) && !Files.exists(player.resolve("mods/both.jar")), "Published deletion not applied");
        check(Files.exists(player.resolve("mods/personal.jar")), "Personal mod deleted");
        check(Files.readString(player.resolve("config/modified.txt")).equals("player settings"), "Personal configuration deleted");
        check(Files.readString(serverDir.resolve("config/modified.txt")).equals("server settings"), "Modified server configuration deleted");
        problem(json(call(client, base, "GET", "/files/not-a-hash", null, EMPTY, 400)), "FILE_BLOB_INVALID");
        problem(json(call(client, base, "POST", "/admin/files?path=../secret.txt", TOKEN, EMPTY, 400)), "MANAGED_PATH_ROOT");
        problem(json(call(client, base, "GET", "/admin/server/commands", TOKEN, EMPTY, 503)), "MINECRAFT_NOT_READY");
    }

    private static void slowUploadDoesNotBlock(int port, Path serverDir, HttpClient client, URI base) throws Exception {
        try (Socket socket = new Socket("127.0.0.1", port)) {
            socket.setSoTimeout(5000);
            String headers = "POST /admin/files?path=config/slow.txt HTTP/1.1\r\nHost: localhost\r\nx-udmc-token: " + TOKEN
                + "\r\nx-udmc-session: " + SESSION + "\r\nx-udmc-revision: " + revision(client, base)
                + "\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc";
            socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().flush();
            long deadline = System.nanoTime() + Duration.ofSeconds(3).toNanos();
            while (!hasUpload(serverDir) && System.nanoTime() < deadline) Thread.sleep(10);
            check(hasUpload(serverDir), "Slow upload did not start");
            var request = HttpRequest.newBuilder(base.resolve("/health")).timeout(Duration.ofSeconds(2)).GET().build();
            check(client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200, "Slow upload blocked health");
            request = HttpRequest.newBuilder(base.resolve("/admin/files")).header("x-udmc-token", TOKEN).timeout(Duration.ofSeconds(2)).GET().build();
            check(client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200, "Slow upload locked draft");
            socket.getOutputStream().write("def".getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().flush();
            check(new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8).startsWith("HTTP/1.1 201"), "Slow upload failed");
        }
        check(!hasUpload(serverDir), "Upload temporary file not cleaned");
    }

    private static boolean hasUpload(Path serverDir) throws IOException {
        try (var paths = Files.list(serverDir.resolve("udmc-sync"))) {
            return paths.anyMatch(path -> path.getFileName().toString().startsWith("upload-"));
        }
    }

    private static void largeTransfer(Path root, HttpClient client, URI base) throws Exception {
        // This suite runs with a 64 MiB heap. A 96 MiB file must never be readAllBytes.
        Path source = root.resolve("large.txt");
        try (var file = FileChannel.open(source, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            file.position(96L * 1024 * 1024 - 1);
            file.write(ByteBuffer.wrap(new byte[] {42}));
        }
        var request = HttpRequest.newBuilder(base.resolve("/admin/files?path=config/large.txt"))
            .timeout(Duration.ofSeconds(60)).header("x-udmc-token", TOKEN)
            .header("x-udmc-session", SESSION).header("x-udmc-revision", revision(client, base))
            .POST(HttpRequest.BodyPublishers.ofFile(source)).build();
        var uploaded = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
        check(uploaded.statusCode() == 201, "Large upload failed: " + new String(uploaded.body(), StandardCharsets.UTF_8));
        var entry = json(uploaded).getAsJsonObject("file");
        Path downloaded = root.resolve("downloaded.txt");
        // A draft nobody published is not for players to fetch, whoever knows its hash. A device with a key gets it.
        check(client.send(HttpRequest.newBuilder(base.resolve(entry.get("downloadPath").getAsString())).timeout(Duration.ofSeconds(60)).build(), HttpResponse.BodyHandlers.discarding()).statusCode() == 404,
            "An unpublished blob must not be served without a key");
        var response = client.send(HttpRequest.newBuilder(base.resolve(entry.get("downloadPath").getAsString())).timeout(Duration.ofSeconds(60)).header("x-udmc-token", TOKEN).build(), HttpResponse.BodyHandlers.ofFile(downloaded));
        check(response.statusCode() == 200 && Files.size(downloaded) == Files.size(source), "Large download truncated");
        check(Hashes.sha256(source).equals(Hashes.sha256(downloaded)), "Large download corrupted");
        call(client, base, "DELETE", "/admin/files?path=config/large.txt", TOKEN, EMPTY, 200);
    }

    private static void failedStreamLeavesNoDraftOrBlob(ManifestStore store, Path serverDir) throws Exception {
        String revision = store.draftState().revision;
        try {
            store.upsertFile("config/interrupted.txt", "both", new InputStream() {
                int read;
                public int read() throws IOException { if (++read > 1000) throw new IOException("interrupted"); return 42; }
            });
            throw new AssertionError("Failed stream was accepted");
        } catch (IOException expected) { check(expected.getMessage().equals("interrupted"), "Unexpected stream error"); }
        check(store.draftState().revision.equals(revision), "Failed upload changed draft");
        check(!hasUpload(serverDir), "Failed upload temporary file retained");
    }

    private static void oversizedRequest(int port) throws Exception {
        try (Socket socket = new Socket("127.0.0.1", port)) {
            socket.setSoTimeout(5000);
            String request = "POST /admin/files?path=config/oversized.txt HTTP/1.1\r\nHost: localhost\r\nx-udmc-token: " + TOKEN + "\r\nContent-Length: " + (ManifestStore.MAX_UPLOAD_BYTES + 1) + "\r\nConnection: close\r\n\r\n";
            socket.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));
            var reader = new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
            check(reader.readLine().startsWith("HTTP/1.1 413"), "Oversized request not rejected before body");
        }
    }

    private static void upload(HttpClient client, URI base, String path, String side, byte[] bytes) throws Exception {
        var request = HttpRequest.newBuilder(base.resolve("/admin/files?path=" + path))
            .header("x-udmc-token", TOKEN).header("x-udmc-side", side)
            .header("x-udmc-session", SESSION).header("x-udmc-revision", revision(client, base))
            .timeout(Duration.ofSeconds(5)).POST(HttpRequest.BodyPublishers.ofByteArray(bytes)).build();
        check(client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 201, "Upload failed: " + path);
    }

    private static void publish(HttpClient client, URI base) throws Exception {
        String revision = json(call(client, base, "GET", "/admin/files", TOKEN, EMPTY, 200)).get("revision").getAsString();
        call(client, base, "POST", "/admin/publish", TOKEN, GSON.toJson(Map.of("expectedRevision", revision)).getBytes(StandardCharsets.UTF_8), 200);
    }

    private static HttpResponse<byte[]> call(HttpClient client, URI base, String method, String path, String token, byte[] body, int status) throws Exception {
        var request = HttpRequest.newBuilder(base.resolve(path)).timeout(Duration.ofSeconds(10));
        if (token != null) request.header("x-udmc-token", token);
        if (token != null && !"GET".equals(method)) request.header("x-udmc-session", SESSION).header("x-udmc-revision", revision(client, base));
        var response = client.send(request.method(method, HttpRequest.BodyPublishers.ofByteArray(body)).build(), HttpResponse.BodyHandlers.ofByteArray());
        check(response.statusCode() == status, path + ": expected " + status + ", got " + response.statusCode() + " " + new String(response.body(), StandardCharsets.UTF_8));
        return response;
    }

    private static String revision(HttpClient client, URI base) throws Exception {
        var response = client.send(HttpRequest.newBuilder(base.resolve("/admin/workspace")).header("x-udmc-token", TOKEN).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        return json(response).get("revision").getAsString();
    }

    private static JsonObject json(HttpResponse<byte[]> response) { return GSON.fromJson(new String(response.body(), StandardCharsets.UTF_8), JsonObject.class); }
    private static void problem(JsonObject payload, String code) {
        check(payload.get("code").getAsString().equals(code), "Wrong API error code: " + payload);
        check(payload.get("error").isJsonPrimitive() && !payload.get("error").getAsString().isBlank(), "API error omitted fallback text: " + payload);
        check(payload.get("args").isJsonArray(), "API error omitted args: " + payload);
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
