package dev.udmc.sync;

import java.io.IOException;
import net.minecraft.network.Connection;
import java.util.List;
import java.util.Map;
import java.util.Collections;
import java.util.WeakHashMap;

public final class AgentLoginProtocol {
    /**
     * What a client reports about itself. 1 answered during login; 2 answered in the configuration
     * phase carrying a project baked into its JAR; 3 has no project of its own and takes one from
     * the server. A server on 3 turns a 2 away with an explanation rather than in silence.
     */
    public static final int PROTOCOL = 3;
    /**
     * The number written into the question, deliberately frozen at 2. Clients from 0.19.0 decode
     * the question by position, so changing its shape would break them mid-handshake and cost
     * them the screen that tells them what to install. What is new travels beside it instead.
     */
    public static final int QUERY_PROTOCOL = 2;
    /** Ticks the server waits for an answer before deciding without one: about ten seconds. */
    public static final int DEADLINE_TICKS = 200;
    private static volatile Server server;
    private static volatile Answer client;
    private static volatile ClientProject.Offer OFFER;
    private static final Map<Connection, Decision> WARN = Collections.synchronizedMap(new WeakHashMap<>());
    // Present means the player's client answered; absent means it never did. The two must not
    // read the same: silence is what tells the server the mod is not there at all.
    private static final Map<Connection, Answer> ANSWERS = Collections.synchronizedMap(new WeakHashMap<>());
    private static final Map<Connection, Boolean> PENDING = Collections.synchronizedMap(new WeakHashMap<>());

    private AgentLoginProtocol() {}

    static void configureServer(UdmcConfig config, AgentDistribution distribution) {
        server = new Server(config, distribution);
    }

    /** Disarms the check when the HTTP API failed to start: its download URL leads nowhere. */
    public static void clearServer() { server = null; }

    public static boolean enabled() { return server != null; }

    static void configureClient(UdmcConfig config) {
        String hash = "";
        try { hash = Hashes.sha256(LoaderPlatform.agentPath()); }
        catch (Exception error) { UdmcSync.LOGGER.warn("Cannot identify the client agent for login verification", error); }
        // A client that belongs to no project yet says so with an empty name. Reporting the
            // default project id instead would let it pass for a member of a server that happens
            // to use the default too - installed, but with none of the pack downloaded.
            String project = ClientProject.configured(config) ? config.packId : "";
            client = new Answer(PROTOCOL, project, PlatformDefaults.get("agentVersion"), hash);
    }

    public static Query query() {
        Server current = server;
        if (current == null) return new Query(QUERY_PROTOCOL, "", "", "", false);
        try {
            AgentRelease release = current.distribution.release();
            // No published client means there is nothing to compare a player's file against.
            // An empty hash says exactly that; "unavailable" was a value like any other and
            // made every correct client look outdated against a version nobody could name.
            String hash = release == null ? "" : release.verify(current.config, "client").getProperty("sha256", "");
            return new Query(QUERY_PROTOCOL, current.config.packId, hash, current.distribution.instructionsUrl(), current.config.requireClientAgent);
        } catch (IOException error) {
            UdmcSync.LOGGER.error("Cannot read UDMC login policy", error);
            return new Query(QUERY_PROTOCOL, current.config.packId, "", current.distribution.instructionsUrl(), current.config.requireClientAgent);
        }
    }

    /** What this server is, for a client that arrived knowing nothing. */
    public static ClientProject.Offer project() {
        Server current = server;
        if (current == null) return null;
        return new ClientProject.Offer(current.config.packId, current.config.packName,
            current.config.serverUrl, current.config.manifestPublicKey);
    }

    /**
     * Kept until the client is out of the network thread and can act on it - which is the title
     * screen, not the moment a server disconnects them.
     *
     * <p>Logged on arrival rather than on use: when a player reports that nothing was offered,
     * this line is what separates "the server never said" from "the client did not act on it".
     */
    public static void offered(ClientProject.Offer offer) {
        OFFER = offer;
        if (offer != null) UdmcSync.LOGGER.info("UDMC was offered project {} at {}", offer.packId(), offer.apiUrl());
    }

    public static ClientProject.Offer takeOffer() {
        ClientProject.Offer offer = OFFER;
        OFFER = null;
        return offer;
    }

    public static Answer answer(Query query) {
        Answer current = client;
        if (current == null || query.protocol != QUERY_PROTOCOL) return null;
        // A client of another project still answers, and names that project: staying silent
        // made the server report the mod as missing - the one thing it cannot know - and an
        // administrator holding a screenshot could not tell the two cases apart. The JAR
        // fingerprint is left out; it says nothing to a server that did not hand it out.
        if (!current.packId.equals(query.packId)) return new Answer(PROTOCOL, current.packId, current.version, "");
        return current;
    }

    /** Says out loud what was decided about a joining player, and why. */
    public static Decision announce(String who, Decision decision) {
        UdmcSync.LOGGER.info("UDMC login verdict for {}: {}", who,
            decision.valid() ? "ok" : decision.messageKey() + (decision.reject() ? " (refused)" : " (warned)"));
        return decision;
    }

    public static Decision validate(Answer answer) {
        Query expected = query();
        String offered = offeredClientVersion();
        if (answer == null) return invalid(expected, offered, "", "", "udmc_sync.login.missing");
        if (answer.protocol != PROTOCOL) return invalid(expected, offered, answer.version, answer.packId, "udmc_sync.login.incompatible");
        if (answer.packId.isBlank()) {
            // Installed, current, and not yet set up for anything: the player has to accept the
            // project once. Saying "set up for another project" here would send them looking for
            // a mistake they have not made.
            return invalid(expected, offered, answer.version, answer.packId, "udmc_sync.login.unclaimed", expected.packId);
        }
        if (!expected.packId.equals(answer.packId)) {
            return invalid(expected, offered, answer.version, answer.packId, "udmc_sync.login.foreign", expected.packId);
        }
        if (!expected.clientHash.isBlank() && !expected.clientHash.equals(answer.jarHash)) {
            // Regenerating the client JAR - a changed address, project name or network - keeps
            // the agent version. Calling that "outdated: 0.17.1 against 0.17.1" explains nothing.
            return offered.equals(answer.version)
                ? invalid(expected, offered, answer.version, answer.packId, "udmc_sync.login.rebuilt", offered)
                : invalid(expected, offered, answer.version, answer.packId, "udmc_sync.login.outdated", offered, answer.version);
        }
        return new Decision(true, false, "", "", List.of(), expected.downloadUrl, agentVersion(), offered, expected.packId, answer.version, answer.packId);
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

    private static Decision invalid(Query expected, String offered, String reported, String reportedProject, String messageKey, String... args) {
        return new Decision(false, expected.required, messageKey, Messages.of(messageKey).fallback(), List.of(args),
            expected.downloadUrl, agentVersion(), offered, expected.packId, reported, reportedProject);
    }

    public static void receive(Connection connection, Answer answer) { ANSWERS.put(connection, answer); }
    public static boolean answered(Connection connection) { return ANSWERS.containsKey(connection); }
    // Marked when the question goes out and cleared by the verdict: it tells the join hook
    // whether this connection still owes an answer, without it having to know the phase.
    public static void asked(Connection connection) { PENDING.put(connection, Boolean.TRUE); }
    public static boolean pending(Connection connection) { return PENDING.remove(connection) != null; }
    public static Answer takeAnswer(Connection connection) { return ANSWERS.remove(connection); }
    public static void forget(Connection connection) { ANSWERS.remove(connection); WARN.remove(connection); PENDING.remove(connection); }

    public static void warn(Connection connection, Decision decision) { WARN.put(connection, decision); }
    public static Decision takeWarning(Connection connection) { return WARN.remove(connection); }

    public record Query(int protocol, String packId, String clientHash, String downloadUrl, boolean required) {}
    public record Answer(int protocol, String packId, String version, String jarHash) {}
    /**
     * Why a player was let in or turned away, with the numbers an administrator needs to
     * compare: what this server runs, what it hands out, and what the client reported.
     */
    public record Decision(boolean valid, boolean reject, String messageKey, String messageFallback, List<String> args,
                           String downloadUrl, String serverAgent, String offeredClient, String packId,
                           String reportedClient, String reportedProject) {}
    private record Server(UdmcConfig config, AgentDistribution distribution) {}
}
