package dev.udmc.sync;

import java.io.IOException;
import net.minecraft.network.Connection;
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
        if (current == null || query.protocol != PROTOCOL || !current.packId.equals(query.packId)) return null;
        return current;
    }

    public static Decision validate(Answer answer) {
        Query expected = query();
        if (answer == null) return invalid(expected, "udmc_sync.login.missing");
        if (answer.protocol != PROTOCOL || !expected.packId.equals(answer.packId)) {
            return invalid(expected, "udmc_sync.login.incompatible");
        }
        if (!expected.clientHash.isBlank() && !expected.clientHash.equals(answer.jarHash)) {
            return invalid(expected, "udmc_sync.login.outdated");
        }
        return new Decision(true, false, "", "", expected.downloadUrl);
    }

    private static Decision invalid(Query expected, String messageKey) {
        return new Decision(false, expected.required, messageKey, Messages.of(messageKey).fallback(), expected.downloadUrl);
    }

    public static void warn(Connection connection, Decision decision) { WARN.put(connection, decision); }
    public static Decision takeWarning(Connection connection) { return WARN.remove(connection); }

    public record Query(int protocol, String packId, String clientHash, String downloadUrl, boolean required) {}
    public record Answer(int protocol, String packId, String version, String jarHash) {}
    public record Decision(boolean valid, boolean reject, String messageKey, String messageFallback, String downloadUrl) {}
    private record Server(UdmcConfig config, AgentDistribution distribution) {}
}
