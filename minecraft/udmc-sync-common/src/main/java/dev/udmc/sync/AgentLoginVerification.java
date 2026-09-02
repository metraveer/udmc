package dev.udmc.sync;

import dev.udmc.sync.mixin.ConfigurationTaskAccess;
import dev.udmc.sync.network.UdmcProjectPayload;
import dev.udmc.sync.network.UdmcQueryPayload;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.common.ClientboundCustomPayloadPacket;
import net.minecraft.network.protocol.common.ClientboundPingPacket;
import net.minecraft.server.network.ConfigurationTask;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;

import java.lang.reflect.Method;
import java.util.function.Consumer;

/**
 * The first thing that happens on a connection, and until it is finished the only thing.
 *
 * <p>It is a configuration task, which means the game holds the phase open for it: the question
 * is asked, answered and judged before a single registry entry, resource pack or world-join
 * packet has been sent. That ordering is the whole point, and it was bought at the price of a
 * bug that made the mod useless on exactly the servers it exists for.
 *
 * <p>Before this, the question was sent from the same phase but nothing waited for it, so the
 * game went straight on to synchronising registries. A player joining a server for the first
 * time has none of the server's mods yet - that is what they came to download - so the game
 * refused the registries and closed the connection before UDMC had decided anything. The player
 * could not accept the project, so the pack never arrived, so they still had no mods: a server
 * with any content mod on it could never be joined by anyone new. Holding the phase removes the
 * whole class: whatever the server runs, the first connection is about one question only.
 *
 * <p>The wait costs one round trip, not a timeout. See {@link AgentLoginProtocol#PING}.
 */
public final class AgentLoginVerification implements ConfigurationTask {
    public static final Type TYPE = new Type(UdmcSync.MOD_ID + ":verify");
    /**
     * The backstop, not the mechanism. Every client the game itself can talk to answers a ping,
     * so this expires only for something that is not a Minecraft client at all - and then the
     * phase must go on rather than hang until the keep-alive gives up on it.
     */
    private static final long PATIENCE_MILLIS = 5_000;

    private final ServerConfigurationPacketListenerImpl listener;
    private final Connection connection;
    private volatile long deadline = Long.MAX_VALUE;

    public AgentLoginVerification(ServerConfigurationPacketListenerImpl listener, Connection connection) {
        this.listener = listener;
        this.connection = connection;
    }

    @Override
    public void start(Consumer<Packet<?>> sender) {
        AgentLoginProtocol.asked(connection);
        AgentLoginProtocol.await(connection, this::decide);
        deadline = System.currentTimeMillis() + PATIENCE_MILLIS;
        // The project first, so a client that has never seen this server knows who is asking
        // before it answers. Clients from before this channel existed discard it and go on.
        ClientProject.Offer project = AgentLoginProtocol.project();
        if (project != null) sender.accept(new ClientboundCustomPayloadPacket(new UdmcProjectPayload(project)));
        sender.accept(new ClientboundCustomPayloadPacket(new UdmcQueryPayload(AgentLoginProtocol.query())));
        // Last, and the reason the wait ends without a timeout: whatever the client had to say
        // is on the wire ahead of the answer to this.
        sender.accept(new ClientboundPingPacket(AgentLoginProtocol.PING));
    }

    /** Whether the client has run out of the one round trip it was given. */
    public boolean expired() { return System.currentTimeMillis() > deadline; }

    /**
     * Reached on the server thread, with nothing yet sent that could bury it: a refusal here is
     * the next thing the client processes, so it arrives whole and reads in the player's own
     * language. Sent later - into the registry burst - it used to be lost, and the player was
     * left looking at a bare "Disconnected". Measured both ways; see docs/client-verification.md.
     */
    private void decide() {
        deadline = Long.MAX_VALUE;
        AgentLoginProtocol.pending(connection);
        AgentLoginProtocol.Decision decision = AgentLoginProtocol.announce(who(),
            AgentLoginProtocol.validate(AgentLoginProtocol.takeAnswer(connection)));
        if (decision.reject()) {
            listener.disconnect(AgentLoginNotice.component(decision));
            return;
        }
        // The notice waits for the player to be in the world, where they can read and act on it.
        if (!decision.valid()) AgentLoginProtocol.warn(connection, decision);
        finish();
    }

    /**
     * Hands the phase on - through Fabric API when it is there, through the game when it is not.
     *
     * <p>Fabric API runs the tasks queued before the game's own in a loop of its own: it starts
     * one, cancels the game's {@code startConfiguration}, and re-enters it when the task reports
     * back through {@code completeTask}. The game's {@code finishCurrentTask} does not re-enter
     * anything; it polls the queue, and when ours was the last task there it finds it empty and
     * stops - the phase hangs until the keep-alive gives up on the player. So when the listener
     * speaks Fabric's interface, the task reports through it, exactly as a task of a mod built
     * on Fabric API would. Found by name, because this mod carries no dependency on it.
     */
    private void finish() {
        Method complete = fabricCompleteTask(listener);
        if (complete != null) {
            try { complete.invoke(listener, TYPE); return; }
            catch (ReflectiveOperationException | RuntimeException error) {
                UdmcSync.LOGGER.warn("Fabric API refused to take the finished UDMC check; finishing it through the game", error);
            }
        }
        ((ConfigurationTaskAccess) listener).udmc$finishTask(TYPE);
    }

    private static final String FABRIC_HANDLER = "net.fabricmc.fabric.api.networking.v1.FabricServerConfigurationNetworkHandler";
    private static volatile Method fabricComplete;
    private static volatile boolean fabricLookedUp;

    static Method fabricCompleteTask(Object listener) {
        if (!fabricLookedUp) {
            try {
                Class<?> handler = Class.forName(FABRIC_HANDLER, false, listener.getClass().getClassLoader());
                fabricComplete = handler.getMethod("completeTask", Type.class);
            } catch (ClassNotFoundException | NoSuchMethodException absent) {
                fabricComplete = null;
            }
            fabricLookedUp = true;
        }
        Method complete = fabricComplete;
        return complete != null && complete.getDeclaringClass().isInstance(listener) ? complete : null;
    }

    /**
     * Named by address, the way the same verdict is named on NeoForge. The player has no name
     * here that both supported game versions spell the same way, and the game's own "lost
     * connection" line follows this one carrying both - so the address is what joins them.
     */
    private String who() { return String.valueOf(connection.getRemoteAddress()); }

    @Override public Type type() { return TYPE; }
}
