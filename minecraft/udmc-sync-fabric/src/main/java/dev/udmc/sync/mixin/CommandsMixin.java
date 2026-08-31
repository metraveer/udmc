package dev.udmc.sync.mixin;

import com.mojang.brigadier.CommandDispatcher;
import dev.udmc.sync.UdmcCommand;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Adds {@code /udmc} to the command tree. Fabric API has a callback for this, but the mod does not
 * depend on Fabric API, and a command is purely additive - unlike the login channel this project
 * had to move away from, nothing here can be claimed by another mod first.
 *
 * <p>The constructor is the right place rather than server start: {@code /reload} builds a fresh
 * dispatcher through it, so the command comes back instead of quietly disappearing.
 */
@Mixin(Commands.class)
public abstract class CommandsMixin {
    @Shadow
    @Final
    private CommandDispatcher<CommandSourceStack> dispatcher;

    @Inject(method = "<init>", at = @At("RETURN"))
    private void udmcSync$register(Commands.CommandSelection selection, CommandBuildContext context, CallbackInfo callback) {
        UdmcCommand.register(dispatcher);
    }
}
