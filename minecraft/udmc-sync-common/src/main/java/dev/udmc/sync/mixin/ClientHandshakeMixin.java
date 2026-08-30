package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.network.UdmcQueryPayload;
import dev.udmc.sync.network.UdmcAnswerPayload;
import net.minecraft.client.multiplayer.ClientHandshakePacketListenerImpl;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.login.ClientboundCustomQueryPacket;
import net.minecraft.network.protocol.login.ServerboundCustomQueryAnswerPacket;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ClientHandshakePacketListenerImpl.class)
public abstract class ClientHandshakeMixin {
    @Shadow @Final private Connection connection;
    @Inject(method = "handleCustomQuery", at = @At("HEAD"), cancellable = true)
    private void udmc$handle(ClientboundCustomQueryPacket packet, CallbackInfo callback) {
        if (!(packet.payload() instanceof UdmcQueryPayload query)) return;
        AgentLoginProtocol.Answer answer = AgentLoginProtocol.answer(query.query());
        connection.send(new ServerboundCustomQueryAnswerPacket(packet.transactionId(), answer == null ? null : new UdmcAnswerPayload(answer)));
        callback.cancel();
    }
}
