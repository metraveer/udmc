package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.network.UdmcAnswerPayload;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.common.ServerboundCustomPayloadPacket;
import net.minecraft.network.protocol.common.ServerboundPongPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Takes the player's answer off the wire, and the mark that says no answer is coming. An
 * explicit priority rather than load order: this lane is shared with every mod that speaks to
 * its own client, and the previous version of this check lost an ordering race it did not know
 * it was in.
 */
@Mixin(value = ServerCommonPacketListenerImpl.class, priority = 1500)
public abstract class ServerPayloadMixin {
    @Shadow @Final protected Connection connection;
    @Shadow @Final protected MinecraftServer server;

    @Inject(method = "handleCustomPayload", at = @At("HEAD"), cancellable = true)
    private void udmc$answer(ServerboundCustomPayloadPacket packet, CallbackInfo callback) {
        if (!(packet.payload() instanceof UdmcAnswerPayload payload)) return;
        AgentLoginProtocol.receive(connection, payload.answer());
        callback.cancel();
    }

    /**
     * The end of the wait. The game answers a ping in every phase, so this arrives from every
     * client - and because it was sent after the question, anything the client had to say is
     * already here. A player without UDMC is judged by the same packet as one with it, at the
     * same moment, with no timeout between them.
     *
     * <p>Handed to the server thread: the verdict sends packets and may end the connection,
     * and the game does neither from the network thread.
     */
    @Inject(method = "handlePong", at = @At("HEAD"))
    private void udmc$settle(ServerboundPongPacket packet, CallbackInfo callback) {
        if (packet.getId() != AgentLoginProtocol.PING || !AgentLoginProtocol.awaiting(connection)) return;
        server.execute(() -> AgentLoginProtocol.settle(connection));
    }
}
