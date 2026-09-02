package dev.udmc.sync.mixin;

import dev.udmc.sync.network.UdmcAnswerPayload;
import dev.udmc.sync.network.UdmcProjectPayload;
import dev.udmc.sync.network.UdmcQueryPayload;
import dev.udmc.sync.network.UdmcRegisterPayload;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.DiscardedPayload;
import net.minecraft.resources.Identifier;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Teaches the game to read and write UDMC's configuration payloads. Everything the game
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
        else if (UdmcProjectPayload.ID.equals(id)) callback.setReturnValue(UdmcProjectPayload.CODEC);
        // The game's own channel registration, for the one client that has nobody else to read
        // it: with a networking library installed, the library's codec is found before this
        // fallback is asked, so this line is reached only where that library is absent.
        else if (UdmcRegisterPayload.ID.equals(id)) callback.setReturnValue(UdmcRegisterPayload.CODEC);
    }
}
