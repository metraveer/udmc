package dev.udmc.sync;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;

import java.nio.file.Path;

public final class UdmcClientEntrypoint implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        Path gameDir = FabricLoader.getInstance().getGameDir();
        UdmcConfig config = UdmcConfig.load(gameDir);
        config.applyRuntimeEnvironment();
        AgentLoginProtocol.configureClient(config);
        if (!config.clientSyncOnStart) {
            UdmcSync.LOGGER.info("Client sync on start is disabled.");
            return;
        }

        if (config.serverUrl == null || config.serverUrl.isBlank()) {
            UdmcSync.LOGGER.warn("UDMC serverUrl is empty. Edit config/udmc-sync.json.");
            return;
        }

        UdmcClientUi.start(gameDir, config);
    }
}
