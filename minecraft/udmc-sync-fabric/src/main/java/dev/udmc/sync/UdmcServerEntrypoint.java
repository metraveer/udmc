package dev.udmc.sync;

import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;

import java.nio.file.Path;

public final class UdmcServerEntrypoint implements DedicatedServerModInitializer {
    private static UdmcHttpApi api;
    private static Path gameDir;
    private static UdmcConfig config;

    @Override
    public void onInitializeServer() {
        Path directory = FabricLoader.getInstance().getGameDir();
        UdmcConfig settings = UdmcConfig.load(directory);
        settings.applyRuntimeEnvironment();
        prepare(directory, settings);
    }

    static void prepare(Path directory, UdmcConfig settings) {
        if (api != null) throw new IllegalStateException("UDMC API is already running");
        gameDir = directory;
        config = settings;
        if ("client".equals(config.role)) {
            throw new IllegalStateException("Install the UDMC server JAR on the server.");
        }
        config.save(gameDir);
    }

    public static void attachServer(MinecraftServer server) {
        if (api != null) throw new IllegalStateException("UDMC API is already running");
        try {
            ManifestStore store = new ManifestStore(gameDir, config);
            store.syncRuntimeMetadata();
            api = new UdmcHttpApi(gameDir, config, store);
            api.start();
            api.attachServer(server);
        } catch (Exception error) {
            stopServer();
            throw new IllegalStateException("Failed to start UDMC server API", error);
        }
    }

    public static void stopServer() {
        if (api != null) api.stop();
        api = null;
    }
}
