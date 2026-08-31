package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;

public final class UdmcConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    public String serverUrl = "http://127.0.0.1:3077";
    public String apiHost = "0.0.0.0";
    public int apiPort = 3077;
    public String adminToken = ServerIdentity.UNSET_TOKEN;
    public boolean clientSyncOnStart = true;
    public String packId = "udmc-main";
    public String packName = "UDMC Main Modpack";
    public String packVersion = "0.1.0";
    public String minecraftVersion = PlatformDefaults.get("minecraft");
    public String loaderType = LoaderPlatform.TYPE;
    public String loaderVersion = PlatformDefaults.get("loaderVersion");
    public String languageLoaderVersion = PlatformDefaults.get("languageLoaderVersion");
    /** Public game address (host[:port]) that players should join; empty when the admin has not set one. */
    public volatile String gameAddress = "";
    public String manifestPublicKey = "";
    public String manifestPrivateKey = "";
    public boolean requireSignedManifest = false;
    public boolean allowInsecureHttp = false;
    public volatile boolean requireClientAgent = false;
    /**
     * Code that lets a panel claim this server, empty once one has. It does not expire and is not
     * regenerated on restart: there is no window to miss, only a code to find.
     */
    public volatile String pairingCode = "";
    /** Set by hand to issue a new code and cut off panels that already paired. Clears itself. */
    public boolean resetPairing = false;
    /**
     * Which verification the agent speaks. 1 asked during login and is gone; 2 asks during the
     * configuration phase. A server that moves to 2 cannot be answered by clients still on 1,
     * so it stops turning anyone away until the administrator has handed out the new client.
     */
    public int verifyProtocol = 0;
    /** Validates an optional player-facing game address; returns the trimmed value or "" to clear it. */
    public static String normalizeGameAddress(String value) {
        String address = value == null ? "" : value.trim();
        if (address.isEmpty()) return "";
        if (address.length() > 260
            || address.chars().anyMatch(c -> c <= ' ' || c == 127 || "/\\@#?\"'".indexOf(c) >= 0)) {
            throw new IllegalArgumentException("Invalid game address");
        }
        String host = address;
        String port = null;
        if (address.startsWith("[")) {
            int end = address.indexOf(']');
            if (end < 2) throw new IllegalArgumentException("Invalid game address");
            host = address.substring(1, end);
            String rest = address.substring(end + 1);
            if (!rest.isEmpty()) {
                if (!rest.startsWith(":")) throw new IllegalArgumentException("Invalid game address");
                port = rest.substring(1);
            }
            if (!host.matches("[0-9A-Fa-f:]+")) throw new IllegalArgumentException("Invalid game address");
        } else {
            int sep = address.lastIndexOf(':');
            if (address.indexOf(':') != sep) throw new IllegalArgumentException("Invalid game address");
            if (sep >= 0) {
                host = address.substring(0, sep);
                port = address.substring(sep + 1);
            }
            if (host.isEmpty() || !host.matches("[A-Za-z0-9.-]+")) {
                throw new IllegalArgumentException("Invalid game address");
            }
        }
        if (port != null && (!port.matches("\\d{1,5}") || Integer.parseInt(port) < 1 || Integer.parseInt(port) > 65535)) {
            throw new IllegalArgumentException("Invalid game address");
        }
        return address;
    }

    public void applyRuntimeEnvironment() {
        minecraftVersion = LoaderPlatform.version("minecraft", minecraftVersion);
        loaderType = LoaderPlatform.TYPE;
        loaderVersion = LoaderPlatform.version(LoaderPlatform.MOD_ID, loaderVersion);
        languageLoaderVersion = LoaderPlatform.version("@fml", languageLoaderVersion);
    }

    public static UdmcConfig load(Path gameDir) {
        Path configPath = configPath(gameDir);
        try {
            if (!Files.exists(configPath)) {
                UdmcConfig config = new UdmcConfig();
                config.save(gameDir);
                return config;
            }
            try (Reader reader = Files.newBufferedReader(configPath)) {
                UdmcConfig stored = GSON.fromJson(reader, UdmcConfig.class);
                return stored == null ? new UdmcConfig() : stored;
            }
        } catch (IOException error) {
            throw new IllegalStateException("Cannot load UDMC config: " + configPath, error);
        }
    }

    public void save(Path gameDir) {
        Path configPath = configPath(gameDir);

        try {
            Files.createDirectories(configPath.getParent());
            if (Files.isSymbolicLink(configPath) || Files.isSymbolicLink(configPath.getParent())) throw new IOException("UDMC configuration must not be a symbolic link");
            Path temporary = Files.createTempFile(configPath.getParent(), "udmc-config-", ".tmp");
            try {
            try (Writer writer = Files.newBufferedWriter(temporary)) {
                GSON.toJson(this, writer);
            }
            try { Files.move(temporary, configPath, java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING); }
            catch (java.nio.file.AtomicMoveNotSupportedException error) { Files.move(temporary, configPath, java.nio.file.StandardCopyOption.REPLACE_EXISTING); }
            } finally { Files.deleteIfExists(temporary); }
        } catch (IOException error) {
            throw new IllegalStateException("Cannot save UDMC config: " + configPath, error);
        }
    }

    private static Path configPath(Path gameDir) {
        return gameDir.resolve("config").resolve("udmc-sync.json");
    }

}
