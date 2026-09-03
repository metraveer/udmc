package dev.udmc.sync;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class ManifestStoreTest {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("udmc-store-test-");
        try {
            testDraftLifecycle(root.resolve("lifecycle"));
            testRollback(root.resolve("rollback"));
            testConfigFailure(root.resolve("config-failure"));
            testCatalogSource(root.resolve("catalog-source"));
            testDetach(root.resolve("detach"));
            testPaths();
            registryWarnings();
            identityAndReplacement();
            System.out.println("ManifestStore tests passed: draft lifecycle, migration, rollback, blob integrity, path validation, detach, mods players do not receive, mod identity and replacement.");
        } finally {
            TestMods.deleteTree(root);
        }
    }

    private static void testDraftLifecycle(Path gameDir) throws Exception {
        ManifestStore store = new ManifestStore(gameDir, new UdmcConfig());
        store.upsertFile("mods/example.jar", "both", TestMods.jar("example", "1.0.0"));
        expect(store.loadPublished().files.isEmpty(), "Upload leaked into published manifest");
        expect(!Files.exists(gameDir.resolve("mods/example.jar")), "Upload wrote to server before publication");
        expect(store.draftState().changes.added == 1, "Addition missing from draft");

        store.publish("0.1.1");
        expect(modVersion(gameDir.resolve("mods/example.jar")).equals("1.0.0"), "Published file was not installed");
        expect(!store.draftState().changes.dirty, "Draft was not reset after publication");
        store.deleteFile("mods/example.jar");
        expect(Files.exists(gameDir.resolve("mods/example.jar")), "Draft deletion removed server file");
        expect(store.loadPublished().files.size() == 1, "Draft deletion leaked into published manifest");
        expect(store.draftState().changes.removed == 1, "Removal is not visible in draft");
        store.revertFile("mods/example.jar");
        expect(!store.draftState().changes.dirty, "Undo did not restore published file");

        store.upsertFile("mods/example.jar", "both", TestMods.jar("example", "2.0.0"));
        expect(modVersion(gameDir.resolve("mods/example.jar")).equals("1.0.0"), "Update wrote before publication");
        store.publish(null);
        expect(store.loadPublished().pack.version.equals("0.1.2"), "Automatic version bump failed");
        expect(modVersion(gameDir.resolve("mods/example.jar")).equals("2.0.0"), "Update was not installed");

        ManifestStore.FileUpdate update = new ManifestStore.FileUpdate();
        update.path = "mods/example.jar";
        update.side = "client";
        store.updateFile(update);
        expect(Files.exists(gameDir.resolve("mods/example.jar")), "Side change applied before publication");
        store.publish(null);
        expect(!Files.exists(gameDir.resolve("mods/example.jar")), "Server file remained after change to client-only");

        Files.delete(gameDir.resolve("udmc-sync/draft.json"));
        expect(!new ManifestStore(gameDir, new UdmcConfig()).draftState().changes.dirty, "Legacy manifest migration failed");
        store.upsertFile("mods/temporary.jar", "client", TestMods.jar("temporary", "1.0.0"));
        store.deleteFile("mods/temporary.jar");
        expect(!store.draftState().changes.dirty, "Deleting an unpublished addition left a change");

        store.upsertFile("mods/corrupt.jar", "server", TestMods.jar("corrupt", "1.0.0"));
        var file = store.loadDraft().files.stream().filter(item -> item.path.equals("mods/corrupt.jar")).findFirst().orElseThrow();
        Files.writeString(store.blobPath(file.downloadPath.substring("/files/".length())), "corrupt");
        expectFailure(() -> store.publish(null));
        expect(!Files.exists(gameDir.resolve("mods/corrupt.jar")), "Corrupt blob reached server");
        store.resetDraft();
        expect(!store.draftState().changes.dirty, "Reset failed");
        expectFailure(() -> store.publish(null));

        store.upsertFile("config/test.json", "server", bytes("managed"));
        store.publish(null);
        Files.writeString(gameDir.resolve("config/test.json"), "local modification");
        store.deleteFile("config/test.json");
        store.publish(null);
        expect(Files.readString(gameDir.resolve("config/test.json")).equals("local modification"), "Removal deleted local changes");
    }

    private static void testRollback(Path gameDir) throws Exception {
        ManifestStore store = new ManifestStore(gameDir, new UdmcConfig());
        store.upsertFile("mods/a.jar", "server", TestMods.jar("first", "1.0.0"));
        store.publish("1.0.0");
        store.upsertFile("mods/a.jar", "server", TestMods.jar("first", "2.0.0"));
        store.upsertFile("mods/z/blocked.jar", "server", TestMods.jar("blocked", "1.0.0"));
        Files.writeString(gameDir.resolve("mods/z"), "blocks a directory");
        expectFailure(() -> store.publish("1.0.1"));
        expect(modVersion(gameDir.resolve("mods/a.jar")).equals("1.0.0"), "Failed publication did not restore server file");
        expect(store.loadPublished().pack.version.equals("1.0.0"), "Failed publication changed public version");
        expect(store.draftState().changes.dirty, "Failed publication discarded draft");
    }

    private static void testConfigFailure(Path gameDir) throws Exception {
        ManifestStore store = new ManifestStore(gameDir, new UdmcConfig());
        store.upsertFile("mods/test.jar", "server", TestMods.jar("testmod", "1.0.0"));
        Files.writeString(gameDir.resolve("config"), "blocks config save");
        expectFailure(() -> store.publish("1.0.0"));
        expect(store.loadPublished().files.isEmpty(), "Config failure left a published manifest");
        expect(!Files.exists(gameDir.resolve("mods/test.jar")), "Config failure left an installed file");
    }

    private static void testPaths() throws Exception {
        for (String path : new String[]{"mods/../config/a.json", "mods/", "mods/con.jar", "mods/file:ads", "config/udmc-sync.json"}) {
            expectFailure(() -> ManagedPaths.normalize(path));
        }
    }

    private static void testCatalogSource(Path gameDir) throws Exception {
        ManifestStore store = new ManifestStore(gameDir, new UdmcConfig());
        byte[] jar = TestMods.jar("catalog_test", "1.0.0");
        store.upsertFile("mods/catalog.jar", "both", jar); store.publish(null);
        Path installed = gameDir.resolve("mods/catalog.jar");
        var timestamp = java.nio.file.attribute.FileTime.fromMillis(1_600_000_000_000L);
        Files.setLastModifiedTime(installed, timestamp);
        var source = new ManifestModels.FileSource();
        source.provider = "github"; source.projectId = "Example/Mod"; source.versionId = "123"; source.environment = "jar_universal";
        store.upsertFile("mods/catalog.jar", "both", new java.io.ByteArrayInputStream(jar), () -> {}, source);
        expect(store.draftState().changes.updated == 1, "Source-only change was lost");
        expect(!store.draftState().changes.serverRestartRecommended, "Source-only change needs no game restart");
        store.publish(null);
        expect(Files.getLastModifiedTime(installed).equals(timestamp), "Source metadata rewrote a server JAR");
        expect(store.loadPublished().files.getFirst().source.projectId.equals("Example/Mod"), "Source metadata was not published");
        source.projectId = "../private";
        expectFailure(() -> store.upsertFile("mods/catalog.jar", "both", new java.io.ByteArrayInputStream(jar), () -> {}, source));
        expect(!store.draftState().changes.dirty, "Rejected source changed the draft");
        var curseforge = new ManifestModels.FileSource();
        curseforge.provider = "curseforge"; curseforge.projectId = "388172"; curseforge.versionId = "8759214"; curseforge.environment = "jar_universal";
        store.upsertFile("mods/catalog.jar", "both", new java.io.ByteArrayInputStream(jar), () -> {}, curseforge);
        store.publish(null);
        expect(store.loadPublished().files.getFirst().source.provider.equals("curseforge"), "CurseForge source was not published");
        curseforge.projectId = "not-numeric";
        expectFailure(() -> store.upsertFile("mods/catalog.jar", "both", new java.io.ByteArrayInputStream(jar), () -> {}, curseforge));
        var unknown = new ManifestModels.FileSource();
        unknown.provider = "future-provider"; unknown.projectId = "1"; unknown.versionId = "1"; unknown.environment = "manual";
        expectFailure(() -> store.upsertFile("mods/catalog.jar", "both", new java.io.ByteArrayInputStream(jar), () -> {}, unknown));
    }

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static String modVersion(Path path) throws Exception { return ModMetadata.read(path, path.toString()).getFirst().version(); }

    /** Detaching returns a managed file to "outside the pack" without deleting it. */
    private static void testDetach(Path gameDir) throws Exception {
        ManifestStore store = new ManifestStore(gameDir, new UdmcConfig());
        store.upsertFile("config/example.json", "server", "{\"generated\": true}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        store.upsertFile("mods/shared.jar", "both", TestMods.jar("shared", "1.0.0"));
        store.publish("0.2.0");
        Path config = gameDir.resolve("config/example.json");
        expect(Files.exists(config), "Published config was not installed");

        expectFailure(() -> store.detachFile("mods/shared.jar"));
        expect(store.loadPublished().files.size() == 2, "A refused detach changed the published pack");

        var state = store.detachFile("config/example.json");
        expect(state.changes.removed == 1 && state.changes.dirty, "Detach is not visible in the draft");
        expect(state.files.stream().anyMatch(file -> file.path.equals("config/example.json") && file.detached), "Detached row is not marked");
        expect(Files.exists(config), "Detach deleted the server file before publication");

        store.publish(null);
        expect(Files.exists(config), "Publishing a detached file deleted it from the server");
        expect(store.loadPublished().files.stream().noneMatch(file -> file.path.equals("config/example.json")), "Detached file stayed in the pack");
        expect(store.loadPublished().detached.isEmpty(), "Private detach list leaked into the published manifest");
        expect(store.inventory().toString().contains("config/example.json"), "Detached file did not return to the out-of-pack list");

        // The same file can be taken back under management afterwards.
        store.importServerFile("config/example.json", "server", Hashes.sha256(config));
        expect(store.draftState().changes.added == 1, "Re-adopting a detached file failed");
    }

    /**
     * A mod that has put entries into the game's registries and is not handed to players locks
     * every new player out before UDMC can ask them anything: the game refuses a client
     * without those entries during registry synchronisation. The panel has to say so - by file
     * and by mod where the server can trace the namespace, by namespace alone where it cannot -
     * and stay quiet about mods players do receive.
     */
    private static void registryWarnings() throws Exception {
        Path gameDir = Files.createTempDirectory("udmc-registry-warnings-");
        Files.createDirectories(gameDir.resolve("mods"));
        ManifestStore store = new ManifestStore(gameDir, new UdmcConfig());
        store.upsertFile("mods/shared.jar", "both", TestMods.jar("shared", "1.0.0"));
        store.upsertFile("mods/serveronly.jar", "server", TestMods.jar("serveronly", "1.0.0"));
        store.publish("1.0.0");
        Files.write(gameDir.resolve("mods/minimap.jar"), TestMods.jar("xaerominimap", "26.4.2"));
        store.attachRegistries(() -> java.util.Map.of("xaerominimap", 12, "shared", 3, "serveronly", 1, "orphan", 2));
        var codes = codes(store.validation(true));
        expect(codes.contains("udmc_sync.diagnostic.not_delivered [mods/minimap.jar, xaerominimap, 12]"),
            "A mod on the server with registry entries must be named by file and id: " + codes);
        expect(codes.contains("udmc_sync.diagnostic.not_delivered [mods/serveronly.jar, serveronly, 1]"),
            "A mod published for the server only is not handed to players either: " + codes);
        expect(codes.contains("udmc_sync.diagnostic.not_delivered_namespace [orphan, 2]"),
            "Entries nobody on the server accounts for are still reported: " + codes);
        expect(codes.stream().noneMatch(code -> code.contains("shared")), "A mod players receive raises nothing: " + codes);
        // Said, never enforced: the check still passes, and a publication still goes through.
        @SuppressWarnings("unchecked")
        var levels = ((java.util.List<java.util.Map<String, Object>>) store.validation(true).get("issues")).stream()
            .filter(issue -> String.valueOf(issue.get("code")).startsWith("udmc_sync.diagnostic.not_delivered")).map(issue -> issue.get("level")).toList();
        expect(!levels.isEmpty() && levels.stream().allMatch("warning"::equals), "Registry findings must be warnings: " + levels);
        expect(Boolean.TRUE.equals(store.validation(true).get("ok")), "Warnings alone must not fail the check");
        store.upsertFile("mods/another.jar", "both", TestMods.jar("another", "1.0.0"));
        expect(Boolean.TRUE.equals(store.validation(false).get("ok")), "A draft with only warnings must be publishable");
        store.publish("1.0.1");
        expect(Files.exists(gameDir.resolve("mods/another.jar")), "Publication must go through despite registry warnings");
        store.attachRegistries(java.util.Map::of);
        expect(codes(store.validation(true)).stream().noneMatch(code -> code.startsWith("udmc_sync.diagnostic.not_delivered")),
            "Without registry entries there is nothing to warn about");
    }

    /**
     * A panel about to add a mod from a catalog has to know whether the same mod is already
     * here at another version - in the draft, or on the server outside the pack - and it has
     * to be able to put the new file in the old one's place in a single step.
     */
    private static void identityAndReplacement() throws Exception {
        Path gameDir = Files.createTempDirectory("udmc-identity-");
        Files.createDirectories(gameDir.resolve("mods"));
        ManifestStore store = new ManifestStore(gameDir, new UdmcConfig());
        store.upsertFile("mods/thelib-1.0.0.jar", "both", TestMods.jar("thelib", "1.0.0"));
        store.upsertFile("config/thelib.json", "both", "{}".getBytes(StandardCharsets.UTF_8));
        var rows = store.draftState().files;
        var lib = rows.stream().filter(row -> row.path.equals("mods/thelib-1.0.0.jar")).findFirst().orElseThrow();
        expect(lib.modIds.equals(java.util.List.of("thelib")) && "1.0.0".equals(lib.modVersion), "A draft jar must be named by its mod id and version: " + lib.modIds + " " + lib.modVersion);
        var config = rows.stream().filter(row -> row.path.equals("config/thelib.json")).findFirst().orElseThrow();
        expect(config.modIds.isEmpty() && config.modVersion == null, "A file that is not a mod answers for nothing");

        Files.write(gameDir.resolve("mods/stray-2.jar"), TestMods.jar("stray", "2.0.0"));
        @SuppressWarnings("unchecked")
        var inventory = (java.util.List<java.util.Map<String, Object>>) store.inventory().get("files");
        var stray = inventory.stream().filter(row -> row.get("path").equals("mods/stray-2.jar")).findFirst().orElseThrow();
        expect(java.util.List.of("stray").equals(stray.get("modIds")) && "2.0.0".equals(stray.get("modVersion")), "A server file outside the pack is named the same way: " + stray);

        // The same mod at another version takes the old file's place in one step.
        var replaced = store.upsertFile("mods/thelib-2.0.0.jar", "both", new java.io.ByteArrayInputStream(TestMods.jar("thelib", "2.0.0")), () -> {}, null, "mods/thelib-1.0.0.jar");
        var paths = store.draftState().files.stream().filter(row -> !row.change.equals("removed")).map(row -> row.path).toList();
        expect(paths.contains("mods/thelib-2.0.0.jar") && !paths.contains("mods/thelib-1.0.0.jar"), "Replacing must remove the old path and add the new: " + paths);
        expect("2.0.0".equals(store.draftState().files.stream().filter(row -> row.path.equals(replaced.path)).findFirst().orElseThrow().modVersion), "The new row carries the new version");
        expectFailure(() -> store.upsertFile("mods/thelib-3.0.0.jar", "both", new java.io.ByteArrayInputStream(TestMods.jar("thelib", "3.0.0")), () -> {}, null, "mods/never-there.jar"));
        expect(store.draftState().files.stream().noneMatch(row -> row.path.equals("mods/thelib-3.0.0.jar")), "A replacement of a file that is not there adds nothing");
    }

    @SuppressWarnings("unchecked")
    private static java.util.List<String> codes(java.util.Map<String, Object> validation) {
        return ((java.util.List<java.util.Map<String, Object>>) validation.get("issues")).stream()
            .map(issue -> issue.get("code") + " " + issue.get("args")).toList();
    }

    private static void expect(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void expectFailure(ThrowingAction action) throws Exception {
        try {
            action.run();
        } catch (Exception expected) {
            return;
        }
        throw new AssertionError("Expected operation to fail");
    }

    private interface ThrowingAction {
        void run() throws Exception;
    }
}
