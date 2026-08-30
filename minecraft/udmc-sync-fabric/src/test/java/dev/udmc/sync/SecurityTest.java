package dev.udmc.sync;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import java.io.ByteArrayOutputStream;

public final class SecurityTest {
    private static final Gson GSON = new Gson();

    public static void main(String[] args) throws Exception {
        check(Messages.failure(new java.net.ConnectException()).key().equals("udmc_sync.error.connect"), "Connection errors must have a translatable message");
        check(Messages.failure(new java.net.http.HttpTimeoutException("timeout")).key().equals("udmc_sync.error.timeout"), "Timeouts must have a translatable message");
        check(Messages.failure(new java.io.IOException()).english().contains("logs/latest.log"), "Missing exception messages must not display null");
        check(!Messages.failure(new java.io.IOException("secret-token")).english().contains("secret-token"), "Unexpected technical errors must not leak into the game screen");
        var key = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        String privateKey = Base64.getEncoder().encodeToString(key.getPrivate().getEncoded());
        String publicKey = Base64.getEncoder().encodeToString(key.getPublic().getEncoded());
        byte[] original = "manifest".getBytes(StandardCharsets.UTF_8);
        String signature = ManifestSecurity.sign(original, privateKey);
        ManifestSecurity.verify(original, signature, publicKey);
        fails(() -> ManifestSecurity.verify("tampered".getBytes(StandardCharsets.UTF_8), signature, publicKey));
        fails(() -> ManifestSecurity.verify(original, null, publicKey));
        String wrongKey = Base64.getEncoder().encodeToString(KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic().getEncoded());
        fails(() -> ManifestSecurity.verify(original, signature, wrongKey));

        Path root = Files.createTempDirectory("udmc-security-test-");
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<byte[]> manifestBody = new AtomicReference<>();
        AtomicReference<String> manifestSignature = new AtomicReference<>();
        Map<String, byte[]> blobs = new HashMap<>();
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            byte[] body = "/manifest".equals(path) ? manifestBody.get() : blobs.get(path);
            if ("/manifest".equals(path) && manifestSignature.get() != null) exchange.getResponseHeaders().set("x-udmc-signature", manifestSignature.get());
            if (body == null) { exchange.sendResponseHeaders(404, -1); exchange.close(); return; }
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            UdmcConfig config = new UdmcConfig();
            config.serverUrl = "http://127.0.0.1:" + server.getAddress().getPort();
            config.requireSignedManifest = true;
            config.allowInsecureHttp = true;
            config.manifestPublicKey = publicKey;
            var manifest = new ManifestModels.Manifest();
            manifest.releaseSequence = 1;
            var first = file("config/a.json", "first", blobs);
            var second = file("mods/b.jar", "second", blobs);
            manifest.files = List.of(first, second);
            manifest.minecraft.loader.type = config.loaderType.equals("fabric") ? "neoforge" : "fabric";
            setManifest(manifestBody, manifestSignature, manifest, privateKey);
            fails(() -> ModSynchronizer.syncClient(root, config));
            check(!Files.exists(root.resolve(first.path)), "Wrong loader must not write files, even at the same Minecraft version");
            manifest.minecraft.loader.type = config.loaderType;
            manifest.minecraft.version = "wrong-minecraft-version";
            setManifest(manifestBody, manifestSignature, manifest, privateKey);
            fails(() -> ModSynchronizer.syncClient(root, config));
            check(!Files.exists(root.resolve(first.path)), "Wrong Minecraft version must not write files");
            manifest.minecraft.version = config.minecraftVersion;
            setManifest(manifestBody, manifestSignature, manifest, privateKey);
            blobs.put(second.downloadPath, "wrong!".getBytes(StandardCharsets.UTF_8));
            fails(() -> ModSynchronizer.syncClient(root, config));
            check(!Files.exists(root.resolve(first.path)), "A failed batch must not apply its first download");
            blobs.put(second.downloadPath, TestMods.jar("second", "1.0.0"));
            manifestSignature.set(null);
            fails(() -> ModSynchronizer.syncClient(root, config));
            check(!Files.exists(root.resolve(first.path)), "Unsigned manifest must not write files");
            setManifest(manifestBody, manifestSignature, manifest, privateKey);
            var result = ModSynchronizer.syncClient(root, config);
            check(result.downloaded == 2, "Expected two downloads");
            Files.write(root.resolve("mods/personal.jar"), TestMods.jar("personal", "1.0.0"));
            manifest.releaseSequence = 2;
            manifest.files = List.of(first);
            setManifest(manifestBody, manifestSignature, manifest, privateKey);
            result = ModSynchronizer.syncClient(root, config);
            check(result.removed == 1 && Files.exists(root.resolve("mods/personal.jar")), "Only managed files may be removed");
            manifest.releaseSequence = 1;
            setManifest(manifestBody, manifestSignature, manifest, privateKey);
            fails(() -> ModSynchronizer.syncClient(root, config));
            manifest.releaseSequence = 3;
            var conflict = file("mods/personal.jar", "replacement", blobs);
            manifest.files = List.of(first, conflict);
            setManifest(manifestBody, manifestSignature, manifest, privateKey);
            fails(() -> ModSynchronizer.syncClient(root, config));
            check(ModMetadata.read(root.resolve("mods/personal.jar"), "personal").getFirst().id().equals("personal"), "Personal file must not be overwritten");
            config.allowInsecureHttp = false;
            fails(() -> ModSynchronizer.fetchManifest(config));
            config.allowInsecureHttp = true;
            config.manifestPublicKey = wrongKey;
            fails(() -> ModSynchronizer.fetchManifest(config));
            config.manifestPublicKey = publicKey;
            manifest.releaseSequence = 4;
            var reused = file("mods/canonical.jar", "reused", blobs);
            Files.write(root.resolve("mods/my-renamed.jar"), blobs.get(reused.downloadPath));
            manifest.files = List.of(first, reused);
            setManifest(manifestBody, manifestSignature, manifest, privateKey);
            ModSynchronizer.syncClient(root, config);
            check(!Files.exists(root.resolve("mods/canonical.jar")), "Must not duplicate a renamed identical mod");
            manifest.releaseSequence = 5;
            manifest.files = List.of(first);
            setManifest(manifestBody, manifestSignature, manifest, privateKey);
            ModSynchronizer.syncClient(root, config);
            check(Files.exists(root.resolve("mods/my-renamed.jar")), "Borrowed personal mod must not be deleted by later publication");

            Path serverDir = root.resolve("server");
            Files.createDirectories(serverDir.resolve("mods"));
            Files.write(serverDir.resolve("mods/existing.jar"), TestMods.jar("existing", "1.0.0"));
            ManifestStore store = new ManifestStore(serverDir, new UdmcConfig());
            check(((List<?>) store.inventory().get("files")).size() == 1, "Unmanaged file should appear in inventory");
            fails(() -> store.importServerFile("mods/existing.jar", "server", "stale"));
            store.importServerFile("mods/existing.jar", "server", Hashes.sha256(serverDir.resolve("mods/existing.jar")));
            store.publish(null);
            store.deleteFile("mods/existing.jar");
            store.publish(null);
            check(!Files.exists(serverDir.resolve("mods/existing.jar")), "Adopted file should be removable after publication");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
                zip.putNextEntry(new ZipEntry("udmc-bootstrap.json"));
                zip.write("secret".getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
            byte[] agent = bytes.toByteArray();
            fails(() -> store.upsertFile("mods/renamed.jar", "both", agent));
            check(!Files.exists(store.blobPath(Hashes.sha256(agent) + ".jar")), "Rejected agent must not create a downloadable secret blob");
            System.out.println("Security tests passed: signatures, HTTPS policy, replay, transactional downloads, personal files, server adoption, secret JAR protection.");
        } finally {
            server.stop(0);
            TestMods.deleteTree(root);
        }
    }

    private static ManifestModels.ManifestFile file(String path, String text, Map<String, byte[]> blobs) throws Exception {
        byte[] body = path.endsWith(".jar") ? TestMods.jar(text, "1.0.0") : text.getBytes(StandardCharsets.UTF_8);
        var file = new ManifestModels.ManifestFile();
        file.path = path; file.side = "both"; file.size = body.length; file.sha256 = Hashes.sha256(body);
        file.downloadPath = "/files/" + file.sha256 + ".bin";
        blobs.put(file.downloadPath, body);
        return file;
    }
    private static void setManifest(AtomicReference<byte[]> body, AtomicReference<String> signature, ManifestModels.Manifest manifest, String key) throws Exception {
        body.set(GSON.toJson(manifest).getBytes(StandardCharsets.UTF_8));
        signature.set(ManifestSecurity.sign(body.get(), key));
    }
    private static void fails(Checked action) throws Exception {
        try { action.run(); } catch (Exception expected) { return; }
        throw new AssertionError("Expected failure");
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    private interface Checked { void run() throws Exception; }
}
