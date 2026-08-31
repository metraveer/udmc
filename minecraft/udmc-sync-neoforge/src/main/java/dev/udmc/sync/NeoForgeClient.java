package dev.udmc.sync;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.event.lifecycle.FMLClientSetupEvent;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.common.NeoForge;

final class NeoForgeClient {
    static void register(IEventBus modBus) {
        modBus.addListener(NeoForgeClient::setup);
        NeoForge.EVENT_BUS.addListener(NeoForgeClient::tick);
    }
    private static void setup(FMLClientSetupEvent event) {
        event.enqueueWork(() -> {
            var directory = FMLPaths.GAMEDIR.get();
            UdmcConfig config = UdmcConfig.load(directory);
            config.applyRuntimeEnvironment();
            AgentLoginProtocol.configureClient(config);
            if (config.clientSyncOnStart && config.serverUrl != null && !config.serverUrl.isBlank()) UdmcClientUi.start(directory, config);
        });
    }
    private static void tick(ClientTickEvent.Post event) { UdmcClientUi.tick(); }
}
