package dev.udmc.sync;

import java.io.IOException;
import net.minecraft.network.Connection;
import java.util.List;
import java.util.Map;
import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.ConcurrentHashMap;

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
    /**
     * The mark on the ping that closes the question. The game answers a ping in every phase and
     * every version, and TCP keeps order: when this comes back, a client that had something to
     * say has already said it, and a client that stayed silent has no UDMC to say it with. So
     * the wait is one round trip rather than a timeout every player without the mod pays for.
     */
    public static final int PING = 0x55444D43;
    private static volatile Server server;
    private static volatile Answer client;
    private static volatile ClientProject.Offer OFFER;
    private static final Map<Connection, Decision> WARN = Collections.synchronizedMap(new WeakHashMap<>());
    // Present means the player's client answered; absent means it never did. The two must not
    // read the same: silence is what tells the server the mod is not there at all.
    private static final Map<Connection, Answer> ANSWERS = Collections.synchronizedMap(new WeakHashMap<>());
    private static final Map<Connection, Boolean> PENDING = Collections.synchronizedMap(new WeakHashMap<>());
    // The verdict of a connection that has been asked and is being waited on. Present means
    // the configuration phase is held open for it and nothing else has been sent yet.
    private static final Map<Connection, Runnable> AWAITING = Collections.synchronizedMap(new WeakHashMap<>());
    /**
     * The channel Fabric API's registry synchronisation arrives on, in the two spellings the
     * supported game versions use: {@code registry/sync/direct} up to 1.21.x, {@code
     * registry/sync} from 26.x. Both are claimed; the one a server does not use costs nothing.
     * Read out of the library's own payload classes - this is the one fact of another mod's
     * this mod carries by name, and it is checked on the stand, not derived.
     */
    static final List<String> REGISTRY_SYNC_CHANNELS = List.of("fabric:registry/sync/direct", "fabric:registry/sync");
    // Whether this client has told a server it can receive those without being able to - which
    // standIn() does only for a client that belongs to no project yet.
    private static final Set<String> CLAIMED = ConcurrentHashMap.newKeySet();

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
        CLAIMED.clear();
    }

    /**
     * The channels this client will tell a server it can receive, when the server announces its
     * own - or none.
     *
     * <p>This is for the client that carries nothing but this mod, which is what the
     * installation guide asks of a new player. A server whose mods add registry entries checks,
     * before any configuration task runs, whether the client registered the channel its
     * registry sync goes over; a client with no networking library registers nothing, and is
     * refused with "this server requires Fabric API" - by the library, before UDMC has spoken,
     * and so before the player could accept the project that would have installed that very
     * library. Claiming the channel puts the server's sync task in the queue behind ours, so
     * the first thing the player meets is our question.
     *
     * <p>Only for a client that belongs to no project yet. One that has accepted a project has
     * the project's files, and if those do not include what the server's mods need, the
     * library's refusal is the truthful one and stays.
     */
    public static List<String> standIn() {
        Answer current = client;
        if (current == null || !current.packId.isBlank()) return List.of();
        CLAIMED.addAll(REGISTRY_SYNC_CHANNELS);
        UdmcSync.LOGGER.info("UDMC told the server this client can receive {}: it belongs to no project yet and has no library of its own to answer with",
            String.join(", ", REGISTRY_SYNC_CHANNELS));
        return REGISTRY_SYNC_CHANNELS;
    }

    /** Whether a channel is one this client only claimed - so a payload on it cannot be handled. */
    public static boolean claimed(String channel) { return CLAIMED.contains(channel); }

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
        // Not older than what this server hands out - the version, not the bytes.
        //
        // Byte-identity is a leftover from the days when every project had its own jar. One
        // file serves everyone now, so the same version from the server and from a mod site is
        // the same file, and demanding an exact match locked out anyone whose launcher had
        // updated the mod ahead of the server. It never was a security boundary either: the
        // client is the player's machine and can report whatever hash it likes.
        //
        // Ahead is fine: the question this check rides on is frozen, so a newer client and an
        // older server understand each other. Only behind is a problem, and only then is there
        // something for the player to do.
        if (!offered.isBlank() && behind(answer.version, offered)) {
            return invalid(expected, offered, answer.version, answer.packId, "udmc_sync.login.outdated", offered, answer.version);
        }
        return new Decision(true, false, "", "", List.of(), expected.downloadUrl, agentVersion(), offered, expected.packId, answer.version, answer.packId);
    }

    /** Whether the reported version is older than the one this server hands out. */
    private static boolean behind(String reported, String offered) {
        try { return AgentPackages.compareVersions(reported, offered) < 0; }
        // A version this build cannot read is not evidence of anything: let them in rather
        // than turn a player away over a number nobody can compare.
        catch (IOException | RuntimeException error) { return false; }
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

    /** Holds a verdict until the client has had its round trip to answer. */
    public static void await(Connection connection, Runnable verdict) { AWAITING.put(connection, verdict); }
    public static boolean awaiting(Connection connection) { return AWAITING.containsKey(connection); }

    /**
     * Reaches the verdict once. The pong and the patience deadline race each other by design;
     * removing before running is what makes the loser of that race do nothing.
     */
    public static void settle(Connection connection) {
        Runnable verdict = AWAITING.remove(connection);
        if (verdict != null) verdict.run();
    }

    public static void receive(Connection connection, Answer answer) { ANSWERS.put(connection, answer); }
    public static boolean answered(Connection connection) { return ANSWERS.containsKey(connection); }
    // Marked when the question goes out and cleared by the verdict: it tells the join hook
    // whether this connection still owes an answer, without it having to know the phase.
    public static void asked(Connection connection) { PENDING.put(connection, Boolean.TRUE); }
    public static boolean pending(Connection connection) { return PENDING.remove(connection) != null; }
    public static Answer takeAnswer(Connection connection) { return ANSWERS.remove(connection); }
    public static void forget(Connection connection) {
        ANSWERS.remove(connection); WARN.remove(connection); PENDING.remove(connection); AWAITING.remove(connection);
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
                           String downloadUrl, String serverAgent, String offeredClient, String packId,
                           String reportedClient, String reportedProject) {}
    private record Server(UdmcConfig config, AgentDistribution distribution) {}
}
