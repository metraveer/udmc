package dev.udmc.sync;

import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.permissions.Permissions;

/** The same level after Minecraft replaced numeric permission levels with named ones. */
final class CommandPermissions {
    private CommandPermissions() {
    }

    static boolean fullOperator(CommandSourceStack source) {
        return source.permissions().hasPermission(Permissions.COMMANDS_OWNER);
    }
}
