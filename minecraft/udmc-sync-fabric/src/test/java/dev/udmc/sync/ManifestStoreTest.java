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
            System.out.println("ManifestStore tests passed: draft lifecycle, migration, rollback, blob integrity, path validation, detach.");
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
