package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.UdmcSync;
import io.netty.buffer.Unpooled;
import dev.udmc.sync.network.UdmcQueryPayload;
import dev.udmc.sync.network.UdmcAnswerPayload;
import net.minecraft.network.Connection;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.login.ClientboundCustomQueryPacket;
import net.minecraft.network.protocol.login.ServerboundCustomQueryAnswerPacket;
import net.minecraft.server.network.ServerLoginPacketListenerImpl;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ServerLoginPacketListenerImpl.class)
public abstract class ServerLoginMixin {
    @Shadow @Final private Connection connection;
    @Unique private volatile boolean udmc$sent;

    @Inject(method = "verifyLoginAndFinishConnectionSetup", at = @At("HEAD"))
    private void udmc$ask(CallbackInfo callback) {
        if (!AgentLoginProtocol.enabled() || udmc$sent) return;
        // Ask once and step aside. The previous version cancelled this call and waited to be
        // called again, which meant UDMC had to win an ordering race against every mod that
        // touches login - with Fabric API installed the call never came back and the player
        // hung until the server's own timeout.
        udmc$sent = true;
        connection.send(new ClientboundCustomQueryPacket(AgentLoginProtocol.TRANSACTION_ID, new UdmcQueryPayload(AgentLoginProtocol.query())));
    }

    @Inject(method = "handleCustomQueryPacket", at = @At("HEAD"), cancellable = true)
    private void udmc$answer(ServerboundCustomQueryAnswerPacket packet, CallbackInfo callback) {
        if (packet.transactionId() != AgentLoginProtocol.TRANSACTION_ID) return;
        // The answer is read from its bytes, not from a class: another mod may have decoded
        // it into its own wrapper first, and Fabric API does exactly that for every login
        // channel. Matching on our own type made every such answer look like silence.
        var payload = packet.payload();
        AgentLoginProtocol.Answer answer = null;
        if (payload != null) {
            FriendlyByteBuf buffer = new FriendlyByteBuf(Unpooled.buffer());
            try { payload.write(buffer); answer = new UdmcAnswerPayload(buffer).answer(); }
            catch (RuntimeException error) { UdmcSync.LOGGER.warn("Cannot read the UDMC login answer", error); }
            finally { buffer.release(); }
        }
        AgentLoginProtocol.remember(connection, answer);
        callback.cancel();
    }
}
