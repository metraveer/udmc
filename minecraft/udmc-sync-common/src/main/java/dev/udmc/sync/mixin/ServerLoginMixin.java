package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.AgentLoginNotice;
import dev.udmc.sync.network.UdmcQueryPayload;
import dev.udmc.sync.network.UdmcAnswerPayload;
import net.minecraft.network.Connection;
import net.minecraft.network.chat.Component;
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
    @Shadow public abstract void disconnect(Component reason);
    @Unique private volatile boolean udmc$sent;
    @Unique private volatile boolean udmc$answered;
    @Unique private volatile AgentLoginProtocol.Answer udmc$answer;
    @Unique private int udmc$waited;
    @Unique private boolean udmc$finished;
    @Unique private boolean udmc$rejected;

    @Inject(method = "verifyLoginAndFinishConnectionSetup", at = @At("HEAD"), cancellable = true)
    private void udmc$verify(CallbackInfo callback) {
        if (!AgentLoginProtocol.enabled()) return;
        if (udmc$rejected) { callback.cancel(); return; }
        if (udmc$finished) return;
        if (!udmc$sent) {
            udmc$sent = true;
            connection.send(new ClientboundCustomQueryPacket(AgentLoginProtocol.TRANSACTION_ID, new UdmcQueryPayload(AgentLoginProtocol.query())));
            callback.cancel();
            return;
        }
        if (!udmc$answered && ++udmc$waited < 200) {
            callback.cancel();
            return;
        }
        AgentLoginProtocol.Decision decision = AgentLoginProtocol.validate(udmc$answer);
        udmc$finished = true;
        if (!decision.valid()) {
            if (decision.reject()) {
                udmc$rejected = true;
                disconnect(AgentLoginNotice.component(decision));
                callback.cancel();
            } else {
                AgentLoginProtocol.warn(connection, decision);
            }
        }
    }

    @Inject(method = "handleCustomQueryPacket", at = @At("HEAD"), cancellable = true)
    private void udmc$answer(ServerboundCustomQueryAnswerPacket packet, CallbackInfo callback) {
        if (packet.transactionId() != AgentLoginProtocol.TRANSACTION_ID) return;
        if (packet.payload() instanceof UdmcAnswerPayload answer) udmc$answer = answer.answer();
        udmc$answered = true;
        callback.cancel();
    }
}
