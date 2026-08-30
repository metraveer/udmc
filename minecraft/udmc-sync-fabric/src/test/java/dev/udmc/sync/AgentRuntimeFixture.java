package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpServer;
import dev.udmc.sync.update.AgentUpdateHelper;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.zip.ZipFile;

/** Real agent HTTP/signing code, isolated generated JARs, no Minecraft world or user credentials. */
public final class AgentRuntimeFixture {
    private static final Gson GSON = new Gson();

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Expected fixture directory and serve/publish/waiting/applied/restarted/stop");
        Path root = Path.of(args[0]).toRealPath();
        if (!root.startsWith(Path.of("../../.qa").toRealPath())) throw new IllegalArgumentException("Only isolated .qa fixtures are allowed");
        var fixture = GSON.fromJson(Files.readString(root.resolve("fixture.json")), JsonObject.class);
        if (!fixture.get("isolatedRuntimeFixture").getAsBoolean()) throw new IllegalArgumentException("Not a runtime fixture");
        UdmcConfig config;
        Path savedConfig = root.resolve("server/config/udmc-sync.json");
        if (Files.exists(savedConfig)) {
            config = GSON.fromJson(Files.readString(savedConfig), UdmcConfig.class);
        } else {
            try (var jar = new ZipFile(root.resolve("server/mods/udmc-sync-server.jar").toFile());
                 var input = new InputStreamReader(jar.getInputStream(jar.getEntry("udmc-bootstrap.json")), StandardCharsets.UTF_8)) {
                config = GSON.fromJson(input, UdmcConfig.class);
            }
        }
        URI uri = URI.create(config.serverUrl);
        if (!"127.0.0.1".equals(uri.getHost()) || !"http".equals(uri.getScheme()) || uri.getPort() != config.apiPort
            || !"127.0.0.1".equals(config.apiHost) || !LoaderPlatform.TYPE.equals(config.loaderType)
            || !PlatformDefaults.get("minecraft").equals(config.minecraftVersion)) throw new IllegalArgumentException("Fixture platform or loopback address mismatch");
        switch (args[1]) {
            case "serve" -> serve(root, config);
            case "publish" -> publish(root, config);
            case "waiting", "applied", "restarted" -> verifyClient(root, args[1]);
            case "stop" -> {
                var control = GSON.fromJson(Files.readString(root.resolve("api-control.json")), JsonObject.class);
                try (var http = HttpClient.newHttpClient()) {
                    var response = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + control.get("port").getAsInt() + "/stop"))
                        .header("x-udmc-token", config.adminToken).timeout(Duration.ofSeconds(10))
                        .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.discarding());
                    check(response.statusCode() == 204, "Fixture did not stop");
                }
            }
            default -> throw new IllegalArgumentException("Unknown runtime fixture action");
        }
    }

    private static void serve(Path root, UdmcConfig config) throws Exception {
        Path directory = root.resolve("api");
        Files.createDirectories(directory);
        config.save(directory);
        var distribution = new AgentDistribution(directory, config);
        if (distribution.release() == null) distribution.publishClient(root.resolve("delivery.jar"));
        var api = new UdmcHttpApi(directory, config, new ManifestStore(directory, config));
        var stop = new CountDownLatch(1);
        var control = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        control.createContext("/stop", exchange -> {
            if (!"POST".equals(exchange.getRequestMethod()) || !config.adminToken.equals(exchange.getRequestHeaders().getFirst("x-udmc-token"))) {
                exchange.sendResponseHeaders(403, -1);
            } else { exchange.sendResponseHeaders(204, -1); stop.countDown(); }
            exchange.close();
        });
        try {
            api.start(); control.start();
            Files.writeString(root.resolve("api-control.json"), GSON.toJson(Map.of("port", control.getAddress().getPort())));
            System.out.println("Runtime API ready: " + config.serverUrl + " (isolated fixture; no game server)");
            stop.await();
        } finally { api.stop(); control.stop(0); }
    }

    private static void publish(Path root, UdmcConfig config) throws Exception {
        String session = UUID.randomUUID().toString();
        try (var http = HttpClient.newHttpClient()) {
            var workspace = http.send(HttpRequest.newBuilder(URI.create(config.serverUrl + "/admin/workspace"))
                .header("x-udmc-token", config.adminToken).header("x-udmc-session", session)
                .timeout(Duration.ofSeconds(10)).GET().build(), HttpResponse.BodyHandlers.ofString());
            check(workspace.statusCode() == 200, "Cannot read test workspace");
            String revision = GSON.fromJson(workspace.body(), JsonObject.class).get("revision").getAsString();
            var response = http.send(HttpRequest.newBuilder(URI.create(config.serverUrl + "/admin/agents/client"))
                .header("x-udmc-token", config.adminToken).header("x-udmc-session", session).header("x-udmc-revision", revision)
                .timeout(Duration.ofSeconds(30)).POST(HttpRequest.BodyPublishers.ofFile(root.resolve("client-next.jar"))).build(), HttpResponse.BodyHandlers.ofString());
            check(response.statusCode() == 201, "Client publication failed: " + response.statusCode());
            var info = GSON.fromJson(response.body(), JsonObject.class).getAsJsonObject("client");
            check(info.get("sha256").getAsString().equals(Hashes.sha256(root.resolve("client-next.jar"))), "Wrong published hash");
            http.send(HttpRequest.newBuilder(URI.create(config.serverUrl + "/admin/workspace/release"))
                .header("x-udmc-token", config.adminToken).header("x-udmc-session", session)
                .header("x-udmc-revision", response.headers().firstValue("x-udmc-revision").orElseThrow())
                .timeout(Duration.ofSeconds(10)).POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.discarding());
            System.out.println("PASS authenticated client publication: version " + info.get("version").getAsString());
        }
    }

    private static void verifyClient(Path root, String phase) throws Exception {
        Path client = root.resolve("client");
        Path target = client.resolve("mods/udmc-sync-client.jar");
        Path directory = client.resolve("udmc-sync/agent-update");
        String baseline = Hashes.sha256(root.resolve("delivery.jar")), next = Hashes.sha256(root.resolve("client-next.jar"));
        check(!baseline.equals(next), "Fixture has no new agent bytes");
        var result = AgentUpdateHelper.read(directory.resolve("result.properties"));
        var task = AgentUpdateHelper.read(directory.resolve("task.properties"));
        var currentConfig = GSON.fromJson(Files.readString(client.resolve("config/udmc-sync.json")), JsonObject.class);
        check(currentConfig.get("adminToken").getAsString().isEmpty() && currentConfig.get("manifestPrivateKey").getAsString().isEmpty(), "Client contains admin secrets");
        if (phase.equals("waiting")) {
            check(result.getProperty("state").equals("waiting"), "Helper is not waiting for JVM exit");
            check(AgentUpdateHelper.isSameProcess(Long.parseLong(task.getProperty("pid")), task.getProperty("processStart")), "Parent JVM already exited");
            check(Hashes.sha256(target).equals(baseline), "Loaded client JAR changed before exit");
            check(Hashes.sha256(directory.resolve("new.jar")).equals(next), "Staged JAR differs from signed publication");
            Files.writeString(root.resolve("client-checkpoint.json"), GSON.toJson(Map.of("configHash", Hashes.sha256(client.resolve("config/udmc-sync.json")))));
        } else {
            check(result.getProperty("state").equals("applied"), "Helper did not apply the update: " + result);
            check(!AgentUpdateHelper.isSameProcess(Long.parseLong(task.getProperty("pid")), task.getProperty("processStart")), "Original JVM is still running");
            check(Hashes.sha256(target).equals(next), "Wrong installed client bytes");
            check(Hashes.sha256(directory.resolve("previous.jar")).equals(baseline), "Original backup differs");
            var checkpoint = GSON.fromJson(Files.readString(root.resolve("client-checkpoint.json")), JsonObject.class);
            check(Hashes.sha256(client.resolve("config/udmc-sync.json")).equals(checkpoint.get("configHash").getAsString()), "Client settings changed during update/restart");
            if (phase.equals("restarted")) {
                String log = Files.readString(client.resolve("logs/latest.log"));
                check(log.contains("Client sync: downloaded=0, skipped=0, removed=0"), "Restart did not finish manifest verification");
                check(!log.contains("Cannot identify the client agent") && !log.contains("UDMC client sync failed"), "Packaged client did not initialize cleanly");
            }
        }
        System.out.println("PASS client " + phase + (phase.equals("waiting")
            ? ": trusted staged bytes and unchanged running JAR"
            : ": exact JAR hashes, original backup and unchanged configuration"));
    }

    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
