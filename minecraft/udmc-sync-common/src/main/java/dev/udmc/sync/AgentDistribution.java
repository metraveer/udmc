package dev.udmc.sync;

import com.google.gson.Gson;
import dev.udmc.sync.update.AgentUpdateHelper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.zip.ZipFile;

/** All commits are serialized by the same lock as the modpack workspace. */
final class AgentDistribution {
    private static final Gson GSON = new Gson();
    private final Path gameDir;
    private final UdmcConfig config;
    private final Path installedOverride;

    AgentDistribution(Path gameDir, UdmcConfig config) { this(gameDir, config, null); }
    AgentDistribution(Path gameDir, UdmcConfig config, Path installedOverride) {
        this.gameDir = gameDir; this.config = config; this.installedOverride = installedOverride;
    }

    Map<String, Object> describe() throws IOException {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("protocol", 1);
        result.put("currentVersion", PlatformDefaults.get("agentVersion"));
        result.put("requireClient", config.requireClientAgent);
        result.put("gameAddress", config.gameAddress);
        result.put("downloadUrl", downloadUrl());
        result.put("instructionsUrl", config.serverUrl.replaceAll("/+$", "") + "/agents/install");
        result.put("signed", !config.manifestPublicKey.isBlank() && !config.manifestPrivateKey.isBlank());
        result.put("clientBootstrap", clientBootstrap());
        AgentRelease release = release();
        if (release != null) {
            Properties descriptor = release.verify(config, "client");
            result.put("client", Map.of("version", descriptor.getProperty("version"), "sha256", descriptor.getProperty("sha256"), "sequence", descriptor.getProperty("sequence")));
        }
        result.put("update", AgentUpdater.status(gameDir));
        try { installed(); result.put("canUpdate", true); }
        catch (IOException | RuntimeException error) {
            result.put("canUpdate", false);
            result.put("updateReason", Map.of(
                "code", "AGENT_UPDATE_PACKAGED_REQUIRED",
                "args", List.of(),
                "message", "Run a packaged UDMC server agent before using remote agent updates."
            ));
        }
        return result;
    }

    Map<String, Object> clientBootstrap() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("role", "client"); value.put("packId", config.packId); value.put("packName", config.packName);
        value.put("serverUrl", config.serverUrl.replaceAll("/+$", ""));
        value.put("manifestPublicKey", config.manifestPublicKey); value.put("requireSignedManifest", true);
        value.put("allowInsecureHttp", config.allowInsecureHttp); value.put("minecraftVersion", config.minecraftVersion);
        value.put("loaderType", config.loaderType); value.put("loaderVersion", config.loaderVersion);
        return value;
    }

    AgentRelease release() throws IOException {
        Path path = ManagedPaths.internal(gameDir, "agents/client-release.json");
        if (!Files.exists(path)) return null;
        if (Files.size(path) > 16384) throw new IOException("Invalid stored agent release");
        var result = GSON.fromJson(Files.readString(path), AgentRelease.class);
        if (result == null) throw new IOException("Invalid stored agent release");
        result.verify(config, "client");
        return result;
    }

    String downloadUrl() { return config.serverUrl.replaceAll("/+$", "") + "/agents/download"; }
    String instructionsUrl() { return config.serverUrl.replaceAll("/+$", "") + "/agents/install"; }

    Path publicFile(String name) throws IOException {
        if (!name.matches("[a-f0-9]{64}\\.jar")) throw new ApiException(400, "CLIENT_AGENT_FILE_INVALID", "Invalid client agent file name.");
        Path file = ManagedPaths.internal(gameDir, "agents/public/" + name);
        if (!Files.isRegularFile(file)) throw new java.nio.file.NoSuchFileException(name);
        return file;
    }

    Path latestFile() throws IOException {
        var release = release();
        if (release == null) throw new java.nio.file.NoSuchFileException("Client agent has not been uploaded by Control yet");
        return publicFile(release.verify(config, "client").getProperty("sha256") + ".jar");
    }

    Map<String, Object> publishClient(Path jar) throws IOException {
        if (config.manifestPrivateKey.isBlank() || config.manifestPublicKey.isBlank()) throw new ApiException(409, "AGENT_SIGNING_REQUIRED", "A signed project is required for agent distribution.");
        String version = AgentPackages.validate(jar, config, true);
        AgentRelease previous = release();
        long sequence = previous == null ? 1 : Long.parseLong(previous.verify(config, "client").getProperty("sequence")) + 1;
        if (previous != null && previous.verify(config, "client").getProperty("sha256").equals(Hashes.sha256(jar))) return describe();
        AgentRelease next = AgentRelease.sign(jar, "client", version, sequence, config);
        String hash = next.verify(config, "client").getProperty("sha256");
        Path file = ManagedPaths.internal(gameDir, "agents/public/" + hash + ".jar");
        Files.createDirectories(file.getParent());
        if (!Files.exists(file)) Files.copy(jar, file);
        if (!Hashes.sha256(file).equals(hash)) throw new IOException("Stored client agent hash mismatch");
        Path path = ManagedPaths.internal(gameDir, "agents/client-release.json");
        Path temporary = ManagedPaths.internal(gameDir, "agents/client-release.tmp");
        Files.writeString(temporary, GSON.toJson(next), StandardCharsets.UTF_8);
        try { Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
        catch (java.nio.file.AtomicMoveNotSupportedException error) { Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING); }
        return describe();
    }

    Map<String, Object> update(Path bundle) throws IOException {
        AgentUpdater.requireIdle(gameDir);
        Path installed = installed();
        Path directory = Files.createTempDirectory(ManagedPaths.internal(gameDir, "agent-incoming"), "bundle-");
        Path client = null, server = null;
        try (var zip = new ZipFile(bundle.toFile())) {
            if (zip.size() != 2 || zip.getEntry("client.jar") == null || zip.getEntry("server.jar") == null) throw new ApiException(400, "AGENT_BUNDLE_INVALID", "Expected the client and server agent bundle from Control.");
            try (var input = zip.getInputStream(zip.getEntry("client.jar"))) { client = AgentPackages.receive(input, directory); }
            try (var input = zip.getInputStream(zip.getEntry("server.jar"))) { server = AgentPackages.receive(input, directory); }
            String version = AgentPackages.validate(client, config, true);
            if (!version.equals(AgentPackages.validate(server, config, false))) throw new ApiException(400, "AGENT_BUNDLE_VERSION_MISMATCH", "Client and server agent versions do not match.");
            var old = release();
            long sequence = old == null ? 1 : Long.parseLong(old.verify(config, "client").getProperty("sequence")) + 1;
            AgentRelease serverRelease = AgentRelease.sign(server, "server", version, sequence, config);
            AgentUpdater.schedule(gameDir, installed, server, serverRelease, config, "server");
            return publishClient(client);
        } finally {
            if (client != null) Files.deleteIfExists(client);
            if (server != null) Files.deleteIfExists(server);
            Files.deleteIfExists(directory);
        }
    }

    void setRequired(boolean required) throws IOException {
        if (required && release() == null) throw new ApiException(409, "CLIENT_AGENT_UPLOAD_REQUIRED", "Upload the client agent before requiring it to join.");
        boolean previous = config.requireClientAgent;
        config.requireClientAgent = required;
        try { config.save(gameDir); }
        catch (RuntimeException error) { config.requireClientAgent = previous; throw error; }
    }

    void setGameAddress(String address) throws IOException {
        String normalized;
        try { normalized = UdmcConfig.normalizeGameAddress(address); }
        catch (IllegalArgumentException error) {
            throw new ApiException(400, "GAME_ADDRESS_INVALID", "Enter the game address as host or host:port, or leave it empty.");
        }
        String previous = config.gameAddress;
        config.gameAddress = normalized;
        try { config.save(gameDir); }
        catch (RuntimeException error) { config.gameAddress = previous; throw error; }
    }

    private Path installed() throws IOException {
        return installedOverride == null ? AgentUpdater.installed(gameDir) : AgentUpdater.installed(gameDir, installedOverride);
    }
}
