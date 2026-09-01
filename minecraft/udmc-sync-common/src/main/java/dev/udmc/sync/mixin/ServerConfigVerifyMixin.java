package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginNotice;
import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.UdmcSync;
import dev.udmc.sync.network.UdmcProjectPayload;
import dev.udmc.sync.network.UdmcQueryPayload;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.common.ClientboundCustomPayloadPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Asks the joining player about their UDMC client and reaches a verdict before they enter the
 * world. This lives in the configuration phase on purpose: the login phase has no room for a
 * question like this - the game disconnects on an unexpected one - so Fabric API claims that
 * channel whole, and a check placed there is decided by mixin ordering rather than by code.
 * Here nothing is cancelled and nothing is raced; the question is one payload among many.
 *
 * <p>Declared as a subclass of the listener's own parent so that send, disconnect, server and
 * connection are inherited: {@code @Shadow} cannot reach a member the target only inherits.
 */
@Mixin(ServerConfigurationPacketListenerImpl.class)
public abstract class ServerConfigVerifyMixin extends ServerCommonPacketListenerImpl {
    private ServerConfigVerifyMixin(MinecraftServer server, Connection connection, CommonListenerCookie cookie) {
        super(server, connection, cookie);
    }

    @Unique private volatile boolean udmc$asked;
    @Unique private volatile boolean udmc$decided;
    @Unique private int udmc$waited;

    @Inject(method = "startConfiguration", at = @At("HEAD"))
    private void udmc$ask(CallbackInfo callback) {
        if (!AgentLoginProtocol.enabled() || udmc$asked) return;
        udmc$asked = true;
        AgentLoginProtocol.asked(this.connection);
        // The project first, so a client that has never seen this server knows who is asking
        // before it answers. Clients from before this channel existed discard it and go on.
        var project = AgentLoginProtocol.project();
        if (project != null) send(new ClientboundCustomPayloadPacket(new UdmcProjectPayload(project)));
        send(new ClientboundCustomPayloadPacket(new UdmcQueryPayload(AgentLoginProtocol.query())));
    }

    // Two moments are safe to speak at, and this is the first: while the player is still in
    // the configuration phase, where a disconnect packet is encoded the way they decode it.
    // Deciding when they announce the phase is over is not - by then they have switched to
    // the play protocol and the reason arrives unreadable, leaving a bare "Disconnected".
    @Inject(method = "tick", at = @At("HEAD"))
    private void udmc$check(CallbackInfo callback) {
        if (!udmc$asked || udmc$decided) return;
        boolean late = ++udmc$waited >= AgentLoginProtocol.DEADLINE_TICKS;
        if (AgentLoginProtocol.answered(this.connection) || late) udmc$verdict();
    }

    /** Returns whether the player was turned away. */
    @Unique private boolean udmc$verdict() {
        udmc$decided = true;
        AgentLoginProtocol.pending(this.connection);
        AgentLoginProtocol.Decision decision = AgentLoginProtocol.announce(String.valueOf(this.connection.getRemoteAddress()),
            AgentLoginProtocol.validate(AgentLoginProtocol.takeAnswer(this.connection)));
        if (decision.valid()) return false;
        if (!decision.reject()) {
            // The notice reaches the player once they are in, where they can read and act on it.
            AgentLoginProtocol.warn(this.connection, decision);
            return false;
        }
        disconnect(AgentLoginNotice.component(decision));
        return true;
    }
}
