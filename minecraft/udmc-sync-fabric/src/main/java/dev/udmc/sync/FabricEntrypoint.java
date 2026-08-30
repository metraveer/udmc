package dev.udmc.sync;

import net.fabricmc.api.ModInitializer;

public final class FabricEntrypoint implements ModInitializer {
    @Override public void onInitialize() { UdmcSync.LOGGER.info("UDMC Sync loaded (Fabric)."); }
}
