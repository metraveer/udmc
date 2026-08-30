package dev.udmc.sync;

import net.neoforged.fml.ModList;
import net.neoforged.fml.loading.FMLLoader;
import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.ZipFile;

final class LoaderPlatform {
    static final String TYPE = "neoforge";
    static final String MOD_ID = "neoforge";
    static String version(String id, String fallback) {
        if (id.equals("@fml")) return FMLLoader.versionInfo().fmlVersion();
        return ModList.get().getModContainerById(id).map(mod -> mod.getModInfo().getVersion().toString()).orElse(fallback);
    }
    static List<ModMetadata.Mod> readMods(Path jar, String display) throws IOException { return NeoForgeMetadata.read(jar, display); }
    static boolean matches(String version, List<String> predicates) throws IOException { return NeoForgeMetadata.matches(version, predicates); }
    static boolean isAgent(ZipFile zip) throws IOException { return NeoForgeMetadata.isAgent(zip); }
    static String validateAgent(ZipFile zip, UdmcConfig config, boolean client) throws IOException { return NeoForgeMetadata.validateAgent(zip, config); }
    static Path agentPath() throws IOException {
        var file = ModList.get().getModFileById(UdmcSync.MOD_ID);
        if (file == null) throw new IOException("Agent is not loaded");
        return file.getFile().getFilePath();
    }
}
