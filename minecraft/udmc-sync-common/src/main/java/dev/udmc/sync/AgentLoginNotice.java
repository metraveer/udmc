package dev.udmc.sync;

import dev.udmc.sync.network.AgentNotice;
import net.minecraft.network.chat.Component;

/** A translated notice for modded clients with a bilingual fallback for clean clients. */
public final class AgentLoginNotice {
    // A player without the mod has no translations for our keys, so this string carries the
    // whole instruction in both languages. It is what most rejected players will ever read
    // about UDMC, and on the vanilla disconnect screen the link cannot be clicked - hence
    // the address on a line of its own, short enough to retype.
    private static final String CLEAN_CLIENT_FALLBACK =
        "UDMC: %1$s / Клиентскому UDMC нужна установка или обновление.\n\n"
        + "1. Open in a browser / Откройте в браузере:\n"
        + "%2$s\n"
        + "2. Download the file into your mods folder / Скачайте файл в папку mods\n"
        + "3. Start the game and join again / Запустите игру и зайдите снова";

    private AgentLoginNotice() {}

    public static Component component(AgentLoginProtocol.Decision decision) {
        var reason = Component.translatableWithFallback(decision.messageKey(), decision.messageFallback());
        return Component.translatableWithFallback("udmc_sync.login.notice", CLEAN_CLIENT_FALLBACK,
            reason, AgentNotice.link(decision.downloadUrl()));
    }
}
