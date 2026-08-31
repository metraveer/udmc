package dev.udmc.sync;

import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.server.ServerAboutToStartEvent;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppedEvent;

@Mod(UdmcSync.MOD_ID)
public final class NeoForgeEntrypoint {
    private UdmcHttpApi api;

    public NeoForgeEntrypoint(IEventBus modBus) {
        UdmcSync.LOGGER.info("UDMC loaded (NeoForge).");
        // Both sides declare the same channels or NeoForge refuses the connection before the
        // check can explain itself, so this is registered regardless of which JAR is running.
        NeoForgeVerification.register(modBus);
        // The client adapter must never be resolved on a dedicated server.
        if (FMLEnvironment.dist == Dist.CLIENT) {
            NeoForgeClient.register(modBus);
        } else {
            NeoForge.EVENT_BUS.addListener(this::commands);
            NeoForge.EVENT_BUS.addListener(this::starting);
            NeoForge.EVENT_BUS.addListener(this::started);
            NeoForge.EVENT_BUS.addListener(this::stopped);
        }
    }

    private void starting(ServerAboutToStartEvent event) {
        var gameDir = FMLPaths.GAMEDIR.get();
        UdmcConfig config = UdmcConfig.load(gameDir);
        config.applyRuntimeEnvironment();
        ServerIdentity.ensure(gameDir, config);
        UdmcCommand.bind(gameDir, config);
        config.save(gameDir);
        try {
            ManifestStore store = new ManifestStore(gameDir, config);
            store.syncRuntimeMetadata();
            api = new UdmcHttpApi(gameDir, config, store);
            api.start();
        } catch (Exception e) {
            if (api != null) api.stop();
            api = null;
            throw new IllegalStateException("Cannot start UDMC server API", e);
        }
    }

    // NeoForge raises this whenever the command tree is built, including after /reload.
    private void commands(RegisterCommandsEvent event) { UdmcCommand.register(event.getDispatcher()); }

    private void started(ServerStartedEvent event) { if (api != null) api.attachServer(event.getServer()); }
    private void stopped(ServerStoppedEvent event) {
        if (api != null) api.stop();
        api = null;
    }
}
