package dev.udmc.sync;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.util.Base64;

/** What a client believes when a server tells it which project it belongs to. */
public final class ClientProjectTest {
    public static void main(String[] args) throws Exception {
        aClientWithNoProjectIsOfferedOne();
        acceptingKeepsNoSecretsAndSignsEverything();
        theSameProjectIsRecognised();
        theAddressFollowsTheServer();
        aChangedKeyIsNeverAcceptedQuietly();
        aSecondProjectIsRefused();
        nonsenseOffersAreRefused();
        theQuestionFollowsThePlayerToTheServerList();
        acceptingIsAnsweredForImmediately();
        unencryptedTransportIsThePlayersChoice();
        System.out.println("ClientProjectTest OK");
    }

    private static void aClientWithNoProjectIsOfferedOne() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        expect(!ClientProject.configured(config), "A fresh client belongs to no project");
        expect(ClientProject.reconcile(gameDir, config, offer("udmc-main", key())) == ClientProject.Verdict.NEW_PROJECT,
            "An unclaimed client must be offered the project");
        // Judging is not adopting: nothing may be written before the player has agreed.
        expect(config.manifestPublicKey.isBlank(), "Judging an offer must not adopt it");
        expect(UdmcConfig.load(gameDir).manifestPublicKey.isBlank(), "Judging an offer must not touch the file");
    }

    /**
     * What the client answers a server after the player has just accepted. The answer used to be
     * decided once, at launch: accepting wrote the file and changed nothing else, so the very
     * next join was refused as unclaimed again and the only cure was restarting the game -
     * which no screen mentioned. Reported by a player on a first run.
     */
    private static void acceptingIsAnsweredForImmediately() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        AgentLoginProtocol.configureClient(config);
        var query = new AgentLoginProtocol.Query(AgentLoginProtocol.QUERY_PROTOCOL, "udmc-main", "", "", true);
        var before = AgentLoginProtocol.answer(query);
        expect(before != null && before.packId().isEmpty(), "A fresh client answers, naming no project");

        ClientProject.accept(gameDir, config, offer("udmc-main", key()));
        var after = AgentLoginProtocol.answer(query);
        expect(after != null && after.packId().equals("udmc-main"),
            "Accepting must be answered for at once, without waiting for the game to restart");
    }

    /**
     * Where a waiting screen may appear. The second column is a screen the player is waiting
     * on - the one they were turned away on, or the server list after it - and the question is
     * the only thing allowed to take it over. While the question waited for the title screen a
     * refused player rejoined and was refused for ever, told to leave the server once - which
     * is exactly what they had just done.
     */
    private static void theQuestionFollowsThePlayerToTheServerList() {
        expect(UdmcClientUi.presentable(true, false, true), "The title screen takes the question");
        expect(UdmcClientUi.presentable(true, false, false), "The title screen takes anything else too");
        expect(UdmcClientUi.presentable(false, true, true), "The refusal screen and the server list must take the question");
        expect(!UdmcClientUi.presentable(false, true, false),
            "Nothing but the question may take a waiting screen away from the player");
        expect(!UdmcClientUi.presentable(false, false, true), "In a world, nothing interrupts");
        expect(!UdmcClientUi.presentable(false, false, false), "In a world, nothing interrupts");
    }

    private static void acceptingKeepsNoSecretsAndSignsEverything() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        config.adminToken = "left-over-token";
        config.manifestPrivateKey = "left-over-key";
        String publicKey = key();

        ClientProject.accept(gameDir, config, offer("udmc-main", publicKey));

        UdmcConfig stored = UdmcConfig.load(gameDir);
        expect(stored.packId.equals("udmc-main"), "The project id must be stored");
        expect(stored.manifestPublicKey.equals(publicKey), "The verification key must be stored");
        expect(stored.serverUrl.equals("https://mc.example.com:3077/"), "The file address must be stored");
        expect(stored.requireSignedManifest, "A learned project always checks signatures");
        // A client verifies signatures; it never makes them, and holds nothing worth stealing.
        expect(stored.manifestPrivateKey.isBlank(), "A client must not keep a signing key");
        expect(stored.adminToken.isBlank(), "A client must not keep an admin token");
        expect(ClientProject.configured(stored), "An accepted project is set up");
    }

    private static void theSameProjectIsRecognised() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        String publicKey = key();
        ClientProject.accept(gameDir, config, offer("udmc-main", publicKey));

        expect(ClientProject.reconcile(gameDir, config, offer("udmc-main", publicKey)) == ClientProject.Verdict.KNOWN,
            "The same project with the same key is simply known");
    }

    private static void theAddressFollowsTheServer() throws Exception {
        // The whole point of the client learning from the server: the owner can move the agent
        // to another port without reissuing anything, and clients hear about it on next join.
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        String publicKey = key();
        ClientProject.accept(gameDir, config, offer("udmc-main", publicKey));

        ClientProject.Offer moved = new ClientProject.Offer("udmc-main", "Renamed pack", "https://mc.example.com:9999/", publicKey);
        expect(ClientProject.reconcile(gameDir, config, moved) == ClientProject.Verdict.KNOWN, "A moved server is still the same project");
        expect(config.serverUrl.equals("https://mc.example.com:9999/"), "The new address must be adopted");
        expect(config.packName.equals("Renamed pack"), "A renamed pack must be adopted");
        expect(UdmcConfig.load(gameDir).serverUrl.equals("https://mc.example.com:9999/"), "The new address must be saved");
    }

    private static void aChangedKeyIsNeverAcceptedQuietly() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        String publicKey = key();
        ClientProject.accept(gameDir, config, offer("udmc-main", publicKey));

        ClientProject.Offer impostor = offer("udmc-main", key());
        expect(ClientProject.reconcile(gameDir, config, impostor) == ClientProject.Verdict.KEY_CHANGED,
            "A different key under the same name must be reported, not applied");
        expect(config.manifestPublicKey.equals(publicKey), "A changed key must not overwrite the trusted one");
    }

    private static void aSecondProjectIsRefused() throws Exception {
        // Two modpacks cannot share one mods folder, so the second server is turned down
        // rather than half-served. The player needs a separate game profile for it.
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        ClientProject.accept(gameDir, config, offer("udmc-main", key()));

        expect(ClientProject.reconcile(gameDir, config, offer("other-pack", key())) == ClientProject.Verdict.OTHER_PROJECT,
            "A second project must be refused");
        expect(config.packId.equals("udmc-main"), "The first project must survive the offer");
    }

    private static void nonsenseOffersAreRefused() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        String publicKey = key();
        for (ClientProject.Offer bad : new ClientProject.Offer[] {
            new ClientProject.Offer("", "Pack", "https://mc.example.com/", publicKey),
            new ClientProject.Offer("has spaces", "Pack", "https://mc.example.com/", publicKey),
            new ClientProject.Offer("udmc-main", "Pack", "https://mc.example.com/", ""),
            new ClientProject.Offer("udmc-main", "Pack", "https://mc.example.com/", "not base64 at all!"),
            new ClientProject.Offer("udmc-main", "Pack", "ftp://mc.example.com/", publicKey),
            new ClientProject.Offer("udmc-main", "Pack", "file:///C:/windows", publicKey),
            new ClientProject.Offer("udmc-main", "Pack", "https://user:pass@mc.example.com/", publicKey),
            new ClientProject.Offer("udmc-main", "Pack", "https://mc.example.com/?x=1", publicKey),
            new ClientProject.Offer("udmc-main", "Pack", "", publicKey),
        }) {
            expect(ClientProject.reconcile(gameDir, config, bad) == ClientProject.Verdict.UNUSABLE,
                "Refused offer expected: " + bad);
            fails(() -> ClientProject.accept(gameDir, config, bad));
        }
        expect(!ClientProject.configured(config), "No bad offer may set a client up");
    }

    private static void unencryptedTransportIsThePlayersChoice() throws Exception {
        // The server does not get to grant itself permission to skip encryption: it is written
        // down only when the player accepts an address that has none.
        Path gameDir = temp();
        UdmcConfig secure = UdmcConfig.load(gameDir);
        ClientProject.accept(gameDir, secure, offer("udmc-main", key()));
        expect(!secure.allowInsecureHttp, "An HTTPS project must not turn encryption off");

        Path plain = temp();
        UdmcConfig config = UdmcConfig.load(plain);
        ClientProject.Offer http = new ClientProject.Offer("udmc-main", "Pack", "http://192.168.1.10:3077/", key());
        expect(http.insecure(), "An http address must be reported as unencrypted");
        ClientProject.accept(plain, config, http);
        expect(config.allowInsecureHttp, "Accepting an http address is what allows http");
    }

    private static ClientProject.Offer offer(String packId, String publicKey) {
        return new ClientProject.Offer(packId, "Test pack", "https://mc.example.com:3077/", publicKey);
    }

    private static String key() throws Exception {
        return Base64.getEncoder().encodeToString(KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic().getEncoded());
    }

    private static Path temp() throws Exception {
        Path root = Files.createTempDirectory("udmc-client-project-");
        root.toFile().deleteOnExit();
        return root;
    }

    private interface Action {
        void run();
    }

    private static void fails(Action action) {
        try {
            action.run();
            throw new AssertionError("Expected a refusal");
        } catch (IllegalArgumentException expected) {
            // The offer was refused, which is the point.
        }
    }

    private static void expect(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
