package dev.udmc.sync;

import dev.udmc.sync.network.AgentNotice;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;

/** A translated notice for modded clients with a bilingual fallback for clean clients. */
public final class AgentLoginNotice {
    // A player without the mod has no translations for our keys, so this string carries the
    // whole instruction in both languages. It is what most rejected players will ever read
    // about UDMC, and on the vanilla disconnect screen the link cannot be clicked - hence
    // the address on a line of its own, short enough to retype.
    private static final String CLEAN_CLIENT_FALLBACK =
        "UDMC: %1$s\n\n"
        + "1. Open in a browser / Откройте в браузере:\n"
        + "%2$s\n"
        + "2. Download the file into your mods folder / Скачайте файл в папку mods\n"
        + "3. Start the game and join again / Запустите игру и зайдите снова";
    private static final String SERVER_FALLBACK = "Server / Сервер: UDMC %1$s, client %2$s, project \"%3$s\"";

    private AgentLoginNotice() {}

    public static Component component(AgentLoginProtocol.Decision decision) {
        var reason = Component.translatableWithFallback(decision.messageKey(), decision.messageFallback(), decision.args().toArray());
        MutableComponent notice = Component.translatableWithFallback("udmc_sync.login.notice", CLEAN_CLIENT_FALLBACK,
            reason, AgentNotice.link(decision.downloadUrl()));
        // The numbers an administrator asks for first: without them the only way to tell a
        // stale client from a foreign one is to open files on someone else's computer.
        notice.append("\n\n").append(Component.translatableWithFallback("udmc_sync.login.server", SERVER_FALLBACK,
            version(decision.serverAgent()), version(decision.offeredClient()), decision.packId()));
        // What the player's own client is runs on the player's own screen: the client adds
        // that line itself, so its project never has to be sent to a server it does not know.
        return notice;
    }

    private static String version(String value) { return value == null || value.isBlank() ? "-" : value; }
}
