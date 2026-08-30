package dev.udmc.sync;

import java.io.IOException;
import net.minecraft.network.Connection;
import java.util.List;
import java.util.Map;
import java.util.Collections;
import java.util.WeakHashMap;

public final class AgentLoginProtocol {
    public static final int TRANSACTION_ID = 0x55444d43;
    public static final int PROTOCOL = 1;
    private static volatile Server server;
    private static volatile Answer client;
    private static final Map<Connection, Decision> WARN = Collections.synchronizedMap(new WeakHashMap<>());

    private AgentLoginProtocol() {}

    static void configureServer(UdmcConfig config, AgentDistribution distribution) {
        server = new Server(config, distribution);
    }

    public static boolean enabled() { return server != null; }

    static void configureClient(UdmcConfig config) {
        String hash = "";
        try { hash = Hashes.sha256(LoaderPlatform.agentPath()); }
        catch (Exception error) { UdmcSync.LOGGER.warn("Cannot identify the client agent for login verification", error); }
        client = new Answer(PROTOCOL, config.packId, PlatformDefaults.get("agentVersion"), hash);
    }

    public static Query query() {
        Server current = server;
        if (current == null) return new Query(PROTOCOL, "", "", "", false);
        try {
            AgentRelease release = current.distribution.release();
            String hash = release == null ? "unavailable" : release.verify(current.config, "client").getProperty("sha256", "unavailable");
            return new Query(PROTOCOL, current.config.packId, hash, current.distribution.instructionsUrl(), current.config.requireClientAgent);
        } catch (IOException error) {
            UdmcSync.LOGGER.error("Cannot read UDMC login policy", error);
            return new Query(PROTOCOL, current.config.packId, "unavailable", current.distribution.instructionsUrl(), current.config.requireClientAgent);
        }
    }

    public static Answer answer(Query query) {
        Answer current = client;
        if (current == null || query.protocol != PROTOCOL) return null;
        // A client of another project still answers. Staying silent made the server report
        // the mod as missing - the one thing it cannot know - and left the player with
        // advice that did not apply. The project id is withheld: the server only needs to
        // learn that this client belongs somewhere else, not where.
        if (!current.packId.equals(query.packId)) return new Answer(PROTOCOL, "", current.version, "");
        return current;
    }

    public static Decision validate(Answer answer) {
        Query expected = query();
        String offered = offeredClientVersion();
        if (answer == null) return invalid(expected, offered, "", "udmc_sync.login.missing");
        if (answer.protocol != PROTOCOL) return invalid(expected, offered, answer.version, "udmc_sync.login.incompatible");
        // An empty project id means the client answered from another project on purpose.
        if (!expected.packId.equals(answer.packId)) return invalid(expected, offered, answer.version, "udmc_sync.login.foreign", expected.packId);
        if (!expected.clientHash.isBlank() && !expected.clientHash.equals(answer.jarHash)) {
            return invalid(expected, offered, answer.version, "udmc_sync.login.outdated", offered, answer.version);
        }
        return new Decision(true, false, "", "", List.of(), expected.downloadUrl, agentVersion(), offered, expected.packId, answer.version);
    }

    /** The version of the client JAR this server hands out, or "" when none is published. */
    private static String offeredClientVersion() {
        Server current = server;
        if (current == null) return "";
        try {
            AgentRelease release = current.distribution.release();
            return release == null ? "" : release.verify(current.config, "client").getProperty("version", "");
        } catch (IOException error) { return ""; }
    }

    private static String agentVersion() { return PlatformDefaults.get("agentVersion"); }

    private static Decision invalid(Query expected, String offered, String reported, String messageKey, String... args) {
        return new Decision(false, expected.required, messageKey, Messages.of(messageKey).fallback(), List.of(args),
            expected.downloadUrl, agentVersion(), offered, expected.packId, reported);
    }

    public static void warn(Connection connection, Decision decision) { WARN.put(connection, decision); }
    public static Decision takeWarning(Connection connection) { return WARN.remove(connection); }

    public record Query(int protocol, String packId, String clientHash, String downloadUrl, boolean required) {}
    public record Answer(int protocol, String packId, String version, String jarHash) {}
    /**
     * Why a player was let in or turned away, with the numbers an administrator needs to
     * compare: what this server runs, what it hands out, and what the client reported.
     */
    public record Decision(boolean valid, boolean reject, String messageKey, String messageFallback, List<String> args,
                           String downloadUrl, String serverAgent, String offeredClient, String packId, String reportedClient) {}
    private record Server(UdmcConfig config, AgentDistribution distribution) {}
}
