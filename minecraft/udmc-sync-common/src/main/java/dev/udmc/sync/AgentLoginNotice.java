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
    private static final String CLIENT_FALLBACK = "Your client / Ваш клиент: UDMC %1$s, project \"%2$s\"";

    private AgentLoginNotice() {}

    // Only one reason ever reaches a player without the mod - the other three need an answer,
    // and answering means the mod is there with its translations. So that one carries both
    // languages; the rest keep the plain English fallback shared with the HTTP diagnostics.
    private static final String MISSING_FALLBACK =
        "The UDMC client did not answer the server: it is most likely not installed."
        + " / Клиент UDMC не ответил серверу: скорее всего, мод не установлен.";

    private static final String RESTART_FALLBACK =
        "UDMC: %1$s\n\n"
        + "Close the game and start it again: the client updates itself.\n"
        + "Закройте игру и запустите снова: клиент обновится сам.";

    /**
     * A client that already belongs to this project repairs itself: it compares its own file
     * with the published one at every launch and replaces it. Telling such a player to
     * download anything is wrong - the only thing they have to do is restart. The download
     * steps are for the cases where no working channel exists yet: no mod at all, or a mod
     * that belongs to another project and cannot verify this server's signature.
     */
    private static boolean selfHealing(String messageKey) {
        return "udmc_sync.login.outdated".equals(messageKey) || "udmc_sync.login.rebuilt".equals(messageKey);
    }

    public static Component component(AgentLoginProtocol.Decision decision) {
        String reasonFallback = "udmc_sync.login.missing".equals(decision.messageKey())
            ? MISSING_FALLBACK : decision.messageFallback();
        var reason = Component.translatableWithFallback(decision.messageKey(), reasonFallback, decision.args().toArray());
        MutableComponent notice = selfHealing(decision.messageKey())
            ? Component.translatableWithFallback("udmc_sync.login.restart", RESTART_FALLBACK, reason)
            : Component.translatableWithFallback("udmc_sync.login.notice", CLEAN_CLIENT_FALLBACK,
                reason, AgentNotice.link(decision.downloadUrl()));
        // The numbers an administrator asks for first: without them the only way to tell a
        // stale client from a foreign one is to open files on someone else's computer.
        notice.append("\n\n").append(Component.translatableWithFallback("udmc_sync.login.server", SERVER_FALLBACK,
            version(decision.serverAgent()), version(decision.offeredClient()), decision.packId()));
        if (!decision.reportedClient().isBlank()) {
            notice.append("\n").append(Component.translatableWithFallback("udmc_sync.login.client", CLIENT_FALLBACK,
                decision.reportedClient(), decision.reportedProject()));
        }
        return notice;
    }

    private static String version(String value) { return value == null || value.isBlank() ? "-" : value; }
}
