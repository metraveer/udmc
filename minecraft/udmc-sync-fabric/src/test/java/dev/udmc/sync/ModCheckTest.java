package dev.udmc.sync;

import com.google.gson.JsonObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class ModCheckTest {
    public static void main(String[] args) throws Exception {
        if (args.length > 0) {
            var real = ModMetadata.read(Path.of(args[0]), "mods/fabric-api.jar");
            var problems = ModMetadata.problems(real, "client", new UdmcConfig());
            check(problems.isEmpty(), "Live Fabric API metadata: " + problems);
            System.out.println("Live Fabric API inspected: " + real.size() + " modules");
        }
        Path root = Files.createTempDirectory("udmc-mod-check-");
        try {
            Path game = root.resolve("client"); Files.createDirectories(game.resolve("mods"));
            byte[] correct = TestMods.jar("example", "2.0.0");
            Path source = root.resolve("source.jar"); Files.write(source, correct);
            Path personal = game.resolve("mods/my-name.jar"); Files.write(personal, correct);
            var desired = desired("mods/server-name.jar", correct);
            var downloads = new LinkedHashMap<Path, Path>(); downloads.put(game.resolve("mods/server-name.jar"), source);
            var borrowed = ClientModCheck.check(game, new UdmcConfig(), desired, downloads, Map.of());
            check(borrowed.contains("mods/my-name.jar") && downloads.isEmpty(), "Identical renamed personal JAR must be borrowed");
            check(desired.containsKey("mods/my-name.jar") && Files.exists(personal), "Reuse must preserve the original name");

            Files.write(personal, TestMods.jar("example", "1.0.0"));
            desired = desired("mods/server-name.jar", correct); downloads.put(game.resolve("mods/server-name.jar"), source);
            ClientModCheck.Conflicts conflict = conflicts(game, desired, downloads);
            check(conflict.files.stream().anyMatch(f -> f.path().equals("mods/my-name.jar")), "Conflict must name the personal file");
            check(!Files.exists(game.resolve("mods/server-name.jar")), "Preflight must not install conflicting mods");
            var removal = conflict.files.getFirst();
            Files.write(personal, TestMods.jar("example", "1.1.0"));
            fails(() -> ClientModCheck.disable(game, removal));
            check(Files.exists(personal), "Changed file must not be removed using stale consent");
            conflict = conflicts(game, desired, downloads);
            Path unrelated = game.resolve("mods/unrelated.jar"); Files.write(unrelated, TestMods.jar("unrelated", "1.0.0"));
            Path backup = ClientModCheck.disable(game, conflict.files.getFirst());
            check(Files.exists(backup) && !Files.exists(personal) && Files.exists(unrelated), "Disable must back up exactly one file");

            JsonObject depends = new JsonObject(); depends.addProperty("library", TestMods.atLeast("2.0.0"));
            Path dependent = root.resolve("dependent.jar"); Files.write(dependent, TestMods.jar("dependent", "1.0.0", depends, new JsonObject()));
            var metadata = ModMetadata.read(dependent, "mods/dependent.jar");
            check(!ModMetadata.problems(metadata, "client", new UdmcConfig()).isEmpty(), "Missing dependency must be reported");
            var diagnostic = ModMetadata.diagnostics(metadata, "client", new UdmcConfig()).getFirst();
            check(diagnostic.detail().key().equals("udmc_sync.diagnostic.required") && diagnostic.paths().equals(List.of("mods/dependent.jar")), "Diagnostics must have a stable code and exact paths");
            exactConflictOwnership(root.resolve("ownership"));
            check(ModMetadata.matches("2.1.0", List.of(TestMods.range("2.0.0", "3.0.0"))), "Use the loader's version parser");
            check(!ModMetadata.matches("1.0.0", List.of(TestMods.atLeast("2.0.0"))), "Old dependency must fail");

            ManifestStore store = new ManifestStore(root.resolve("server"), new UdmcConfig());
            store.upsertFile("mods/dependent.jar", "both", Files.readAllBytes(dependent));
            fails(() -> store.publish(null));
            check(store.loadPublished().files.isEmpty(), "Invalid dependency graph must not be published");
            store.upsertFile("mods/library.jar", "both", TestMods.jar("library", "2.0.0"));
            store.publish(null);
            store.deleteFile("mods/library.jar");
            fails(() -> store.publish(null));
            check(Files.exists(root.resolve("server/mods/library.jar")), "Required dependency must survive rejected deletion");
            store.resetDraft();
            store.upsertFile("mods/duplicate.jar", "both", TestMods.jar("library", "2.0.0"));
            try {
                store.publish(null);
                check(false, "Duplicate publication must fail");
            } catch (ApiException error) {
                check(error.status == 409 && "PUBLISH_BLOCKED_BY_VALIDATION".equals(error.code)
                    && error.args.size() == 1 && Integer.parseInt(error.args.getFirst()) > 0,
                    "Publication rejection must carry the stable validation code");
            }
            diagnosticsAndServerRemoval(root.resolve("unmanaged"), Files.readAllBytes(dependent));
            aLibraryThePlayerAlreadyHas(root.resolve("launcher"));
            System.out.println("Mod checks passed: renamed personal mods, conflicts, stale consent, backups, missing dependencies, duplicate IDs, publication guards, libraries the player already has.");
        } finally { TestMods.deleteTree(root); }
    }
    private static void diagnosticsAndServerRemoval(Path game, byte[] dependent) throws Exception {
        Files.createDirectories(game.resolve("mods"));
        Files.write(game.resolve("mods/dependent.jar"), dependent);
        // Loaders never read nested directories: mod-owned libraries such as
        // luckperms/libs must not surface as issues or block publishing.
        Files.createDirectories(game.resolve("mods/luckperms/libs"));
        Files.write(game.resolve("mods/luckperms/libs/not-a-mod.jar"), new byte[] {1, 2, 3});
        var store = new ManifestStore(game, new UdmcConfig());
        for (Object nested : (List<?>) store.validation(true).get("issues")) {
            check(!((Map<?, ?>) nested).get("message").toString().contains("not-a-mod"),
                "A nested library jar must not be inspected as a mod");
        }
        var validation = store.validation(true);
        check(validation.get("ok").equals(false), "Installed missing dependency was not diagnosed");
        var issue = (Map<?, ?>) ((List<?>) validation.get("issues")).getFirst();
        check(issue.get("code").equals("udmc_sync.diagnostic.required") && issue.get("args") instanceof List<?> && issue.get("message") instanceof String,
            "API diagnostics must retain a legacy message alongside translation parameters");
        check(store.validation(false).get("ok").equals(false), "Draft ignored an unmanaged server dependency");
        Path library = game.resolve("mods/library.jar"); Files.write(library, TestMods.jar("library", "2.0.0"));
        check(store.validation(true).get("ok").equals(true), "Valid installed mods failed diagnostics");
        String hash = Hashes.sha256(library);
        var state = store.removeServerFile("mods/library.jar", hash);
        check(state.changes.removed == 1 && state.changes.dirty && Files.exists(library), "Unmanaged removal did not stay in the draft");
        check(state.files.getFirst().serverRemoval, "Removal source missing");
        check(store.validation(false).get("ok").equals(false), "Removal of required unmanaged dependency was not diagnosed");
        fails(() -> store.publish(null));
        check(Files.exists(library), "Failed dependency validation deleted a server file");
        store.revertFile("mods/library.jar");
        check(!store.draftState().changes.dirty, "Could not cancel server removal");
        store.removeServerFile("mods/dependent.jar", Hashes.sha256(game.resolve("mods/dependent.jar")));
        store.removeServerFile("mods/library.jar", hash);
        fails(() -> store.importServerFile("mods/library.jar", "both", hash));
        Files.write(library, TestMods.jar("library", "3.0.0"));
        fails(() -> store.publish(null));
        check(Files.exists(game.resolve("mods/dependent.jar")), "Stale hash caused partial deletion");
        Files.write(library, TestMods.jar("library", "2.0.0"));
        store.publish(null);
        check(!Files.exists(library) && !Files.exists(game.resolve("mods/dependent.jar")), "Confirmed server removals not applied");
        check(store.loadPublished().serverRemovals.isEmpty() && !store.draftState().changes.dirty, "Private removals leaked into published state");
        try (var paths = Files.walk(game.resolve("udmc-sync"))) {
            check(paths.anyMatch(p -> p.endsWith("mods/library.jar")), "Removal backup was not retained");
        }
    }
    private static void exactConflictOwnership(Path game) throws Exception {
        Files.createDirectories(game.resolve("mods"));
        Files.write(game.resolve("mods/library.jar"), TestMods.jar("unrelated", "1.0.0"));
        var depends = new JsonObject(); depends.addProperty("missing_library", TestMods.atLeast("1.0.0"));
        Files.write(game.resolve("mods/library.jar-extra.jar"), TestMods.jar("needs_library", "1.0.0", depends, new JsonObject()));
        var conflicts = conflicts(game, new HashMap<>(), new HashMap<>());
        check(conflicts.files.size() == 1 && conflicts.files.getFirst().path().equals("mods/library.jar-extra.jar"),
            "An unrelated filename that is a prefix must never be offered for removal");
        Path backup = ClientModCheck.disable(game, conflicts.files.getFirst());
        check(Files.exists(backup) && Files.exists(game.resolve("mods/library.jar")), "Exact consent must preserve the unrelated prefix file");
    }
    /**
     * A library the player's launcher installed for them, which is not our file and does not
     * have to be. Reported by a server owner: TLauncher puts its own Fabric API into every
     * profile it creates and restores it at every start, so demanding our exact bytes left
     * everyone on that launcher unable to play - the pack could never be applied, and removing
     * the file by hand was undone before the next launch. What the mods actually ask for is a
     * version range, and the copy on disk was inside it by a mile.
     */
    private static void aLibraryThePlayerAlreadyHas(Path game) throws Exception {
        Files.createDirectories(game.resolve("mods"));
        var needsLib = new JsonObject(); needsLib.addProperty("thelib", TestMods.atLeast("1.0.0"));

        byte[] ours = TestMods.jar("thelib", "2.0.0");
        byte[] dependent = TestMods.jar("needs_lib", "1.0.0", needsLib, new JsonObject());
        Path ourSource = game.resolve("../lib-source.jar").normalize(); Files.write(ourSource, ours);
        Path dependentSource = game.resolve("../dependent-source.jar").normalize(); Files.write(dependentSource, dependent);

        // The launcher's copy: a different build, a different name, and a version the dependent
        // mod is perfectly happy with.
        Path launcherCopy = game.resolve("mods/thelib-1.5.0%2Bmc.jar");
        Files.write(launcherCopy, TestMods.jar("thelib", "1.5.0"));

        var desired = desired("mods/thelib-2.0.0.jar", ours);
        var dependentFile = new ManifestModels.ManifestFile();
        dependentFile.path = "mods/needs-lib.jar"; dependentFile.sha256 = Hashes.sha256(dependent);
        dependentFile.side = "both"; dependentFile.size = dependent.length;
        desired.put(dependentFile.path, dependentFile);
        var downloads = new LinkedHashMap<Path, Path>();
        downloads.put(game.resolve("mods/thelib-2.0.0.jar"), ourSource);
        downloads.put(game.resolve("mods/needs-lib.jar"), dependentSource);

        ClientModCheck.check(game, new UdmcConfig(), desired, downloads, Map.of());
        check(!desired.containsKey("mods/thelib-2.0.0.jar"), "The pack must stop carrying a library the player already satisfies");
        check(!downloads.containsKey(game.resolve("mods/thelib-2.0.0.jar")), "Nothing of ours may be installed over their copy");
        check(downloads.containsKey(game.resolve("mods/needs-lib.jar")), "Everything else still arrives");
        check(Files.exists(launcherCopy), "Their own file is never touched");

        // Below what the dependent mod accepts: that is a real problem, and the player is asked.
        Files.write(launcherCopy, TestMods.jar("thelib", "0.9.0"));
        var again = desired("mods/thelib-2.0.0.jar", ours);
        again.put(dependentFile.path, dependentFile);
        var downloadsAgain = new LinkedHashMap<Path, Path>();
        downloadsAgain.put(game.resolve("mods/thelib-2.0.0.jar"), ourSource);
        downloadsAgain.put(game.resolve("mods/needs-lib.jar"), dependentSource);
        var conflicts = conflicts(game, again, downloadsAgain);
        check(conflicts.files.stream().anyMatch(f -> f.path().equals("mods/thelib-1.5.0%2Bmc.jar")),
            "A copy that is too old for the mods that need it must still be named");
    }

    private static Map<String, ManifestModels.ManifestFile> desired(String path, byte[] bytes) {
        var file = new ManifestModels.ManifestFile(); file.path = path; file.sha256 = Hashes.sha256(bytes); file.side = "both"; file.size = bytes.length;
        return new HashMap<>(Map.of(path, file));
    }
    private static ClientModCheck.Conflicts conflicts(Path game, Map<String, ManifestModels.ManifestFile> desired, Map<Path, Path> downloads) throws Exception {
        try { ClientModCheck.check(game, new UdmcConfig(), desired, downloads, Map.of()); }
        catch (ClientModCheck.Conflicts e) { return e; }
        throw new AssertionError("Expected named conflicts");
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    private static void fails(Checked action) throws Exception { try { action.run(); } catch (Exception expected) { return; } throw new AssertionError("Expected failure"); }
    private interface Checked { void run() throws Exception; }
}
