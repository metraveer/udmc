package dev.udmc.sync;

import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import net.minecraft.core.registries.BuiltInRegistries;

/**
 * Who has put entries into the game's registries, by namespace.
 *
 * <p>This is the one fact about a server that decides whether a new player can join at all. A
 * client is refused during registry synchronisation - by the game, or by Fabric API before the
 * game - when the server's registries hold entries the client does not know, and it is refused
 * before any mod, this one included, has had a word. So a mod that adds registry entries and is
 * not handed to players locks every new player out, silently, and the panel has to be able to
 * say which one. The loaders' own namespaces are left out: nothing the pack could carry would
 * account for them, and the dependency check already names a library players are missing.
 */
final class RegistryReport {
    private static final Set<String> BUILT_IN = Set.of("minecraft", "fabric", "fabricloader", "neoforge", "forge", UdmcSync.MOD_ID);

    private RegistryReport() {}

    /** Every namespace other than the game's and the loaders', with how many entries it holds. */
    static Map<String, Integer> moddedNamespaces() {
        Map<String, Integer> counts = new TreeMap<>();
        for (var registry : BuiltInRegistries.REGISTRY) {
            for (Object key : registry.keySet()) {
                String id = String.valueOf(key);
                int colon = id.indexOf(':');
                String namespace = colon < 0 ? id : id.substring(0, colon);
                if (!BUILT_IN.contains(namespace)) counts.merge(namespace, 1, Integer::sum);
            }
        }
        return counts;
    }
}
