package dev.udmc.sync;

import java.util.List;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.LinkedHashMap;
import java.util.HashSet;
import java.util.Locale;

public final class ModSynchronizer {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final String STATE_DIRECTORY = "udmc-sync";
    private static final String STATE_FILE = "client-state.json";
    private static final String LEGACY_STATE_FILE = ".udmc-managed.json";

    private ModSynchronizer() {
    }

    public static SyncResult syncClient(Path gameDir, UdmcConfig config) throws Exception {
        return syncClient(gameDir, config, (file, done, total) -> {});
    }

    @FunctionalInterface
    public interface Progress {
        void update(String file, long done, long total);
        default void stage(Messages.Message message) {}
    }

    public static SyncResult syncClient(Path gameDir, UdmcConfig config, Progress progress) throws Exception {
        progress.stage(Messages.of("udmc_sync.progress.signature"));
        ManifestModels.Manifest manifest = fetchManifest(config);
        ManifestModels.ManagedState state = readState(gameDir);
        if (state.packId != null && !state.packId.equals(manifest.pack.id)) {
            throw Messages.error("udmc_sync.error.other_pack");
        }
        if (manifest.releaseSequence < state.releaseSequence) {
            throw Messages.error("udmc_sync.error.replay");
        }
        Map<String, ManifestModels.ManifestFile> desired = new HashMap<>();
        Map<String, ManifestModels.ManagedFile> oldFiles = new HashMap<>();
        for (var file : state.files) oldFiles.put(file.destPath, file);
        SyncResult result = new SyncResult();
        result.packVersion = manifest.pack.version;
        Path staging = Files.createTempDirectory(gameDir, "udmc-sync-update-");
        Map<Path, Path> downloads = new LinkedHashMap<>();
        Map<Path, Path> backups = new LinkedHashMap<>();
        boolean retainBackups = false;
        try {
        HashSet<String> paths = new HashSet<>();
        for (ManifestModels.ManifestFile file : manifest.files) {
            String destPath = ManagedPaths.normalize(file.path);
            ManagedPaths.requireSide(file.side);
            if (!paths.add(destPath.toLowerCase(Locale.ROOT)) || file.sha256 == null
                || !file.sha256.matches("[a-f0-9]{64}") || file.size < 0 || file.size > 512L * 1024 * 1024
                || file.downloadPath == null || !file.downloadPath.matches("/files/" + file.sha256 + "(\\.[A-Za-z0-9_-]{1,16})?")) {
                throw Messages.error("udmc_sync.error.manifest_file", destPath);
            }
            if (!ManagedPaths.neededFor(file.side, "client")) {
                continue;
            }
            desired.put(destPath, file);
            Path target = ManagedPaths.resolve(gameDir, destPath);
            String currentHash = Files.exists(target) ? Hashes.sha256(target) : null;

            if (Objects.equals(currentHash, file.sha256)) {
                result.skipped++;
                continue;
            }

            Path downloaded = staging.resolve("download-" + downloads.size());
            downloadFile(config.serverUrl, file, downloaded, progress);
            downloads.put(target, downloaded);
            result.downloaded++;
        }

        progress.stage(Messages.of("udmc_sync.progress.mods"));
        int beforeCheck = downloads.size();
        var outcome = ClientModCheck.check(gameDir, config, desired, downloads, oldFiles);
        var borrowed = outcome.borrowed();
        result.standIns = List.copyOf(outcome.standIns().values());
        // Told once: a file the player has already been told about is not news on every launch.
        result.newStandIns = result.standIns.stream().filter(standIn -> !state.standIns.contains(standIn.theirs())).toList();
        result.skipped += beforeCheck - downloads.size();
        result.downloaded = downloads.size();
        for (ManifestModels.ManagedFile oldFile : state.files) {
            if (oldFile.borrowed) continue;
            if (desired.containsKey(oldFile.destPath)) {
                continue;
            }

            Path target = ManagedPaths.resolve(gameDir, oldFile.destPath);

            if (!Files.exists(target)) {
                continue;
            }

            String currentHash = Hashes.sha256(target);

            if (!Objects.equals(currentHash, oldFile.sha256)) {
                result.retainedModified++;
                continue;
            }

            backups.put(target, staging.resolve("backup-" + backups.size()));
            result.removed++;
        }
        for (Path target : downloads.keySet()) {
            backups.put(target, Files.exists(target) ? staging.resolve("backup-" + backups.size()) : null);
        }
        for (var entry : backups.entrySet()) {
            if (entry.getValue() != null) Files.copy(entry.getKey(), entry.getValue());
        }
        // All network and validation work finishes before any managed file is changed.
        try {
            for (Path target : backups.keySet()) {
                if (!downloads.containsKey(target)) Files.delete(target);
            }
            for (var entry : downloads.entrySet()) {
                Files.createDirectories(entry.getKey().getParent());
                replace(entry.getValue(), entry.getKey());
            }
            writeState(gameDir, manifest, desired, borrowed, result.standIns);
        } catch (Exception error) {
            for (var entry : backups.entrySet()) {
                try {
                    if (entry.getValue() == null) Files.deleteIfExists(entry.getKey());
                    else Files.copy(entry.getValue(), entry.getKey(), StandardCopyOption.REPLACE_EXISTING);
                } catch (Exception restoreError) {
                    error.addSuppressed(restoreError);
                    retainBackups = true;
                }
            }
            throw error;
        }
        return result;
        } finally {
            if (!retainBackups) {
                try (var files = Files.list(staging)) {
                    for (Path file : files.toList()) Files.deleteIfExists(file);
                }
                Files.deleteIfExists(staging);
            }
        }
    }

    /** Best-effort public join hint; connection problems or bad data simply mean "no known address". */
    static String fetchGameAddress(UdmcConfig config) {
        try {
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
            HttpRequest request = HttpRequest.newBuilder(URI.create(joinUrl(config.serverUrl, "/agents/info")))
                .timeout(Duration.ofSeconds(10)).GET().build();
            var response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() < 200 || response.statusCode() >= 300 || response.body().length > 16384) return "";
            var info = GSON.fromJson(new String(response.body(), StandardCharsets.UTF_8), com.google.gson.JsonObject.class);
            if (info == null || !info.has("gameAddress") || !info.get("gameAddress").isJsonPrimitive()) return "";
            return UdmcConfig.normalizeGameAddress(info.get("gameAddress").getAsString());
        } catch (Exception error) {
            UdmcSync.LOGGER.debug("No public game address available", error);
            return "";
        }
    }

    static ManifestModels.Manifest fetchManifest(UdmcConfig config) throws Exception {
        URI base = URI.create(config.serverUrl);
        if ((!"https".equals(base.getScheme()) && !"http".equals(base.getScheme())) || base.getHost() == null
            || base.getUserInfo() != null || base.getQuery() != null || base.getFragment() != null) {
            throw Messages.error("udmc_sync.error.url");
        }
        if (config.requireSignedManifest && !"https".equals(base.getScheme()) && !config.allowInsecureHttp) {
            throw Messages.error("udmc_sync.error.https");
        }
        HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(joinUrl(config.serverUrl, "/manifest")))
            .timeout(Duration.ofSeconds(30))
            .GET()
            .build();
        var response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
        try (var input = response.body()) {
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw Messages.error("udmc_sync.error.manifest_http", response.statusCode());
        }

        byte[] body = input.readNBytes(2 * 1024 * 1024 + 1);
        if (body.length > 2 * 1024 * 1024) throw Messages.error("udmc_sync.error.manifest_size");
        if (config.requireSignedManifest || !config.manifestPublicKey.isBlank()) {
            ManifestSecurity.verify(body, response.headers().firstValue("x-udmc-signature").orElse(null), config.manifestPublicKey);
        }
        var manifest = GSON.fromJson(new String(body, StandardCharsets.UTF_8), ManifestModels.Manifest.class);
        if (manifest == null || manifest.schemaVersion != 1 || manifest.pack == null || manifest.files == null
            || manifest.minecraft == null || !Objects.equals(manifest.pack.id, config.packId)
            || manifest.releaseSequence < 0) {
            throw Messages.error("udmc_sync.error.manifest_project");
        }
        if (config.requireSignedManifest && (!Objects.equals(config.minecraftVersion, manifest.minecraft.version)
            || manifest.minecraft.loader == null || !Objects.equals(config.loaderType, manifest.minecraft.loader.type))) {
            throw Messages.error("udmc_sync.error.platform");
        }
        return manifest;
        }
    }

    private static void downloadFile(String serverUrl, ManifestModels.ManifestFile file, Path target, Progress progress) throws Exception {
        progress.update(file.path, 0, file.size);
        HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(joinUrl(serverUrl, file.downloadPath)))
            .timeout(Duration.ofMinutes(5))
            .GET()
            .build();
        var response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
        try (var input = response.body()) {
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw Messages.error("udmc_sync.error.download_http", file.path, response.statusCode());
        }

        try (var output = Files.newOutputStream(target)) {
            byte[] buffer = new byte[65536];
            long total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > file.size) throw Messages.error("udmc_sync.error.download_size", file.path);
                output.write(buffer, 0, count);
                progress.update(file.path, total, file.size);
            }
            if (total != file.size) throw Messages.error("udmc_sync.error.download_size", file.path);
        }
        String actualHash = Hashes.sha256(target);

        if (!Objects.equals(actualHash, file.sha256)) {
            throw Messages.error("udmc_sync.error.hash", file.path);
        }

        }
    }

    private static ManifestModels.ManagedState readState(Path gameDir) throws IOException {
        Path statePath = gameDir.resolve(STATE_DIRECTORY).resolve(STATE_FILE);

        if (Files.exists(statePath)) {
            return readStateFile(statePath);
        }

        Path legacyStatePath = gameDir.resolve("mods").resolve(LEGACY_STATE_FILE);

        if (!Files.exists(legacyStatePath)) {
            return new ManifestModels.ManagedState();
        }

        ManifestModels.ManagedState legacyState = readStateFile(legacyStatePath);
        for (ManifestModels.ManagedFile file : legacyState.files) {
            if (!file.destPath.startsWith("mods/")) {
                file.destPath = "mods/" + file.destPath;
            }
        }
        return legacyState;
    }

    private static ManifestModels.ManagedState readStateFile(Path statePath) throws IOException {
        try (Reader reader = Files.newBufferedReader(statePath)) {
            ManifestModels.ManagedState state = GSON.fromJson(reader, ManifestModels.ManagedState.class);
            return state == null ? new ManifestModels.ManagedState() : state;
        }
    }

    private static void writeState(
        Path gameDir,
        ManifestModels.Manifest manifest,
        Map<String, ManifestModels.ManifestFile> desired,
        java.util.Set<String> borrowed,
        List<SyncResult.StandIn> standIns
    ) throws IOException {
        ManifestModels.ManagedState state = new ManifestModels.ManagedState();
        state.packId = manifest.pack.id;
        state.packVersion = manifest.pack.version;
        state.syncedAt = TimeUtil.nowIso();
        state.releaseSequence = manifest.releaseSequence;
        state.standIns = standIns.stream().map(SyncResult.StandIn::theirs).toList();

        for (Map.Entry<String, ManifestModels.ManifestFile> entry : desired.entrySet()) {
            ManifestModels.ManagedFile managedFile = new ManifestModels.ManagedFile();
            managedFile.destPath = entry.getKey();
            managedFile.manifestPath = entry.getValue().path;
            managedFile.sha256 = entry.getValue().sha256;
            managedFile.borrowed = borrowed.contains(entry.getKey());
            state.files.add(managedFile);
        }

        Path stateDirectory = gameDir.resolve(STATE_DIRECTORY);
        Files.createDirectories(stateDirectory);

        Path temporary = Files.createTempFile(stateDirectory, "state-", ".tmp");
        try (Writer writer = Files.newBufferedWriter(temporary)) {
            GSON.toJson(state, writer);
        }
        try {
            replace(temporary, stateDirectory.resolve(STATE_FILE));
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static void replace(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException error) {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static String joinUrl(String base, String path) {
        return base.replaceAll("/+$", "") + "/" + path.replaceAll("^/+", "");
    }
}
