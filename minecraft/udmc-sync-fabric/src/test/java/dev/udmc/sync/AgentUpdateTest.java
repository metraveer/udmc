package dev.udmc.sync;

import com.google.gson.Gson;
import dev.udmc.sync.update.AgentUpdateHelper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.KeyPairGenerator;
import java.util.Base64;
import java.util.Comparator;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

public final class AgentUpdateTest {
    private static final Gson GSON = new Gson();

    public static void main(String[] args) throws Exception {
        if (args.length == 2 && args[0].equals("child")) { child(Path.of(args[1])); return; }
        Path root = Files.createTempDirectory("udmc-agent-update-test-");
        try {
            UdmcConfig config = config();
            Path client = jar(root.resolve("client.jar"), config, true, "one", Map.of());
            Path server = jar(root.resolve("server.jar"), config, false, "one", Map.of());
            check(AgentPackages.validate(client, config, true).equals(PlatformDefaults.get("agentVersion")), "Client must validate");
            AgentPackages.validate(server, config, false);
            fails(() -> AgentPackages.validate(client, config, false));
            fails(() -> AgentPackages.validate(server, config, true));
            Path secret = jar(root.resolve("secret.jar"), config, true, "one", Map.of("adminToken", "private"));
            fails(() -> AgentPackages.validate(secret, config, true));
            Path foreign = jar(root.resolve("foreign.jar"), config, true, "one", Map.of("packId", "another"));
            fails(() -> AgentPackages.validate(foreign, config, true));
            Path wrongKey = jar(root.resolve("key.jar"), config, true, "one", Map.of("manifestPublicKey", config().manifestPublicKey));
            fails(() -> AgentPackages.validate(wrongKey, config, true));
            Path wrongPlatform = jar(root.resolve("platform.jar"), config, true, "one", Map.of("minecraftVersion", "wrong"));
            fails(() -> AgentPackages.validate(wrongPlatform, config, true));
            var release = AgentRelease.sign(client, "client", PlatformDefaults.get("agentVersion"), 1, config);
            release.verify(config, "client");
            fails(() -> release.verify(config, "server"));
            fails(() -> release.verify(config(), "client"));
            fails(() -> new AgentRelease(Base64.getEncoder().encodeToString("tampered".getBytes(StandardCharsets.UTF_8)), release.signature()).verify(config, "client"));

            Path game = root.resolve("distribution"); Files.createDirectories(game);
            AgentDistribution distribution = new AgentDistribution(game, config);
            fails(() -> distribution.setRequired(true));
            distribution.publishClient(client);
            check(Hashes.sha256(distribution.latestFile()).equals(Hashes.sha256(client)), "Public file must be the validated client");
            check(distribution.release().verify(config, "client").getProperty("sequence").equals("1"), "First agent sequence");
            distribution.publishClient(client);
            check(distribution.release().verify(config, "client").getProperty("sequence").equals("1"), "Same upload is idempotent");
            Map<String, Object> described = distribution.describe();
            String description = GSON.toJson(described);
            check(!description.contains("adminToken") && !description.contains("manifestPrivateKey") && !description.contains(config.adminToken), "Public bootstrap must have no admin secrets");
            check(Boolean.FALSE.equals(described.get("canUpdate")), "Unpackaged test agent must not offer remote self-update");
            check(((Map<?, ?>) described.get("updateReason")).get("code").equals("AGENT_UPDATE_PACKAGED_REQUIRED"), "Unavailable updates need a stable reason code");
            Path updateState = game.resolve("udmc-sync/agent-update"); Files.createDirectories(updateState);
            Properties task = new Properties(); task.setProperty("version", "0.3.1"); AgentUpdateHelper.write(updateState.resolve("task.properties"), task);
            Properties failed = new Properties(); failed.setProperty("state", "failed"); failed.setProperty("message", "private technical detail"); AgentUpdateHelper.write(updateState.resolve("result.properties"), failed);
            Map<String, Object> status = AgentUpdater.status(game);
            check(status.get("code").equals("AGENT_UPDATE_FAILED") && !GSON.toJson(status).contains("private technical detail"), "Failed updates expose a code while details stay in helper.log");
            fails(() -> distribution.publicFile("../../server.jar"));
            fails(() -> distribution.publishClient(secret));
            check(distribution.release().verify(config, "client").getProperty("sequence").equals("1"), "Rejected upload preserves release");
            Path newer = jar(root.resolve("new-client.jar"), config, true, "two", Map.of());
            distribution.publishClient(newer);
            check(distribution.release().verify(config, "client").getProperty("sequence").equals("2"), "Agent revisions increase");
            check(Files.exists(distribution.publicFile(Hashes.sha256(client) + ".jar")), "In-flight older downloads remain available");
            AgentLoginProtocol.configureServer(config, distribution);
            check(!AgentLoginProtocol.validate(null).reject(), "Optional agent does not deny login");
            distribution.setRequired(true);
            var missing = AgentLoginProtocol.validate(null);
            check(missing.reject() && missing.messageKey().equals("udmc_sync.login.missing"), "Required agent denies and identifies a missing client");
            var outdated = AgentLoginProtocol.validate(new AgentLoginProtocol.Answer(1, config.packId, "test", Hashes.sha256(client)));
            check(outdated.reject() && outdated.messageKey().equals("udmc_sync.login.outdated"), "Old agent is rejected with a typed reason");
            check(AgentLoginProtocol.validate(new AgentLoginProtocol.Answer(1, config.packId, "test", Hashes.sha256(newer))).valid(), "Matching agent is accepted");
            var incompatible = AgentLoginProtocol.validate(new AgentLoginProtocol.Answer(1, "foreign", "test", Hashes.sha256(newer)));
            check(incompatible.reject() && incompatible.messageKey().equals("udmc_sync.login.incompatible"), "Another project is rejected with a typed reason");
            check(!missing.messageFallback().isBlank() && !outdated.messageFallback().isBlank() && !incompatible.messageFallback().isBlank(), "Login reasons require clean-client fallbacks");
            check(AgentLoginProtocol.query().downloadUrl().endsWith("/agents/install"), "Login points to instructions");
            distribution.setRequired(false);

            fails(() -> distribution.setGameAddress("play.example/evil"));
            fails(() -> distribution.setGameAddress("play.example:99999"));
            fails(() -> distribution.setGameAddress("play example.com"));
            distribution.setGameAddress(" play.example.com:25565 ");
            check(config.gameAddress.equals("play.example.com:25565"), "Game address is trimmed and stored");
            check(distribution.describe().get("gameAddress").equals("play.example.com:25565"), "Describe exposes the game address");
            check(UdmcConfig.normalizeGameAddress("[2001:db8::1]:25565").equals("[2001:db8::1]:25565"), "IPv6 game addresses are accepted");
            distribution.setGameAddress("");
            check(config.gameAddress.isEmpty(), "An empty input clears the game address");

            httpDelivery(root.resolve("http"), config, client, secret);

            replacement(root.resolve("apply"), false, false);
            replacement(root.resolve("tampered"), true, false);
            replacement(root.resolve("changed-original"), false, true);
            childProcess(root.resolve("process"));
            System.out.println("Agent update checks passed: signed releases, secret/platform/role rejection, idempotent delivery, login policy, post-exit replacement, backup, tampering and stale original protection.");
        } finally {
            try (var paths = Files.walk(root)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
        }
    }

    private static void replacement(Path root, boolean corruptNew, boolean corruptOld) throws Exception {
        Files.createDirectories(root.resolve("mods")); Files.createDirectories(root.resolve("udmc-sync/agent-update"));
        Path target = root.resolve("mods/agent.jar"), staged = root.resolve("udmc-sync/agent-update/new.jar");
        Files.writeString(target, "original"); Files.writeString(staged, "new agent");
        UdmcConfig config = config();
        var release = AgentRelease.sign(staged, "server", "0.3.0", 1, config);
        Properties task = new Properties(); task.setProperty("target", "mods/agent.jar"); task.setProperty("oldHash", Hashes.sha256(target));
        String old = Hashes.sha256(target);
        if (corruptNew) Files.writeString(staged, "tampered");
        if (corruptOld) Files.writeString(target, "manually changed");
        if (corruptNew || corruptOld) {
            String before = Hashes.sha256(target);
            fails(() -> AgentUpdateHelper.apply(root, task, release.verify(config, "server")));
            check(Hashes.sha256(target).equals(before), "Failed verification must not overwrite original");
        } else {
            AgentUpdateHelper.apply(root, task, release.verify(config, "server"));
            check(Hashes.sha256(target).equals(Hashes.sha256(staged)), "Verified replacement installed");
            check(Hashes.sha256(root.resolve("udmc-sync/agent-update/previous.jar")).equals(old), "Original retained in backup");
            AgentUpdateHelper.apply(root, task, release.verify(config, "server"));
        }
        task.setProperty("target", "mods/../../outside.jar");
        fails(() -> AgentUpdateHelper.apply(root, task, release.verify(config, "server")));
    }

    private static void httpDelivery(Path root, UdmcConfig config, Path client, Path secret) throws Exception {
        Files.createDirectories(root);
        config.apiHost = "127.0.0.1"; config.apiPort = 0;
        var store = new ManifestStore(root, config);
        var api = new UdmcHttpApi(root, config, store); api.start();
        try (var http = java.net.http.HttpClient.newHttpClient()) {
            String base = "http://127.0.0.1:" + api.port();
            var before = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/agents/download")).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            check(before.statusCode() == 404, "Client must not be served before delivery");
            var unauthorized = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/admin/agents/client")).POST(java.net.http.HttpRequest.BodyPublishers.ofFile(client)).build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            check(unauthorized.statusCode() == 401, "Agent delivery requires administrator access");
            var status = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/admin/files")).header("x-udmc-token", config.adminToken).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            String revision = status.headers().firstValue("x-udmc-revision").orElseThrow();
            var uploaded = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/admin/agents/client"))
                .header("x-udmc-token", config.adminToken).header("x-udmc-session", "agent-test-session-1").header("x-udmc-revision", revision)
                .POST(java.net.http.HttpRequest.BodyPublishers.ofFile(client)).build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            check(uploaded.statusCode() == 201, "Client delivery must succeed: " + uploaded.body());
            var download = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/agents/download")).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            check(download.statusCode() == 200 && Hashes.sha256(download.body()).equals(Hashes.sha256(client)), "Public download must contain only the uploaded client");
            check(download.headers().firstValue("content-disposition").orElse("").contains("udmc-sync-client.jar"), "Download has a useful filename");
            var descriptor = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/agents/client")).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            GSON.fromJson(descriptor.body(), AgentRelease.class).verify(config, "client");
            var page = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/agents/install")).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            check(page.statusCode() == 200 && page.body().contains("mods") && !page.body().contains(config.adminToken), "Public instructions must contain no credentials");
            var freshForAddress = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/admin/files")).header("x-udmc-token", config.adminToken).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            var badAddress = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/admin/agents/settings"))
                .header("x-udmc-token", config.adminToken).header("x-udmc-session", "agent-test-session-1")
                .header("x-udmc-revision", freshForAddress.headers().firstValue("x-udmc-revision").orElseThrow())
                .POST(java.net.http.HttpRequest.BodyPublishers.ofString("{\"gameAddress\":\"bad address\"}")).build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            check(badAddress.statusCode() == 400 && badAddress.body().contains("GAME_ADDRESS_INVALID"), "Invalid game address must return the stable code: " + badAddress.body());
            var afterBad = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/admin/files")).header("x-udmc-token", config.adminToken).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            var goodAddress = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/admin/agents/settings"))
                .header("x-udmc-token", config.adminToken).header("x-udmc-session", "agent-test-session-1")
                .header("x-udmc-revision", afterBad.headers().firstValue("x-udmc-revision").orElseThrow())
                .POST(java.net.http.HttpRequest.BodyPublishers.ofString("{\"gameAddress\":\"play.udmc.example:25565\"}")).build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            check(goodAddress.statusCode() == 200 && goodAddress.body().contains("play.udmc.example:25565"), "Game address must be saved through the API: " + goodAddress.body());
            var joinInfo = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/agents/info")).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            check(joinInfo.statusCode() == 200 && joinInfo.body().contains("play.udmc.example:25565")
                && !joinInfo.body().contains(config.adminToken), "Public join info must expose the address without credentials");
            var invalid = http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + "/admin/agents/client"))
                .header("x-udmc-token", config.adminToken).header("x-udmc-session", "agent-test-session-1")
                .header("x-udmc-revision", goodAddress.headers().firstValue("x-udmc-revision").orElseThrow())
                .POST(java.net.http.HttpRequest.BodyPublishers.ofFile(secret)).build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            check(invalid.statusCode() == 400 && GSON.fromJson(invalid.body(), com.google.gson.JsonObject.class).get("code").getAsString().equals("AGENT_BOOTSTRAP_MISMATCH"),
                "Secret-bearing archive must be rejected with an actionable HTTP error: " + invalid.body());
            check(new AgentDistribution(root, config).release().verify(config, "client").getProperty("sha256").equals(Hashes.sha256(client)), "Failed delivery preserves the public client");
        } finally { api.stop(); }
    }

    private static void childProcess(Path root) throws Exception {
        Files.createDirectories(root.resolve("mods"));
        UdmcConfig config = config();
        config.save(root);
        jar(root.resolve("mods/agent.jar"), config, false, "old", Map.of());
        jar(root.resolve("next.jar"), config, false, "next", Map.of());
        String old = Hashes.sha256(root.resolve("mods/agent.jar"));
        Process child = new ProcessBuilder(java(), "-Xmx96m", "-cp", System.getProperty("java.class.path"), AgentUpdateTest.class.getName(), "child", root.toString())
            .redirectErrorStream(true).redirectOutput(root.resolve("child.log").toFile()).start();
        ProcessHandle helper = null;
        try {
            Path result = root.resolve("udmc-sync/agent-update/result.properties");
            await(() -> Files.exists(result) && AgentUpdateHelper.read(result).getProperty("state").equals("waiting"), 15000);
            var task = AgentUpdateHelper.read(root.resolve("udmc-sync/agent-update/task.properties"));
            helper = ProcessHandle.of(Long.parseLong(task.getProperty("helperPid"))).orElseThrow();
            check(Hashes.sha256(root.resolve("mods/agent.jar")).equals(old), "Running JVM must keep its original JAR");
            fails(() -> AgentUpdater.requireIdle(root));
            Files.writeString(root.resolve("exit"), "exit");
            check(child.waitFor(10, TimeUnit.SECONDS) && child.exitValue() == 0, "Fixture JVM must exit cleanly: " + Files.readString(root.resolve("child.log")));
            await(() -> Files.exists(result) && AgentUpdateHelper.read(result).getProperty("state").equals("applied"), 15000);
            check(Hashes.sha256(root.resolve("mods/agent.jar")).equals(Hashes.sha256(root.resolve("next.jar"))), "Helper replaces JAR after parent exit");
            check(Hashes.sha256(root.resolve("udmc-sync/agent-update/previous.jar")).equals(old), "Process update retains backup");
            helper.onExit().get(5, TimeUnit.SECONDS);
        } finally {
            if (child.isAlive()) { child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS); }
            if (helper != null && helper.isAlive()) { helper.destroyForcibly(); helper.onExit().get(5, TimeUnit.SECONDS); }
        }
    }

    private static void child(Path root) throws Exception {
        UdmcConfig config = UdmcConfig.load(root);
        Path next = root.resolve("next.jar"), current = root.resolve("mods/agent.jar");
        try (var held = new ZipFile(current.toFile())) {
            AgentUpdater.schedule(root, current, next, AgentRelease.sign(next, "server", PlatformDefaults.get("agentVersion"), 1, config), config, "server");
            await(() -> Files.exists(root.resolve("exit")), 30000);
        }
    }

    static Path jar(Path path, UdmcConfig config, boolean client, String content, Map<String, Object> extra) throws Exception {
        try (var zip = new ZipOutputStream(Files.newOutputStream(path))) {
            if (LoaderPlatform.TYPE.equals("fabric")) entry(zip, "fabric.mod.json", GSON.toJson(Map.of("schemaVersion", 1, "id", "udmc_sync", "version", PlatformDefaults.get("agentVersion"), "environment", client ? "client" : "server")).getBytes(StandardCharsets.UTF_8));
            else entry(zip, "META-INF/neoforge.mods.toml", ("modLoader=\"javafml\"\nloaderVersion=\"[4,)\"\nlicense=\"test\"\n[[mods]]\nmodId=\"udmc_sync\"\nversion=\"" + PlatformDefaults.get("agentVersion") + "\"\n").getBytes(StandardCharsets.UTF_8));
            entry(zip, "udmc-platform.properties", ("minecraft=" + config.minecraftVersion + "\nloader=" + config.loaderType + "\nagentVersion=" + PlatformDefaults.get("agentVersion") + "\n").getBytes(StandardCharsets.UTF_8));
            String helper = "dev/udmc/sync/update/AgentUpdateHelper.class";
            try (var input = AgentUpdateHelper.class.getResourceAsStream("/" + helper)) { entry(zip, helper, input.readAllBytes()); }
            entry(zip, "test-content.txt", content.getBytes(StandardCharsets.UTF_8));
            if (client) {
                var bootstrap = new java.util.LinkedHashMap<>(new AgentDistribution(path.getParent(), config).clientBootstrap());
                bootstrap.put("bootstrapId", "a".repeat(64)); bootstrap.putAll(extra);
                entry(zip, "udmc-bootstrap.json", GSON.toJson(bootstrap).getBytes(StandardCharsets.UTF_8));
            }
        }
        return path;
    }

    private static UdmcConfig config() throws Exception {
        var key = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        UdmcConfig result = new UdmcConfig(); result.role = "server"; result.adminToken = "agent-test-only-not-a-real-token";
        result.manifestPrivateKey = Base64.getEncoder().encodeToString(key.getPrivate().getEncoded());
        result.manifestPublicKey = Base64.getEncoder().encodeToString(key.getPublic().getEncoded()); result.requireSignedManifest = true;
        result.serverUrl = "https://example.test/udmc";
        return result;
    }
    private static void entry(ZipOutputStream zip, String name, byte[] body) throws IOException { var entry = new ZipEntry(name); entry.setTime(0); zip.putNextEntry(entry); zip.write(body); zip.closeEntry(); }
    private static String java() { return Path.of(System.getProperty("java.home"), "bin", System.getProperty("os.name").toLowerCase().contains("win") ? "java.exe" : "java").toString(); }
    private static void check(boolean valid, String message) { if (!valid) throw new AssertionError(message); }
    private static void fails(Action action) throws Exception { try { action.run(); } catch (IOException | IllegalArgumentException error) { return; } throw new AssertionError("Expected rejection"); }
    private static void await(Check check, long milliseconds) throws Exception { long end = System.nanoTime() + milliseconds * 1_000_000; while (!check.test()) { if (System.nanoTime() > end) throw new AssertionError("Timed out waiting for fixture"); Thread.sleep(100); } }
    @FunctionalInterface private interface Action { void run() throws Exception; }
    @FunctionalInterface private interface Check { boolean test() throws Exception; }
}
