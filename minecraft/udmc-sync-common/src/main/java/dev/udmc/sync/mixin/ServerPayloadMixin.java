package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.network.UdmcAnswerPayload;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.common.ServerboundCustomPayloadPacket;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Takes the player's answer off the wire. An explicit priority rather than load order: this
 * lane is shared with every mod that speaks to its own client, and the previous version of
 * this check lost an ordering race it did not know it was in.
 */
@Mixin(value = ServerCommonPacketListenerImpl.class, priority = 1500)
public abstract class ServerPayloadMixin {
    @Shadow @Final protected Connection connection;

    @Inject(method = "handleCustomPayload", at = @At("HEAD"), cancellable = true)
    private void udmc$answer(ServerboundCustomPayloadPacket packet, CallbackInfo callback) {
        if (!(packet.payload() instanceof UdmcAnswerPayload payload)) return;
        AgentLoginProtocol.receive(connection, payload.answer());
        callback.cancel();
    }
}
