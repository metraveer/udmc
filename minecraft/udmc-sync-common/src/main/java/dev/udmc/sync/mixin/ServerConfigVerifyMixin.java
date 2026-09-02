package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.AgentLoginVerification;
import net.minecraft.network.Connection;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ConfigurationTask;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import java.util.Queue;

/**
 * Puts the UDMC check at the front of the configuration phase.
 *
 * <p>The queue is served in order, and this is the first thing ever put into it: the listener's
 * own constructor, before the game or any other mod has had a chance to add a task of theirs.
 * So ours runs first and everything else - registries, resource pack, joining the world - waits
 * behind it. That is deliberate and it is the fix for the worst bug this project has had: a
 * player who does not yet have the server's mods is thrown out by the game's own registry check,
 * and if that happens before UDMC has spoken they can never accept the project, never receive
 * the pack, and so never stop being thrown out. Whatever the server runs, the first connection
 * is one question.
 *
 * <p>The constructor rather than {@code startConfiguration}: Fabric API also hooks the head of
 * that method, cancels it while it waits for the client to register its channels, and drains the
 * queue itself before letting the game continue - so a task added at that head is in the queue
 * before or after Fabric's registry sync depending on which mixin's callback happens to run
 * first. A task added at construction is in the queue before either of them looks at it, and
 * nothing about that depends on a priority number.
 *
 * <p>The phase itself is a good place for the question for a second reason: the login phase has
 * no room for it - the game disconnects on an unexpected packet there - so Fabric API claims
 * that channel whole, and a check placed there is decided by mixin ordering rather than by code.
 *
 * <p>Declared as a subclass of the listener's own parent so that connection and server are
 * inherited: {@code @Shadow} cannot reach a member the target only inherits.
 */
@Mixin(value = ServerConfigurationPacketListenerImpl.class, priority = 1500)
public abstract class ServerConfigVerifyMixin extends ServerCommonPacketListenerImpl {
    private ServerConfigVerifyMixin(MinecraftServer server, Connection connection, CommonListenerCookie cookie) {
        super(server, connection, cookie);
    }

    @Unique private volatile AgentLoginVerification udmc$verification;

    @Inject(method = "<init>", at = @At("RETURN"))
    private void udmc$ask(CallbackInfo callback) {
        if (!AgentLoginProtocol.enabled()) return;
        udmc$verification = new AgentLoginVerification((ServerConfigurationPacketListenerImpl) (Object) this, this.connection);
        Queue<ConfigurationTask> tasks = ((ConfigurationTaskAccess) this).udmc$tasks();
        tasks.add(udmc$verification);
    }

    /**
     * The backstop for a client that never answers the ping. Nothing that speaks the game's
     * protocol ends up here; something that pretends to would otherwise hold the phase until
     * the keep-alive gave up on it, and be told "timed out" instead of what was actually wrong.
     */
    @Inject(method = "tick", at = @At("HEAD"))
    private void udmc$patience(CallbackInfo callback) {
        AgentLoginVerification verification = udmc$verification;
        if (verification != null && verification.expired()) AgentLoginProtocol.settle(this.connection);
    }
}
