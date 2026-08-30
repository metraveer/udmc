package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.network.UdmcAnswerPayload;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.login.ServerboundCustomQueryAnswerPacket;
import net.minecraft.network.protocol.login.custom.CustomQueryAnswerPayload;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

// Fabric API answers every login channel itself and cancels the vanilla call, so the
// order of injected handlers decides who is heard. A lower number is applied first:
// UDMC has to read its own question before anyone answers "channel not understood".
@Mixin(value = ServerboundCustomQueryAnswerPacket.class, priority = 500)
public abstract class ServerAnswerDecoderMixin {
    @Inject(method = "readPayload", at = @At("HEAD"), cancellable = true)
    private static void udmc$read(int transaction, FriendlyByteBuf input, CallbackInfoReturnable<CustomQueryAnswerPayload> callback) {
        if (transaction != AgentLoginProtocol.TRANSACTION_ID) return;
        callback.setReturnValue(input.readBoolean() ? new UdmcAnswerPayload(input) : null);
    }
}
