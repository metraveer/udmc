package dev.udmc.sync.mixin;

import dev.udmc.sync.UdmcServerEntrypoint;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(DedicatedServer.class)
public abstract class DedicatedServerMixin {
    @Inject(method = "initServer", at = @At("RETURN"))
    private void udmcSync$attachServer(CallbackInfoReturnable<Boolean> callback) {
        if (callback.getReturnValueZ()) {
            UdmcServerEntrypoint.attachServer((MinecraftServer) (Object) this);
        }
    }
}
