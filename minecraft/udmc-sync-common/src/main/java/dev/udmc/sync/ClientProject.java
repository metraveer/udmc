package dev.udmc.sync;

import java.net.URI;
import java.nio.file.Path;
import java.util.Base64;

/**
 * What a client does with the project a server offers it. With one mod for everybody, a client
 * arrives knowing nothing and learns from the server it joins - which means the rules for when
 * to believe a server have to be written down, not assumed.
 *
 * <p>One game directory holds one project: two servers' modpacks cannot share a {@code mods}
 * folder, so the second one is refused with an explanation rather than half-applied.
 */
public final class ClientProject {
    /** Base64 of an X.509 Ed25519 key is 44 characters; the cap only keeps a stray value out. */
    private static final int MAX_KEY = 256;

    private ClientProject() {
    }

    /** What a server says about itself when a player joins. Nothing here is trusted yet. */
    public record Offer(String packId, String packName, String apiUrl, String publicKey) {
        public Offer {
            packId = packId == null ? "" : packId.trim();
            packName = packName == null ? "" : packName.trim();
            apiUrl = apiUrl == null ? "" : apiUrl.trim();
            publicKey = publicKey == null ? "" : publicKey.trim();
        }

        /** True when the address has no transport encryption, which the player has to accept. */
        public boolean insecure() {
            try { return "http".equals(URI.create(apiUrl).getScheme()); } catch (Exception error) { return true; }
        }

        /** The short form a player can compare against what the server owner published. */
        public String fingerprint() {
            return ServerIdentity.fingerprint(publicKey);
        }
    }

    public enum Verdict {
        /** The offer is malformed or the address is unusable; nothing to act on. */
        UNUSABLE,
        /** This client has no project. Setting one up needs the player to agree. */
        NEW_PROJECT,
        /** Same project, same key. Business as usual. */
        KNOWN,
        /**
         * Same project name, different signing key. Either the owner lost the project and made a
         * new one, or this is not the server the player thinks it is. Never resolved silently.
         */
        KEY_CHANGED,
        /** A different project. One game directory cannot serve two modpacks. */
        OTHER_PROJECT
    }

    /**
     * Judges an offer and applies the part that is safe to apply on its own: a server that moved
     * to another address or renamed its pack is still the same project, proven by the same key.
     * Everything that changes which project this client belongs to waits for the player.
     */
    public static Verdict reconcile(Path gameDir, UdmcConfig config, Offer offer) {
        if (!usable(offer)) return Verdict.UNUSABLE;
        if (config.manifestPublicKey == null || config.manifestPublicKey.isBlank()) return Verdict.NEW_PROJECT;
        if (!config.packId.equals(offer.packId())) return Verdict.OTHER_PROJECT;
        if (!config.manifestPublicKey.equals(offer.publicKey())) return Verdict.KEY_CHANGED;

        // The key matches, so this is the same project however it has been moved or renamed.
        // Following the address here is what lets an owner change the port without reissuing
        // anything: the client simply hears the new one the next time it connects.
        boolean moved = !sameAddress(config.serverUrl, offer.apiUrl());
        boolean renamed = !offer.packName().isEmpty() && !offer.packName().equals(config.packName);
        if (moved || renamed) {
            if (moved) UdmcSync.LOGGER.info("UDMC server address changed to {}", offer.apiUrl());
            config.serverUrl = offer.apiUrl();
            if (renamed) config.packName = offer.packName();
            config.save(gameDir);
        }
        return Verdict.KNOWN;
    }

    /**
     * Writes the project down after the player has agreed to it. The address decides whether
     * unencrypted transport is allowed: the server does not get to grant itself that.
     */
    public static void accept(Path gameDir, UdmcConfig config, Offer offer) {
        if (!usable(offer)) throw new IllegalArgumentException("Refusing an unusable project offer");
        config.packId = offer.packId();
        config.packName = offer.packName().isEmpty() ? offer.packId() : offer.packName();
        config.serverUrl = offer.apiUrl();
        config.manifestPublicKey = offer.publicKey();
        config.requireSignedManifest = true;
        config.allowInsecureHttp = offer.insecure();
        // A client holds no secrets of its own: it checks signatures, it does not make them.
        config.manifestPrivateKey = "";
        config.adminToken = "";
        config.save(gameDir);
        // From this moment the client belongs to a project, and the answer it gives a server
        // has to say so at once. Left until the next launch, the player accepted, rejoined and
        // was turned away as unclaimed all over again - with nothing telling them to restart.
        AgentLoginProtocol.configureClient(config);
        UdmcSync.LOGGER.info("UDMC set up for project {} at {} (key {})", config.packId, config.serverUrl, offer.fingerprint());
    }

    /** True once this client belongs to a project and can sync on its own at startup. */
    public static boolean configured(UdmcConfig config) {
        return config.manifestPublicKey != null && !config.manifestPublicKey.isBlank()
            && config.serverUrl != null && !config.serverUrl.isBlank();
    }

    private static boolean usable(Offer offer) {
        if (offer.packId().isEmpty() || offer.packId().length() > 64 || !offer.packId().matches("[A-Za-z0-9_-]+")) return false;
        if (offer.publicKey().isEmpty() || offer.publicKey().length() > MAX_KEY) return false;
        try {
            if (Base64.getDecoder().decode(offer.publicKey()).length < 32) return false;
        } catch (IllegalArgumentException error) {
            return false;
        }
        try {
            URI uri = URI.create(offer.apiUrl());
            String scheme = uri.getScheme();
            return ("https".equals(scheme) || "http".equals(scheme))
                && uri.getHost() != null && uri.getUserInfo() == null
                && uri.getQuery() == null && uri.getFragment() == null;
        } catch (Exception error) {
            return false;
        }
    }

    private static boolean sameAddress(String current, String offered) {
        return current != null && current.replaceAll("/+$", "").equals(offered.replaceAll("/+$", ""));
    }
}
