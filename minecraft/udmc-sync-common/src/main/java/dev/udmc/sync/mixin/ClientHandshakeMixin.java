package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.UdmcSync;
import dev.udmc.sync.network.UdmcQueryPayload;
import dev.udmc.sync.network.UdmcAnswerPayload;
import io.netty.buffer.Unpooled;
import net.minecraft.client.multiplayer.ClientHandshakePacketListenerImpl;
import net.minecraft.network.Connection;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.login.ClientboundCustomQueryPacket;
import net.minecraft.network.protocol.login.ServerboundCustomQueryAnswerPacket;
import net.minecraft.network.protocol.login.custom.CustomQueryPayload;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

// Fabric API answers every login channel itself and cancels the vanilla call, so the
// order of injected handlers decides who is heard. A lower number is applied first:
// UDMC has to read its own question before anyone answers "channel not understood".
@Mixin(value = ClientHandshakePacketListenerImpl.class, priority = 500)
public abstract class ClientHandshakeMixin {
    @Shadow @Final private Connection connection;

    @Inject(method = "handleCustomQuery", at = @At("HEAD"), cancellable = true)
    private void udmc$handle(ClientboundCustomQueryPacket packet, CallbackInfo callback) {
        CustomQueryPayload payload = packet.payload();
        if (payload == null || !UdmcQueryPayload.ID.equals(payload.id())) return;
        // Another mod may have decoded this packet into its own wrapper before us: Fabric API
        // replaces the payload of every login channel with one of its own. Any payload can
        // write itself back, so the question is read from the bytes instead of from whichever
        // class happens to hold them - matching on our own type left the server without an
        // answer, and it could only report that as a missing mod.
        AgentLoginProtocol.Query query;
        FriendlyByteBuf buffer = new FriendlyByteBuf(Unpooled.buffer());
        try {
            payload.write(buffer);
            query = new UdmcQueryPayload(buffer).query();
        } catch (RuntimeException error) {
            UdmcSync.LOGGER.warn("Cannot read the UDMC login question", error);
            return;
        } finally {
            buffer.release();
        }
        AgentLoginProtocol.Answer answer = AgentLoginProtocol.answer(query);
        connection.send(new ServerboundCustomQueryAnswerPacket(packet.transactionId(), answer == null ? null : new UdmcAnswerPayload(answer)));
        callback.cancel();
    }
}
