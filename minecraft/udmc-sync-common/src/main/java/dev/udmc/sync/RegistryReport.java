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
 * say which one. The game's and the loaders' own namespaces are left out: nothing the pack could
 * carry would account for them, and the dependency check already names a library players are
 * missing.
 *
 * <p>What comes out is an inference, not a fact about players: a mod may put its entries into a
 * registry the library treats as optional, and a namespace this class does not know may be the
 * game's own. So the panel shows it as a warning that never refuses a publication - the one
 * time it did, over {@code brigadier}, an owner could not publish anything at all.
 */
final class RegistryReport {
    // The game's own: "minecraft", and "brigadier" for the six command argument types the game
    // registers under the parser's name. Then the loaders'. A namespace missing from this list
    // is reported to the owner as a mod's - and reported wrongly, if it is the game's, which is
    // why the report is a warning and never a refusal, and why a bare game must report nothing
    // (checked by AgentUpdateTest on every Fabric build).
    private static final Set<String> BUILT_IN = Set.of("minecraft", "brigadier", "fabric", "fabricloader", "neoforge", "forge", UdmcSync.MOD_ID);

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
