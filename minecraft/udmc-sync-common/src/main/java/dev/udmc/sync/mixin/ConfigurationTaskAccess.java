package dev.udmc.sync.mixin;

import java.util.Queue;
import net.minecraft.server.network.ConfigurationTask;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

/**
 * The two things a check of ours needs from the listener running it, neither of which the game
 * exposes: where the tasks queue, and how to say "done, carry on".
 *
 * <p>An accessor rather than a shadow inside the check itself, so the task stays an ordinary
 * class that can be read and reasoned about without knowing what mixin does.
 */
@Mixin(ServerConfigurationPacketListenerImpl.class)
public interface ConfigurationTaskAccess {
    /**
     * The queue the phase is served from, in order. Ours is added before the game adds its
     * own, which is what puts the UDMC question ahead of registries and everything after them.
     */
    @Accessor("configurationTasks") Queue<ConfigurationTask> udmc$tasks();

    /** Hands the phase on to the next task - registries among them. */
    @Invoker("finishCurrentTask") void udmc$finishTask(ConfigurationTask.Type type);
}
