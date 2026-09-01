package dev.udmc.sync;

import com.google.gson.Gson;
import dev.udmc.sync.update.AgentUpdateHelper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;

final class AgentUpdater {
    private AgentUpdater() {}

    static Path installed(Path gameDir) throws IOException {
        return installed(gameDir, LoaderPlatform.agentPath());
    }

    static Path installed(Path gameDir, Path path) throws IOException {
        Path root = gameDir.toRealPath();
        Path absolute = path.toAbsolutePath().normalize();
        if (!absolute.startsWith(root)) throw Messages.error("udmc_sync.error.agent_install");
        String relative = root.relativize(absolute).toString().replace('\\', '/');
        if (!relative.matches("mods/[^/]+\\.jar")) throw Messages.error("udmc_sync.error.agent_install");
        Path checked = AgentUpdateHelper.safe(root, relative);
        if (!Files.isRegularFile(checked) || !AgentFiles.isAgent(checked)) throw Messages.error("udmc_sync.error.agent_install");
        return checked;
    }

    /** True when the running agent has reached the version a record was aiming for. */
    private static boolean superseded(String running, String target) {
        try {
            return AgentPackages.compareVersions(running, target) >= 0;
        } catch (IOException error) {
            // An unreadable version cannot be compared; fall back to the exact match this
            // check used to be, which is the safe half of the answer.
            return running.equals(target);
        }
    }

    static Map<String, Object> status(Path gameDir) throws IOException {
        Path directory = ManagedPaths.internal(gameDir, "agent-update");
        Path task = directory.resolve("task.properties"), result = directory.resolve("result.properties");
        if (!Files.exists(task)) return Map.of("state", "idle");
        Properties settings = AgentUpdateHelper.read(task);
        // Which process is doing the work is recorded beside the task, not inside it: the
        // helper opens the task file the moment it starts, and Windows will not let a file be
        // replaced while it is open. Rewriting it to add the helper's own id lost that race.
        Path helperFile = directory.resolve("helper.properties");
        Properties helper = Files.exists(helperFile) ? AgentUpdateHelper.read(helperFile) : settings;
        Properties state = Files.exists(result) ? AgentUpdateHelper.read(result) : new Properties();
        String value = state.getProperty("state", "scheduled");
        // Self-heal: the agent answering this request IS the installed agent. If it is already
        // at or past the version the record was aiming for, that update has arrived - by the
        // helper, by an in-place swap, or because someone replaced the file by hand.
        //
        // "At or past", not "equal to": replacing the JAR by hand with a newer build leaves the
        // old record behind, and reading it as an update still waiting made the panel ask for a
        // restart that had already happened and would never make the message go away.
        String running = PlatformDefaults.get("agentVersion");
        String targetVersion = settings.getProperty("version", "");
        if (!targetVersion.isEmpty() && !Set.of("scheduled", "waiting").contains(value)
            && superseded(running, targetVersion)) {
            // Reported as the running version rather than the record's: what is installed is
            // what the panel has to compare against, and they are the same thing now.
            return Map.of("state", "applied", "version", running, "backup", "udmc-sync/agent-update/previous.jar");
        }
        String code = null, message = null;
        if (value.equals("scheduled") || value.equals("waiting")) {
            String helperPid = helper.getProperty("helperPid"), helperStart = helper.getProperty("helperStart");
            if (helperPid != null && helperStart != null && !AgentUpdateHelper.isSameProcess(Long.parseLong(helperPid), helperStart)) {
                value = "interrupted";
            }
        }
        if (value.equals("interrupted")) {
            code = "AGENT_UPDATE_INTERRUPTED";
            message = "The agent update process was interrupted.";
        } else if (value.equals("failed")) {
            code = "AGENT_UPDATE_FAILED";
            message = "The agent update failed. Check the helper log before retrying.";
        } else if (!Set.of("idle", "scheduled", "waiting", "applied").contains(value)) {
            value = "failed";
            code = "AGENT_UPDATE_STATUS_INVALID";
            message = "The stored agent update status is invalid.";
        }
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("state", value);
        response.put("version", settings.getProperty("version", ""));
        response.put("backup", "udmc-sync/agent-update/previous.jar");
        if (code != null) {
            response.put("code", code);
            response.put("args", List.of());
            response.put("message", message);
        }
        return response;
    }

    static void requireIdle(Path gameDir) throws IOException {
        String state = String.valueOf(status(gameDir).get("state"));
        if (state.equals("waiting") || state.equals("scheduled")) throw new IOException("An agent update is already waiting for shutdown");
    }

    static void schedule(Path gameDir, Path installed, Path staged, AgentRelease release, UdmcConfig config, String role) throws IOException {
        try {
            Properties descriptor = release.verify(config, role);
            Path current = installed(gameDir, installed);
            if (Hashes.sha256(current).equals(descriptor.getProperty("sha256"))) return;
            requireIdle(gameDir);
            AgentPackages.validate(staged, config, role.equals("client"));
            if (!Hashes.sha256(staged).equals(descriptor.getProperty("sha256")) || Files.size(staged) != Long.parseLong(descriptor.getProperty("size"))) throw new IOException("Invalid staged agent hash or size");
            Path root = gameDir.toRealPath();
            Path directory = AgentUpdateHelper.safe(root, "udmc-sync/agent-update");
            Files.createDirectories(directory);
            for (String name : new String[]{"task.properties", "result.properties", "helper.jar", "new.jar", "helper.log", "previous.jar", "replacement.jar", "helper.lock"}) AgentUpdateHelper.safe(root, "udmc-sync/agent-update/" + name);
            Files.copy(staged, directory.resolve("new.jar"), StandardCopyOption.REPLACE_EXISTING);
            // On POSIX filesystems a loaded jar can be replaced in place: the running JVM
            // keeps the old inode until exit and the next start loads the new file. This
            // avoids the external helper entirely - container hosts kill the whole process
            // tree on stop, which used to strand the helper. Windows locks the jar, so the
            // helper flow below stays the fallback there and on any in-place failure.
            if (!System.getProperty("os.name").toLowerCase(java.util.Locale.ROOT).contains("win")) {
                try {
                    Files.copy(current, directory.resolve("previous.jar"), StandardCopyOption.REPLACE_EXISTING);
                    Path replacement = directory.resolve("replacement.jar");
                    Files.copy(directory.resolve("new.jar"), replacement, StandardCopyOption.REPLACE_EXISTING);
                    Files.move(replacement, current, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                    if (!Hashes.sha256(current).equals(descriptor.getProperty("sha256"))) throw new IOException("In-place agent swap verification failed");
                    Properties task = new Properties();
                    task.setProperty("root", root.toString());
                    task.setProperty("version", descriptor.getProperty("version"));
                    AgentUpdateHelper.write(directory.resolve("task.properties"), task);
                    Properties applied = new Properties();
                    applied.setProperty("state", "applied");
                    AgentUpdateHelper.write(directory.resolve("result.properties"), applied);
                    UdmcSync.LOGGER.info("Agent update {} applied in place; it loads on the next start.", descriptor.getProperty("version"));
                    return;
                } catch (Exception inPlace) {
                    UdmcSync.LOGGER.warn("In-place agent swap failed, falling back to the update helper", inPlace);
                    try { Files.move(directory.resolve("previous.jar"), current, StandardCopyOption.REPLACE_EXISTING); }
                    catch (Exception ignored) { /* current stays as verified below by the helper flow */ }
                }
            }
            // The helper is the already trusted installed agent, not code from the downloaded update.
            Files.copy(current, directory.resolve("helper.jar"), StandardCopyOption.REPLACE_EXISTING);
            var process = ProcessHandle.current();
            Properties task = new Properties();
            task.setProperty("root", root.toString());
            task.setProperty("target", root.relativize(current).toString().replace('\\', '/'));
            task.setProperty("oldHash", Hashes.sha256(current));
            task.setProperty("body", release.body()); task.setProperty("signature", release.signature()); task.setProperty("publicKey", config.manifestPublicKey);
            task.setProperty("packId", config.packId); task.setProperty("role", role); task.setProperty("version", descriptor.getProperty("version"));
            task.setProperty("pid", Long.toString(process.pid()));
            task.setProperty("processStart", process.info().startInstant().orElseThrow(() -> new IOException("Cannot identify the running JVM")).toString());
            Files.deleteIfExists(directory.resolve("result.properties"));
            Files.deleteIfExists(directory.resolve("helper.properties"));
            Path taskFile = directory.resolve("task.properties");
            AgentUpdateHelper.write(taskFile, task);
            String executable = System.getProperty("os.name").toLowerCase(java.util.Locale.ROOT).contains("win") ? "javaw.exe" : "java";
            Path java = Path.of(System.getProperty("java.home"), "bin", executable);
            try {
                var helper = new ProcessBuilder(java.toString(), "-Xmx48m", "-cp", directory.resolve("helper.jar").toString(),
                    AgentUpdateHelper.class.getName(), taskFile.toString()).directory(root.toFile())
                    .redirectErrorStream(true).redirectOutput(directory.resolve("helper.log").toFile()).start();
                Properties record = new Properties();
                record.setProperty("helperPid", Long.toString(helper.pid()));
                record.setProperty("helperStart", helper.info().startInstant().orElseThrow(() -> new IOException("Cannot identify update helper")).toString());
                AgentUpdateHelper.write(directory.resolve("helper.properties"), record);
            } catch (IOException error) {
                Files.deleteIfExists(taskFile);
                throw new IOException("Cannot start agent updater. No installed files were changed", error);
            }
        } catch (IOException error) { throw error; }
        catch (Exception error) { throw new IOException("Cannot prepare agent update", error); }
    }

    static boolean checkClient(Path gameDir, UdmcConfig config, ModSynchronizer.Progress progress) throws Exception {
        if (config.manifestPublicKey.isBlank() || !config.requireSignedManifest) return false;
        URI base = URI.create(config.serverUrl);
        if (!"https".equals(base.getScheme()) && !("http".equals(base.getScheme()) && config.allowInsecureHttp)) throw Messages.error("udmc_sync.error.https");
        if (base.getHost() == null || base.getUserInfo() != null || base.getQuery() != null || base.getFragment() != null) throw Messages.error("udmc_sync.error.url");
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        var request = HttpRequest.newBuilder(URI.create(config.serverUrl.replaceAll("/+$", "") + "/agents/client")).timeout(Duration.ofSeconds(30)).GET().build();
        AgentRelease release = fetchRelease(http, request);
        if (release == null) return false;
        Properties descriptor = release.verify(config, "client");
        Path sequenceFile = ManagedPaths.internal(gameDir, "agent-sequence.properties");
        long sequence = Long.parseLong(descriptor.getProperty("sequence"));
        long seen = Files.exists(sequenceFile) ? Long.parseLong(AgentUpdateHelper.read(sequenceFile).getProperty("sequence", "0")) : 0;
        if (sequence < seen) throw Messages.error("udmc_sync.error.replay");
        Path current = installed(gameDir);
        // Only when this client is behind. It used to fire on any difference in bytes, which
        // meant a player whose launcher had already installed a newer build got it overwritten
        // with an older one - and the launcher put its own back, and round it went. Being ahead
        // is allowed at the door too, so there is nothing to correct.
        String running = PlatformDefaults.get("agentVersion"), published = descriptor.getProperty("version", "");
        if (published.isBlank() || AgentPackages.compareVersions(running, published) >= 0) {
            rememberSequence(sequenceFile, sequence);
            return false;
        }
        String pending = String.valueOf(status(gameDir).get("state"));
        if (pending.equals("waiting") || pending.equals("scheduled")) return true;
        progress.update("UDMC " + descriptor.getProperty("version"), 0, Long.parseLong(descriptor.getProperty("size")));
        Path tempDir = ManagedPaths.internal(gameDir, "agent-downloads");
        Files.createDirectories(tempDir);
        Path downloaded = Files.createTempFile(tempDir, "client-", ".jar");
        try {
            var download = HttpRequest.newBuilder(URI.create(config.serverUrl.replaceAll("/+$", "") + "/agents/files/" + descriptor.getProperty("sha256") + ".jar"))
                .timeout(Duration.ofMinutes(2)).GET().build();
            var response = http.send(download, HttpResponse.BodyHandlers.ofInputStream());
            try (var input = response.body(); var output = Files.newOutputStream(downloaded)) {
                if (response.statusCode() != 200) throw Messages.error("udmc_sync.error.agent_http", response.statusCode());
                long size = Long.parseLong(descriptor.getProperty("size")), total = 0;
                byte[] buffer = new byte[65536]; int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > size) throw Messages.error("udmc_sync.error.agent_size");
                    output.write(buffer, 0, count); progress.update("UDMC " + descriptor.getProperty("version"), total, size);
                }
                if (total != size) throw Messages.error("udmc_sync.error.agent_size");
            }
            schedule(gameDir, current, downloaded, release, config, "client");
            rememberSequence(sequenceFile, sequence);
            return true;
        } finally { Files.deleteIfExists(downloaded); }
    }

    private static AgentRelease fetchRelease(HttpClient http, HttpRequest request) throws Exception {
        var response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
        try (var input = response.body()) {
            if (response.statusCode() == 404) return null;
            if (response.statusCode() != 200) throw Messages.error("udmc_sync.error.agent_http", response.statusCode());
            byte[] bytes = input.readNBytes(16385);
            if (bytes.length > 16384) throw Messages.error("udmc_sync.error.agent_size");
            var release = new Gson().fromJson(new String(bytes, StandardCharsets.UTF_8), AgentRelease.class);
            if (release == null) throw new IOException("Invalid agent release");
            return release;
        }
    }

    private static void rememberSequence(Path path, long sequence) throws IOException {
        Files.createDirectories(path.getParent());
        Properties state = new Properties(); state.setProperty("sequence", Long.toString(sequence));
        AgentUpdateHelper.write(path, state);
    }
}
