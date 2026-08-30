package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.network.UdmcAnswerPayload;
import dev.udmc.sync.network.UdmcQueryPayload;
import net.minecraft.client.multiplayer.ClientCommonPacketListenerImpl;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.common.ClientboundCustomPayloadPacket;
import net.minecraft.network.protocol.common.ServerboundCustomPayloadPacket;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Answers the server's question about this client, straight from the network thread. */
@Mixin(value = ClientCommonPacketListenerImpl.class, priority = 1500)
public abstract class ClientPayloadMixin {
    @Shadow @Final protected Connection connection;

    @Inject(method = "handleCustomPayload(Lnet/minecraft/network/protocol/common/ClientboundCustomPayloadPacket;)V",
        at = @At("HEAD"), cancellable = true)
    private void udmc$question(ClientboundCustomPayloadPacket packet, CallbackInfo callback) {
        if (!(packet.payload() instanceof UdmcQueryPayload payload)) return;
        AgentLoginProtocol.Answer answer = AgentLoginProtocol.answer(payload.query());
        // A client of another project answers too, naming that project: silence used to be
        // read by the server as "no mod installed", which is the one thing it cannot know.
        if (answer != null) connection.send(new ServerboundCustomPayloadPacket(new UdmcAnswerPayload(answer)));
        callback.cancel();
    }
}
