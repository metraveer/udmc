package dev.udmc.sync;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.LinkOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

final class ClientModCheck {
    record Conflict(String path, String sha256, List<Messages.Message> reasons) {
        Conflict { reasons = List.copyOf(reasons); }
        Conflict(String path, String sha256, Messages.Message reason) { this(path, sha256, List.of(reason)); }
        String reason() { return String.join("\n", reasons.stream().map(Messages.Message::english).toList()); }
    }
    static final class Conflicts extends IOException {
        final List<Conflict> files;
        Conflicts(List<Conflict> files) {
            super(files.stream().map(f -> f.path + ": " + f.reason()).reduce((a, b) -> a + "\n" + b).orElse("Mod conflict"));
            this.files = List.copyOf(files);
        }
    }

    static Set<String> check(Path gameDir, UdmcConfig config, Map<String, ManifestModels.ManifestFile> desired,
                             Map<Path, Path> downloads, Map<String, ManifestModels.ManagedFile> oldFiles) throws IOException {
        List<Conflict> conflicts = new ArrayList<>();
        Set<String> borrowed = new HashSet<>();
        // Pack entries the player already satisfies with a copy of their own: not installed,
        // not compared against, and not part of the duplicate check that follows.
        Set<String> supplied = new HashSet<>();
        Map<String, List<ModMetadata.Mod>> required = new LinkedHashMap<>();
        Map<String, List<ModMetadata.Mod>> personal = new LinkedHashMap<>();
        Map<String, String> hashes = new HashMap<>();
        for (var entry : desired.entrySet()) {
            Path target = ManagedPaths.resolve(gameDir, entry.getKey());
            String hash = Files.exists(target) ? Hashes.sha256(target) : null;
            var old = oldFiles.get(entry.getKey());
            boolean owned = old != null && !old.borrowed && Objects.equals(hash, old.sha256);
            if (hash != null && !owned) {
                if (hash.equals(entry.getValue().sha256)) borrowed.add(entry.getKey());
                else conflicts.add(new Conflict(entry.getKey(), hash, Messages.of("udmc_sync.conflict.changed")));
            }
            if (isJar(entry.getKey())) {
                var mods = ModMetadata.read(downloads.getOrDefault(target, target), entry.getKey());
                if (mods.stream().anyMatch(m -> !m.nested() && "server".equals(m.environment()))) throw Messages.error("udmc_sync.error.server_only", entry.getKey());
                required.put(entry.getKey(), mods);
            }
        }
        Path modsDir = ManagedPaths.resolve(gameDir, "mods/.udmc-scan").getParent();
        if (Files.isDirectory(modsDir)) try (var files = Files.walk(modsDir, 8)) {
            var jars = files.filter(p -> Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS) && p.getFileName().toString().toLowerCase(java.util.Locale.ROOT).endsWith(".jar")).limit(2001).toList();
            if (jars.size() > 2000) throw Messages.error("udmc_sync.error.mod_limit");
            for (Path path : jars) {
                String relative = gameDir.relativize(path).toString().replace('\\', '/');
                ManagedPaths.resolve(gameDir, relative);
                if (AgentFiles.isAgent(path)) continue;
                String hash = Hashes.sha256(path);
                hashes.put(relative, hash);
                var old = oldFiles.get(relative);
                if (old != null && !old.borrowed && hash.equals(old.sha256)) continue;
                if (desired.containsKey(relative) && hash.equals(desired.get(relative).sha256)) continue;
                // Loaders only read jars directly in mods/; nested directories hold mod-owned
                // libraries (for example luckperms/libs) and must not raise personal-mod conflicts.
                if (!modsDir.equals(path.getParent())) continue;
                try { personal.put(relative, ModMetadata.read(path, relative)); }
                catch (IOException e) {
                    UdmcSync.LOGGER.warn("Cannot inspect personal mod {}", relative, e);
                    conflicts.add(new Conflict(relative, hash, Messages.of("udmc_sync.conflict.inspect", config.loaderType)));
                }
            }
        }
        for (var expected : required.entrySet()) {
            var roots = expected.getValue().stream().filter(m -> !m.nested()).toList();
            String requiredLabel = roots.stream().map(m -> m.id() + " " + m.version()).reduce((a, b) -> a + ", " + b).orElse(expected.getKey());
            List<String> identical = new ArrayList<>();
            List<String> standIn = new ArrayList<>();

            for (var installed : personal.entrySet()) {
                boolean sameId = installed.getValue().stream().anyMatch(m -> roots.stream().anyMatch(root -> m.id().equals(root.id()) || m.provides().contains(root.id())));
                if (!sameId) continue;
                if (hashes.get(installed.getKey()).equals(desired.get(expected.getKey()).sha256)) identical.add(installed.getKey());
                // The same mod from somewhere else. Different bytes are not the question: what
                // matters is whether every mod that depends on it is satisfied by the copy the
                // player already has. Launchers install libraries of their own - TLauncher puts
                // its Fabric API into every profile it makes - and demanding our exact file
                // turned "your copy is a different build" into a game that could not be played.
                else if (standsIn(installed, expected, required, personal, config)) standIn.add(installed.getKey());
                else conflicts.add(new Conflict(installed.getKey(), hashes.get(installed.getKey()),
                    Messages.of("udmc_sync.conflict.version", requiredLabel)));
            }
            if (!standIn.isEmpty() && identical.isEmpty()) {
                // Nothing of ours is installed for this entry: the pack does not carry it onto
                // this machine at all. Their file stays personal and untouched, and if it ever
                // goes away the next launch installs ours, because nothing provides it then.
                UdmcSync.LOGGER.info("UDMC keeps the player's own {}: it satisfies every mod that needs it", String.join(", ", standIn));
                desired.remove(expected.getKey());
                downloads.remove(ManagedPaths.resolve(gameDir, expected.getKey()));
                // Out of the picture entirely, or the duplicate check below would still see two
                // providers - ours, which is no longer going to exist here, and theirs.
                supplied.add(expected.getKey());
                continue;
            }
            Path target = ManagedPaths.resolve(gameDir, expected.getKey());
            if (identical.size() == 1 && !Files.exists(target)) {
                String actual = identical.getFirst();
                var file = desired.remove(expected.getKey());
                desired.put(actual, file);
                downloads.remove(target);
                borrowed.add(actual);
                personal.remove(actual);
            } else if (!identical.isEmpty()) {
                for (String actual : identical) conflicts.add(new Conflict(actual, hashes.get(actual), Messages.of("udmc_sync.conflict.duplicate", requiredLabel)));
            }
        }
        supplied.forEach(required::remove);
        List<ModMetadata.Mod> all = new ArrayList<>();
        required.values().forEach(all::addAll);
        personal.values().forEach(all::addAll);
        for (var problem : ModMetadata.diagnostics(all, "client", config)) {
            // Match parsed metadata paths exactly, never substrings of a translated explanation.
            var owners = personal.entrySet().stream().filter(entry -> entry.getValue().stream()
                .anyMatch(mod -> problem.paths().contains(mod.path()))).map(Map.Entry::getKey).toList();
            if (owners.isEmpty()) conflicts.add(new Conflict("", null, problem.detail()));
            else for (String owner : owners) conflicts.add(new Conflict(owner, hashes.get(owner), problem.detail()));
        }
        if (!conflicts.isEmpty()) {
            Map<String, Conflict> grouped = new LinkedHashMap<>();
            for (Conflict conflict : conflicts) grouped.merge(conflict.path, conflict, (a, b) ->
                new Conflict(a.path, a.sha256, java.util.stream.Stream.concat(a.reasons.stream(), b.reasons.stream()).distinct().toList()));
            throw new Conflicts(List.copyOf(grouped.values()));
        }
        return borrowed;
    }

    static Path disable(Path gameDir, Conflict conflict) throws IOException {
        if (conflict.path.isBlank() || conflict.sha256 == null) throw Messages.error("udmc_sync.error.admin_conflict");
        Path source = ManagedPaths.resolve(gameDir, conflict.path);
        if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS) || !Hashes.sha256(source).equals(conflict.sha256)) {
            throw Messages.error("udmc_sync.error.file_changed");
        }
        Path backup = ManagedPaths.internal(gameDir, "backups/" + java.util.UUID.randomUUID() + "/" + source.getFileName() + ".disabled");
        Files.createDirectories(backup.getParent());
        Files.copy(source, backup);
        if (!Hashes.sha256(backup).equals(conflict.sha256)) throw Messages.error("udmc_sync.error.backup");
        try { Files.delete(source); }
        catch (IOException error) { throw (IOException) Messages.error("udmc_sync.error.locked", conflict.path, gameDir.relativize(backup)).initCause(error); }
        return backup;
    }

    /**
     * Whether the copy the player already has can stand in for the pack's, leaving their file
     * alone and installing nothing over it. The mods are their own authority here: each one
     * declares the versions it accepts, so the test is simply whether swapping their copy in
     * for ours introduces a problem that ours did not have.
     */
    private static boolean standsIn(Map.Entry<String, List<ModMetadata.Mod>> theirs,
                                    Map.Entry<String, List<ModMetadata.Mod>> ours,
                                    Map<String, List<ModMetadata.Mod>> required,
                                    Map<String, List<ModMetadata.Mod>> personal,
                                    UdmcConfig config) throws IOException {
        List<ModMetadata.Mod> shared = new ArrayList<>();
        required.forEach((path, mods) -> { if (!path.equals(ours.getKey())) shared.addAll(mods); });
        personal.forEach((path, mods) -> { if (!path.equals(theirs.getKey())) shared.addAll(mods); });

        // Only a mod that is in the pack because something else needs it. A library is chosen by
        // the mods that depend on it, and they say in writing which versions will do - so any
        // copy inside that range is as good as ours. A mod nobody depends on was chosen by the
        // administrator for its own sake, and a different version of it is a real difference,
        // not a technicality: there the player is asked, exactly as before.
        Set<String> provided = new HashSet<>();
        for (var mod : ours.getValue()) { if (!mod.nested()) { provided.add(mod.id()); provided.addAll(mod.provides()); } }
        boolean neededByOthers = shared.stream().anyMatch(mod -> mod.dependencies().stream()
            .anyMatch(dependency -> provided.contains(dependency.id())
                && (dependency.type().equals("required") || dependency.type().equals("optional"))));
        if (!neededByOthers) return false;

        return signatures(shared, ours.getValue(), config).containsAll(signatures(shared, theirs.getValue(), config));
    }

    /** What is wrong with a set of mods, in a form two sets can be compared by. */
    private static Set<String> signatures(List<ModMetadata.Mod> shared, List<ModMetadata.Mod> candidate, UdmcConfig config) throws IOException {
        List<ModMetadata.Mod> all = new ArrayList<>(shared);
        all.addAll(candidate);
        Set<String> signatures = new HashSet<>();
        for (var problem : ModMetadata.diagnostics(all, "client", config)) {
            signatures.add(problem.detail().key() + " " + problem.detail().args());
        }
        return signatures;
    }

    private static boolean isJar(String path) { return path.startsWith("mods/") && path.toLowerCase(java.util.Locale.ROOT).endsWith(".jar"); }
}
