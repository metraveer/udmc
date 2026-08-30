package dev.udmc.sync;

import net.fabricmc.loader.api.FabricLoader;
import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.ZipFile;

final class LoaderPlatform {
    static final String TYPE = "fabric";
    static final String MOD_ID = "fabricloader";
    static String version(String id, String fallback) {
        return FabricLoader.getInstance().getModContainer(id)
            .map(mod -> mod.getMetadata().getVersion().getFriendlyString()).orElse(fallback);
    }
    static List<ModMetadata.Mod> readMods(Path jar, String display) throws IOException { return FabricMetadata.read(jar, display); }
    static boolean matches(String version, List<String> predicates) throws IOException { return FabricMetadata.matches(version, predicates); }
    static boolean isAgent(ZipFile zip) throws IOException { return FabricMetadata.isAgent(zip); }
    static String validateAgent(ZipFile zip, UdmcConfig config, boolean client) throws IOException { return FabricMetadata.validateAgent(zip, config, client); }
    static Path agentPath() throws IOException {
        var paths = FabricLoader.getInstance().getModContainer(UdmcSync.MOD_ID).orElseThrow(() -> new IOException("Agent is not loaded"))
            .getOrigin().getPaths();
        if (paths.size() != 1) throw new IOException("Remote update requires a packaged agent JAR");
        return paths.getFirst();
    }
}
