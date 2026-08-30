package dev.udmc.sync;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;

/** Loader adapters inspect metadata only; no downloaded classes are executed. */
final class ModMetadata {
    record Problem(Messages.Message detail, List<String> paths) {
        Problem { paths = List.copyOf(paths); }
    }
    record Dependency(String id, List<String> versions, String side, String type) {}
    record Mod(String path, String id, String version, String environment, boolean nested,
               List<String> provides, List<Dependency> dependencies) {
        Mod(String path, String id, String version, String environment, boolean nested, List<String> provides,
            Map<String, List<String>> depends, Map<String, List<String>> breaks) {
            this(path, id, version, environment, nested, provides, fabricDependencies(depends, breaks));
        }
    }

    private static List<Dependency> fabricDependencies(Map<String, List<String>> depends, Map<String, List<String>> breaks) {
        List<Dependency> result = new ArrayList<>();
        depends.forEach((id, versions) -> result.add(new Dependency(id, versions, "*", "required")));
        breaks.forEach((id, versions) -> result.add(new Dependency(id, versions, "*", "incompatible")));
        return List.copyOf(result);
    }

    static List<Mod> read(Path jar, String display) throws IOException { return LoaderPlatform.readMods(jar, display); }
    static boolean matches(String version, List<String> predicates) throws IOException { return LoaderPlatform.matches(version, predicates); }

    static List<String> problems(List<Mod> all, String side, UdmcConfig config) throws IOException {
        return diagnostics(all, side, config).stream().map(problem -> problem.detail.english()).toList();
    }

    static List<Problem> diagnostics(List<Mod> all, String side, UdmcConfig config) throws IOException {
        Map<String, List<Mod>> byId = new HashMap<>();
        List<Mod> mods = all.stream().filter(m -> m.environment.equals("*") || m.environment.equals(side)).toList();
        List<Problem> problems = new ArrayList<>();
        for (Mod mod : mods) {
            byId.computeIfAbsent(mod.id, k -> new ArrayList<>()).add(mod);
            for (String alias : mod.provides) byId.computeIfAbsent(alias, k -> new ArrayList<>()).add(mod);
        }
        Map<String, String> builtins = new HashMap<>(Map.of("minecraft", config.minecraftVersion, LoaderPlatform.MOD_ID, config.loaderVersion,
            "java", String.valueOf(Runtime.version().feature()), "@fml", config.languageLoaderVersion));
        // An explicit pack version takes precedence over the agent's bundled resource modules.
        PlatformDefaults.bundledMods().forEach((id, version) -> { if (!byId.containsKey(id)) builtins.put(id, version); });
        for (var entry : byId.entrySet()) {
            long roots = entry.getValue().stream().filter(m -> !m.nested).map(Mod::path).distinct().count();
            var paths = entry.getValue().stream().map(Mod::path).distinct().toList();
            if (roots > 1) problems.add(new Problem(Messages.of("udmc_sync.diagnostic.duplicate", entry.getKey(), paths), paths));
            if (config.loaderType.equals("neoforge") && !entry.getKey().startsWith("@")
                && entry.getValue().stream().anyMatch(Mod::nested)
                && entry.getValue().stream().map(Mod::version).distinct().count() > 1) {
                problems.add(new Problem(Messages.of("udmc_sync.diagnostic.nested_versions", entry.getKey(), entry.getValue().stream().map(m -> m.path + " (" + m.version + ")").distinct().toList()), paths));
            }
            if (entry.getKey().startsWith("@jar:")) {
                boolean resolvable = false;
                for (Mod candidate : entry.getValue()) {
                    boolean satisfiesAll = true;
                    for (Mod supplier : entry.getValue()) for (Dependency dep : supplier.dependencies) {
                        if (dep.type.equals("embedded") && !matches(candidate.version, dep.versions)) satisfiesAll = false;
                    }
                    if (satisfiesAll) resolvable = true;
                }
                if (!resolvable) problems.add(new Problem(Messages.of("udmc_sync.diagnostic.embedded", entry.getKey(), paths), paths));
            }
        }
        Map<String, Set<String>> ordering = new HashMap<>();
        byId.keySet().forEach(id -> ordering.put(id, new HashSet<>()));
        for (Mod mod : mods) for (Dependency dep : mod.dependencies) {
            if (!dep.side.equals("*") && !dep.side.equals(side)) continue;
            List<Mod> candidates = byId.getOrDefault(dep.id, List.of()).stream().filter(m -> m != mod).toList();
            boolean present = builtins.containsKey(dep.id) || !candidates.isEmpty();
            if (byId.containsKey(dep.id) && dep.type.equals("before")) ordering.get(mod.id).add(dep.id);
            if (byId.containsKey(dep.id) && dep.type.equals("after")) ordering.get(dep.id).add(mod.id);
            boolean found = builtins.containsKey(dep.id) && matches(builtins.get(dep.id), dep.versions);
            for (Mod candidate : candidates) if (matches(candidate.version, dep.versions)) found = true;
            if (dep.type.equals("required") && !found || dep.type.equals("optional") && present && !found) {
                var message = dep.type.equals("required")
                    ? Messages.of("udmc_sync.diagnostic.required", mod.path, mod.id, dep.id, dep.versions)
                    : Messages.of("udmc_sync.diagnostic.optional", mod.path, mod.id, dep.id, dep.versions);
                problems.add(new Problem(message, List.of(mod.path)));
            } else if (dep.type.equals("incompatible") && found) {
                problems.add(new Problem(Messages.of("udmc_sync.diagnostic.incompatible", mod.path, dep.id, candidates.stream().map(Mod::path).distinct().toList()), List.of(mod.path)));
            }
        }
        Set<String> pending = new HashSet<>(ordering.keySet());
        while (!pending.isEmpty()) {
            var leaves = pending.stream().filter(id -> ordering.get(id).stream().noneMatch(pending::contains)).toList();
            if (leaves.isEmpty()) {
                problems.add(new Problem(Messages.of("udmc_sync.diagnostic.cycle", pending.stream().sorted().toList()),
                    mods.stream().filter(mod -> pending.contains(mod.id)).map(Mod::path).distinct().toList()));
                break;
            }
            pending.removeAll(leaves);
        }
        return problems.stream().distinct().toList();
    }
}
