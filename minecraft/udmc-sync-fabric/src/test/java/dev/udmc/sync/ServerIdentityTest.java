package dev.udmc.sync;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** A server with no project makes one for itself, and says how to claim it. */
public final class ServerIdentityTest {
    public static void main(String[] args) throws Exception {
        freshServerCreatesAProjectAndAsksToBeClaimed();
        theProjectSurvivesRestarts();
        generatedKeysActuallySign();
        pairingSpendsTheCode();
        anExistingProjectIsLeftAlone();
        resetIssuesANewCodeWithoutLosingThePlayersTrust();
        codesAndTokensAreNotPredictable();
        theCodeIsTheOnlyWayIn();
        aTypedCodeStillWorks();
        theProjectHandedOverCarriesNoSigningKey();
        guessingIsThrottled();
        theCommandSaysWhatToDoNext();
        System.out.println("ServerIdentityTest OK");
    }

    private static void freshServerCreatesAProjectAndAsksToBeClaimed() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        expect(ServerIdentity.ensure(gameDir, config), "A server without a project must create one");

        expect(!config.manifestPublicKey.isBlank() && !config.manifestPrivateKey.isBlank(), "The signing pair must be created");
        expect(!config.adminToken.isBlank() && !ServerIdentity.UNSET_TOKEN.equals(config.adminToken), "The admin token must be created");
        expect(config.requireSignedManifest, "A self-made project signs its manifests");
        expect(ServerIdentity.unpaired(config), "A new project waits to be paired");
        expect(config.pairingCode.matches("[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}"), "Unexpected pairing code: " + config.pairingCode);

        // Whoever has only a file manager must still be able to read the code.
        Path note = ServerIdentity.notePath(gameDir);
        expect(note.equals(gameDir.resolve("config").resolve("udmc-pairing.txt")), "The note must sit beside the config, which is never served over HTTP");
        expect(Files.exists(note), "The pairing note must be written");
        expect(Files.readString(note, StandardCharsets.UTF_8).contains(config.pairingCode), "The note must carry the code");

        // What was created has to survive the process, not just this object.
        UdmcConfig reloaded = UdmcConfig.load(gameDir);
        expect(reloaded.pairingCode.equals(config.pairingCode), "The code must be saved");
        expect(reloaded.adminToken.equals(config.adminToken), "The token must be saved");
    }

    private static void theProjectSurvivesRestarts() throws Exception {
        Path gameDir = temp();
        UdmcConfig first = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, first);

        UdmcConfig second = UdmcConfig.load(gameDir);
        expect(!ServerIdentity.ensure(gameDir, second), "A restart must not rewrite an existing project");
        expect(second.pairingCode.equals(first.pairingCode), "The code must not change on restart: there is no window to miss");
        expect(second.manifestPublicKey.equals(first.manifestPublicKey), "The signing key must not change on restart");
        expect(second.adminToken.equals(first.adminToken), "The token must not change on restart");
        expect(Files.exists(ServerIdentity.notePath(gameDir)), "The note must stay while the server is unpaired");
    }

    private static void generatedKeysActuallySign() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, config);
        // The same base64 shapes Control has always produced, or clients cannot check a manifest.
        byte[] body = "manifest".getBytes(StandardCharsets.UTF_8);
        ManifestSecurity.verify(body, ManifestSecurity.sign(body, config.manifestPrivateKey), config.manifestPublicKey);
    }

    private static void pairingSpendsTheCode() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, config);

        ServerIdentity.paired(gameDir, config);
        expect(!ServerIdentity.unpaired(config), "A paired server has no code left");
        expect(!Files.exists(ServerIdentity.notePath(gameDir)), "The note must disappear once the code is spent");
        expect(UdmcConfig.load(gameDir).pairingCode.isBlank(), "The spent code must not come back from disk");

        UdmcConfig restarted = UdmcConfig.load(gameDir);
        expect(!ServerIdentity.ensure(gameDir, restarted), "A paired server must not issue itself a new code");
        expect(!Files.exists(ServerIdentity.notePath(gameDir)), "A paired server must not write the note again");
    }

    private static void anExistingProjectIsLeftAlone() throws Exception {
        // What a Control-generated JAR used to leave behind: a project, and nothing to claim.
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, config);
        String key = config.manifestPublicKey, token = config.adminToken;
        ServerIdentity.paired(gameDir, config);

        UdmcConfig upgraded = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, upgraded);
        expect(upgraded.manifestPublicKey.equals(key), "An existing project keeps its identity");
        expect(upgraded.adminToken.equals(token), "An existing project keeps its token");
        expect(!ServerIdentity.unpaired(upgraded), "An existing project is already claimed and must not offer a code");
    }

    private static void resetIssuesANewCodeWithoutLosingThePlayersTrust() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, config);
        String key = config.manifestPublicKey, token = config.adminToken, code = config.pairingCode;
        ServerIdentity.paired(gameDir, config);

        UdmcConfig reset = UdmcConfig.load(gameDir);
        reset.resetPairing = true;
        expect(ServerIdentity.ensure(gameDir, reset), "A reset must change the configuration");
        expect(!reset.resetPairing, "The reset flag must clear itself so it does not fire again");
        expect(!reset.adminToken.equals(token), "A reset must cut off whoever paired before");
        expect(reset.manifestPublicKey.equals(key), "A reset must keep the key players already trust");
        expect(ServerIdentity.unpaired(reset) && !reset.pairingCode.equals(code), "A reset must issue a new code");
        expect(Files.exists(ServerIdentity.notePath(gameDir)), "A reset must bring the note back");
        expect(UdmcConfig.load(gameDir).resetPairing == false, "The cleared flag must be saved");
    }

    private static void codesAndTokensAreNotPredictable() throws Exception {
        Set<String> codes = new HashSet<>(), tokens = new HashSet<>();
        for (int run = 0; run < 8; run++) {
            Path gameDir = temp();
            UdmcConfig config = UdmcConfig.load(gameDir);
            ServerIdentity.ensure(gameDir, config);
            codes.add(config.pairingCode);
            tokens.add(config.adminToken);
        }
        expect(codes.size() == 8, "Pairing codes must not repeat");
        expect(tokens.size() == 8, "Admin tokens must not repeat");
    }


    private static void theCodeIsTheOnlyWayIn() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, config);
        String code = config.pairingCode;

        refused(403, "PAIRING_CODE_INVALID", () -> ServerIdentity.claim(gameDir, config, "AAAA-BBBB-CCCC-DDDD", "10.0.0.1"));
        refused(403, "PAIRING_CODE_INVALID", () -> ServerIdentity.claim(gameDir, config, "", "10.0.0.1"));
        refused(403, "PAIRING_CODE_INVALID", () -> ServerIdentity.claim(gameDir, config, null, "10.0.0.1"));
        expect(config.pairingCode.equals(code), "A wrong guess must not consume the code");
        expect(Files.exists(ServerIdentity.notePath(gameDir)), "A wrong guess must not remove the note");

        Map<String, Object> project = ServerIdentity.claim(gameDir, config, code, "10.0.0.2");
        expect(config.adminToken.equals(project.get("adminToken")), "Pairing must hand over the admin token");
        expect(config.manifestPublicKey.equals(project.get("manifestPublicKey")), "Pairing must hand over the public key");
        expect(String.valueOf(project.get("fingerprint")).matches("[a-f0-9]{64}"), "Pairing must show a fingerprint to compare");

        // Spent, and spent for good: a second panel cannot walk in behind the first.
        refused(409, "PAIRING_ALREADY_DONE", () -> ServerIdentity.claim(gameDir, config, code, "10.0.0.3"));
        expect(!Files.exists(ServerIdentity.notePath(gameDir)), "Pairing must take the note off disk");
    }

    private static void aTypedCodeStillWorks() throws Exception {
        // Read off a console and typed back in, a code loses its dashes and its case.
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, config);
        String typed = "  " + config.pairingCode.toLowerCase(java.util.Locale.ROOT).replace("-", "") + "  ";
        ServerIdentity.claim(gameDir, config, typed, "10.0.1.1");
        expect(!ServerIdentity.unpaired(config), "A code typed without dashes or capitals must still pair");
    }

    private static void theProjectHandedOverCarriesNoSigningKey() throws Exception {
        // The server signs its own manifests. Whoever holds the private key can impersonate the
        // project to every player, so pairing must not be the thing that puts it on the network.
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, config);
        // Read both before pairing: claiming clears the code, and "contains an empty string" is
        // true of every string, which is a test that passes without checking anything.
        String code = config.pairingCode, signingKey = config.manifestPrivateKey;
        Map<String, Object> project = ServerIdentity.claim(gameDir, config, code, "10.0.2.1");
        String body = new com.google.gson.Gson().toJson(project);
        expect(!body.contains(signingKey), "Pairing must never hand out the signing key");
        expect(!body.toLowerCase(java.util.Locale.ROOT).contains("privatekey"), "Pairing must not carry a private key field");
        expect(!body.contains(code), "Pairing must not echo the code back");
    }

    private static void guessingIsThrottled() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, config);
        for (int attempt = 0; attempt < 10; attempt++) {
            refused(403, "PAIRING_CODE_INVALID", () -> ServerIdentity.claim(gameDir, config, "AAAA-BBBB-CCCC-DDDD", "10.0.3.1"));
        }
        refused(429, "PAIRING_RATE_LIMIT", () -> ServerIdentity.claim(gameDir, config, "AAAA-BBBB-CCCC-DDDD", "10.0.3.1"));
        // One address running out of attempts must not lock out the owner on another.
        ServerIdentity.claim(gameDir, config, config.pairingCode, "10.0.3.2");
        expect(!ServerIdentity.unpaired(config), "A throttled guesser must not block the real panel");
    }

    private static void theCommandSaysWhatToDoNext() throws Exception {
        Path gameDir = temp();
        UdmcConfig config = UdmcConfig.load(gameDir);
        ServerIdentity.ensure(gameDir, config);
        UdmcCommand.bind(gameDir, config);

        // Control reads the code and the port straight out of an RCON reply, so both must be there.
        String waiting = UdmcCommand.pairing();
        expect(waiting.contains(config.pairingCode), "The command must show the code: " + waiting);
        expect(waiting.contains(String.valueOf(config.apiPort)), "The command must show the API port: " + waiting);

        ServerIdentity.claim(gameDir, config, config.pairingCode, "10.0.4.1");
        String done = UdmcCommand.pairing();
        expect(!done.contains("code:"), "A paired server must not offer a code: " + done);
        expect(done.contains("resetPairing"), "A paired server must say how to pair again: " + done);
    }

    private interface Attempt {
        void run();
    }

    private static void refused(int status, String code, Attempt attempt) {
        try {
            attempt.run();
            throw new AssertionError("Expected " + code + " but the call succeeded");
        } catch (ApiException error) {
            expect(error.status == status && code.equals(error.code),
                "Expected " + status + " " + code + ", got " + error.status + " " + error.code);
        }
    }

    private static Path temp() throws Exception {
        Path root = Files.createTempDirectory("udmc-identity-test-");
        root.toFile().deleteOnExit();
        return root;
    }

    private static void expect(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
