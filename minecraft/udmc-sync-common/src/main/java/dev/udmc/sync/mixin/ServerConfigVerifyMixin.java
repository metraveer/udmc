package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
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
 * Asks the joining player about their UDMC client. This lives in the configuration phase on
 * purpose: the login phase has no room for a question like this - the game disconnects on an
 * unexpected one - so Fabric API claims that channel whole, and a check placed there is decided
 * by mixin ordering rather than by code. Here nothing is cancelled and nothing is raced; the
 * question is one payload among many.
 *
 * <p><b>Asking happens here; refusing does not.</b> The verdict used to be reached on a tick
 * while the player was still in this phase, and on a real client that lost the explanation: the
 * disconnect is sent in the middle of the registry burst that follows the question, the client
 * never processes it, and the player is left looking at a bare "Disconnected". Measured on the
 * stand, both ways, on Minecraft 1.21.1 - the same refusal shown from the play phase arrives
 * whole, in the player's own language, with the installation buttons on it.
 *
 * <p>So the answer is only recorded here and {@link dev.udmc.sync.mixin.PlayerListMixin} decides.
 * The cost is honest and small: a refused player is placed for the part of a tick it takes to
 * disconnect them, so the server log and the chat show them joining and leaving. Being told why
 * is worth more than being spared two lines. A refusal screen of our own, sent as a payload
 * before the disconnect, would cost neither - see docs/client-verification.md.
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
}
