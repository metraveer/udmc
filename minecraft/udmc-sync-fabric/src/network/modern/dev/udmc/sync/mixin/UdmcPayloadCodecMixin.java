package dev.udmc.sync.mixin;

import dev.udmc.sync.network.UdmcAnswerPayload;
import dev.udmc.sync.network.UdmcQueryPayload;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.DiscardedPayload;
import net.minecraft.resources.Identifier;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Teaches the game to read and write UDMC's two configuration payloads. Everything the game
 * does not recognise goes through this one factory, so hooking it needs no cooperation from
 * any other mod - Fabric API's own hook on the same path composes instead of taking over,
 * which is exactly what the login-phase channel did not do.
 */
@Mixin(DiscardedPayload.class)
public abstract class UdmcPayloadCodecMixin {
    @Inject(method = "codec", at = @At("HEAD"), cancellable = true)
    private static void udmc$codec(Identifier id, int maxSize, CallbackInfoReturnable<StreamCodec<?, ?>> callback) {
        if (UdmcQueryPayload.ID.equals(id)) callback.setReturnValue(UdmcQueryPayload.CODEC);
        else if (UdmcAnswerPayload.ID.equals(id)) callback.setReturnValue(UdmcAnswerPayload.CODEC);
    }
}
