package dev.udmc.sync.update;

import java.io.IOException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Properties;

/** Runs in a separate JVM using a copy of the installed agent, with no loader dependencies. */
public final class AgentUpdateHelper {
    private AgentUpdateHelper() {}

    public static void main(String[] args) throws Exception {
        boolean finish = args.length == 2 && args[0].equals("--finish");
        if (args.length != 1 && !finish) throw new IllegalArgumentException("Expected update task path");
        Path taskPath = Path.of(args[finish ? 1 : 0]).toAbsolutePath().normalize();
        Properties task = read(taskPath);
        Path root = Path.of(required(task, "root")).toRealPath();
        if (!taskPath.equals(safe(root, "udmc-sync/agent-update/task.properties"))) throw new IOException("Invalid update task location");
        Path directory = taskPath.getParent();
        try (var channel = FileChannel.open(directory.resolve("helper.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
             var lock = acquire(channel, finish)) {
            if (lock == null) return;
            Path result = directory.resolve("result.properties");
            try {
                Properties release = verify(required(task, "body"), required(task, "signature"), required(task, "publicKey"));
                if (!required(release, "packId").equals(required(task, "packId"))
                    || !required(release, "role").equals(required(task, "role"))) throw new IOException("Update project or role mismatch");
                writeResult(result, "waiting", "Waiting for Minecraft to exit");
                long pid = Long.parseLong(required(task, "pid"));
                String started = required(task, "processStart");
                while (isSameProcess(pid, started)) Thread.sleep(500);
                apply(root, task, release);
                writeResult(result, "applied", "Restart Minecraft to load the updated agent");
            } catch (Exception error) {
                writeResult(result, "failed", String.valueOf(error.getMessage()));
                throw error;
            }
        }
    }

    public static boolean isSameProcess(long pid, String started) {
        return ProcessHandle.of(pid).filter(ProcessHandle::isAlive)
            .map(process -> process.info().startInstant().map(instant -> instant.toString().equals(started)).orElse(true)).orElse(false);
    }

    public static Properties verify(String body, String signature, String key) throws Exception {
        byte[] bytes = Base64.getDecoder().decode(body);
        if (bytes.length > 8192) throw new IOException("Agent descriptor is too large");
        var verifier = Signature.getInstance("Ed25519");
        verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(key))));
        verifier.update(bytes);
        if (!verifier.verify(Base64.getDecoder().decode(signature))) throw new IOException("Invalid agent update signature");
        Properties release = new Properties();
        release.load(new ByteArrayInputStream(bytes));
        if (!"1".equals(release.getProperty("schema")) || !required(release, "sha256").matches("[a-f0-9]{64}")) throw new IOException("Invalid agent descriptor");
        long size = Long.parseLong(required(release, "size"));
        if (size < 1 || size > 16 * 1024 * 1024 || Long.parseLong(required(release, "sequence")) < 1) throw new IOException("Invalid agent size or sequence");
        return release;
    }

    public static void apply(Path root, Properties task, Properties release) throws Exception {
        String relative = required(task, "target");
        if (!relative.matches("mods/[^/\\\\:]+\\.jar")) throw new IOException("Update target must be a single mods JAR");
        Path target = safe(root, relative);
        Path staged = safe(root, "udmc-sync/agent-update/new.jar");
        Path backup = safe(root, "udmc-sync/agent-update/previous.jar");
        Path replacement = safe(root, "udmc-sync/agent-update/replacement.jar");
        String nextHash = required(release, "sha256");
        if (Files.isRegularFile(target) && hash(target).equals(nextHash)) return;
        if (!Files.isRegularFile(target) || !hash(target).equals(required(task, "oldHash"))) throw new IOException("Installed agent changed; no files replaced");
        if (!Files.isRegularFile(staged) || Files.size(staged) != Long.parseLong(required(release, "size")) || !hash(staged).equals(nextHash)) throw new IOException("Staged agent hash mismatch");
        // Keep the original until a verified replacement is ready. Never remove the running JAR first.
        Files.copy(target, backup, StandardCopyOption.REPLACE_EXISTING);
        if (!hash(backup).equals(required(task, "oldHash"))) throw new IOException("Agent backup failed verification");
        Files.copy(staged, replacement, StandardCopyOption.REPLACE_EXISTING);
        IOException last = null;
        for (int attempt = 0; attempt < 60; attempt++) {
            try {
                if (!hash(target).equals(required(task, "oldHash"))) throw new IOException("Agent changed before replacement");
                atomicMove(replacement, target);
                if (!hash(target).equals(nextHash)) throw new IOException("Installed update failed verification");
                return;
            } catch (IOException error) {
                last = error;
                if (!Files.exists(replacement) || !Files.exists(target)) {
                    Files.copy(backup, replacement, StandardCopyOption.REPLACE_EXISTING);
                    atomicMove(replacement, target);
                    throw new IOException("Agent update failed; original restored", error);
                }
                Thread.sleep(500);
            }
        }
        throw new IOException("Agent is still locked. Close all game/server processes and retry; backup retained", last);
    }

    private static java.nio.channels.FileLock acquire(FileChannel channel, boolean wait) throws Exception {
        long end = System.nanoTime() + 60_000_000_000L;
        do {
            var lock = channel.tryLock();
            if (lock != null || !wait) return lock;
            Thread.sleep(100);
        } while (System.nanoTime() < end);
        throw new IOException("Agent updater did not finish within 60 seconds; server was not restarted");
    }

    public static Path safe(Path root, String relative) throws IOException {
        if (relative.contains("\\") || relative.startsWith("/") || relative.contains(":")) throw new IOException("Invalid update path");
        Path path = root.toAbsolutePath().normalize();
        for (String part : relative.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) throw new IOException("Invalid update path");
            path = path.resolve(part);
            if (Files.isSymbolicLink(path) || Files.exists(path) && !path.toRealPath().startsWith(root.toRealPath())) throw new IOException("Update path contains a link");
        }
        return path;
    }

    public static String hash(Path file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (var input = Files.newInputStream(file)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    public static Properties read(Path path) throws IOException {
        Properties result = new Properties();
        try (var input = Files.newInputStream(path)) {
            byte[] data = input.readNBytes(32769);
            if (data.length > 32768) throw new IOException("Update state is too large");
            result.load(new ByteArrayInputStream(data));
        }
        return result;
    }

    public static byte[] bytes(Properties properties) throws IOException {
        var output = new ByteArrayOutputStream();
        properties.store(output, "UDMC agent update");
        return output.toByteArray();
    }

    public static void write(Path path, Properties value) throws IOException {
        Path temp = path.resolveSibling(path.getFileName() + ".tmp");
        if (Files.isSymbolicLink(temp) || Files.isSymbolicLink(path)) throw new IOException("Update state contains a link");
        Files.write(temp, bytes(value));
        atomicMove(temp, path);
    }

    private static void atomicMove(Path from, Path to) throws IOException {
        try { Files.move(from, to, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
        catch (java.nio.file.AtomicMoveNotSupportedException error) { Files.move(from, to, StandardCopyOption.REPLACE_EXISTING); }
    }

    public static String required(Properties value, String key) throws IOException {
        String result = value.getProperty(key);
        if (result == null || result.isBlank()) throw new IOException("Missing agent update field: " + key);
        return result;
    }

    private static void writeResult(Path path, String state, String message) throws IOException {
        Properties result = new Properties();
        result.setProperty("state", state); result.setProperty("message", message); result.setProperty("updatedAt", Instant.now().toString());
        write(path, result);
    }
}
