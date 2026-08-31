package dev.udmc.sync;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.ZipFile;

final class AgentPackages {
    static final long MAX_BYTES = 16L * 1024 * 1024;
    private static final Set<String> CLIENT_KEYS = Set.of("role", "packId", "packName", "serverUrl", "templateId", "manifestPublicKey",
        "requireSignedManifest", "allowInsecureHttp", "minecraftVersion", "loaderType", "loaderVersion", "bootstrapId");

    private AgentPackages() {}

    static String validate(Path jar, UdmcConfig config, boolean client) throws IOException {
        if (Files.size(jar) < 1 || Files.size(jar) > MAX_BYTES) throw new ApiException(400, "AGENT_JAR_SIZE_INVALID", "Invalid agent JAR size.");
        try (var zip = new ZipFile(jar.toFile())) {
            Set<String> names = new HashSet<>();
            long total = 0;
            var entries = zip.entries();
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                if (!names.add(entry.getName()) || names.size() > 4096 || entry.getSize() < 0 || entry.getSize() > MAX_BYTES) throw new ApiException(400, "AGENT_ARCHIVE_INVALID", "Invalid agent archive entries.");
                total += entry.getSize();
                if (total > 32L * 1024 * 1024) throw new ApiException(400, "AGENT_ARCHIVE_TOO_LARGE", "Expanded agent archive is too large.");
            }
            if (!LoaderPlatform.isAgent(zip) || zip.getEntry("dev/udmc/sync/update/AgentUpdateHelper.class") == null) throw new ApiException(400, "AGENT_NOT_UPDATE_CAPABLE", "This is not an update-capable UDMC agent.");
            var metadata = zip.getEntry("udmc-platform.properties");
            if (metadata == null) throw new ApiException(400, "AGENT_METADATA_INVALID", "Agent platform metadata is missing.");
            var platform = new java.util.Properties();
            try (var input = zip.getInputStream(metadata)) { platform.load(input); }
            if (!config.minecraftVersion.equals(platform.getProperty("minecraft")) || !config.loaderType.equals(platform.getProperty("loader"))) throw new ApiException(400, "AGENT_PLATFORM_MISMATCH", "Agent is for another Minecraft version or loader.");
            String version = platform.getProperty("agentVersion");
            if (version == null || !version.matches("[0-9]+\\.[0-9]+\\.[0-9]+")) throw new ApiException(400, "AGENT_VERSION_INVALID", "Invalid agent version.");
            String installed = PlatformDefaults.get("agentVersion");
            if (installed != null && compareVersions(version, installed) < 0) throw new ApiException(409, "AGENT_DOWNGRADE_FORBIDDEN", "An older Control cannot downgrade the running agent.");
            if (!version.equals(LoaderPlatform.validateAgent(zip, config, client))) throw new ApiException(400, "AGENT_VERSION_INVALID", "Agent version metadata is inconsistent.");
            // One mod serves every server and every player, so a file with settings baked in
            // can only be a leftover from before that - and those carried project secrets.
            if (zip.getEntry("udmc-bootstrap.json") != null) {
                throw new ApiException(400, "AGENT_BOOTSTRAP_FORBIDDEN",
                    "This is an older personalised UDMC file with settings baked in. Use the current mod, which is the same file for the server and for players.");
            }
            return version;
        } catch (IllegalStateException | com.google.gson.JsonParseException | java.util.zip.ZipException error) {
            throw new ApiException(400, "AGENT_METADATA_INVALID", "Agent metadata is invalid.");
        }
    }

    static int compareVersions(String a, String b) throws IOException {
        try {
            String[] left = a.split("\\."), right = b.split("\\.");
            if (left.length != 3 || right.length != 3) throw new NumberFormatException();
            for (int i = 0; i < 3; i++) {
                int order = Integer.compare(Integer.parseInt(left[i]), Integer.parseInt(right[i]));
                if (order != 0) return order;
            }
            return 0;
        } catch (NumberFormatException error) { throw new ApiException(400, "AGENT_VERSION_INVALID", "Invalid agent version."); }
    }

    static Path receive(InputStream input, Path directory) throws IOException {
        Files.createDirectories(directory);
        Path temp = Files.createTempFile(directory, "incoming-", ".jar");
        try (var output = Files.newOutputStream(temp)) {
            byte[] buffer = new byte[65536];
            long total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > MAX_BYTES) throw new ApiException(413, "AGENT_UPLOAD_TOO_LARGE", "Agent upload exceeds 16 MiB.");
                output.write(buffer, 0, count);
            }
            return temp;
        } catch (IOException | RuntimeException error) { Files.deleteIfExists(temp); throw error; }
    }

    private static String string(JsonObject value, String name) {
        return value.has(name) && value.get(name).isJsonPrimitive() ? value.get(name).getAsString() : "";
    }
}
