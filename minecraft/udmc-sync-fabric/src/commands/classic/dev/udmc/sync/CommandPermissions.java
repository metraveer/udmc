package dev.udmc.sync;

import net.minecraft.commands.CommandSourceStack;

/** Operator level 4, on the versions that still count permissions as numbers. */
final class CommandPermissions {
    private CommandPermissions() {
    }

    static boolean fullOperator(CommandSourceStack source) {
        return source.hasPermission(4);
    }
}
