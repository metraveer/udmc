package dev.udmc.sync;

import com.mojang.brigadier.CommandDispatcher;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;

import java.nio.file.Path;

/**
 * The console side of pairing. Whoever runs a server can reach a console one way or another - the
 * hosting panel's own terminal, RCON, or the game as an operator - and this is the same code that
 * sits in {@code config/udmc-pairing.txt}, reached from wherever the owner happens to be.
 *
 * <p>Registration is ours rather than Fabric API's: the mod does not depend on it, and adding a
 * command to the dispatcher takes nothing away from anyone, so there is no shared claim to lose.
 */
public final class UdmcCommand {
    private static volatile Path gameDir;
    private static volatile UdmcConfig config;

    private UdmcCommand() {
    }

    /** Called by the server entrypoint once it knows which project this process is running. */
    public static void bind(Path directory, UdmcConfig settings) {
        gameDir = directory;
        config = settings;
    }

    public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(Commands.literal("udmc")
            // Full operator only: the pairing code is the keys to the project, not a curiosity.
            .requires(CommandPermissions::fullOperator)
            .then(Commands.literal("pair").executes(context -> {
                context.getSource().sendSuccess(() -> Component.literal(pairing()), false);
                return 1;
            })));
    }

    /**
     * One line, readable by a person and parseable by the panel: Control reads the code and the
     * API port straight out of an RCON reply, so the owner types a password and nothing else.
     */
    static String pairing() {
        UdmcConfig settings = config;
        if (settings == null) return "UDMC is still starting. Try again in a moment.";
        if (!ServerIdentity.unpaired(settings)) {
            return "UDMC is already paired. To pair again, set resetPairing to true in config/udmc-sync.json and restart.";
        }
        return "UDMC pairing code: " + settings.pairingCode + " (API port " + settings.apiPort + ")";
    }

    /** Exposed for the fixtures: the directory the bound project lives in. */
    static Path directory() {
        return gameDir;
    }
}
