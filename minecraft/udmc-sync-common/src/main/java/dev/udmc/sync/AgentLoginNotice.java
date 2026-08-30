package dev.udmc.sync;

import dev.udmc.sync.network.AgentNotice;
import net.minecraft.network.chat.Component;

/** A translated notice for modded clients with a bilingual fallback for clean clients. */
public final class AgentLoginNotice {
    private static final String CLEAN_CLIENT_FALLBACK = "UDMC Sync: the client synchronizer is missing, incompatible, or outdated. / Клиентский синхронизатор отсутствует, несовместим или устарел.\nDownload and installation instructions / Скачать и установить: %2$s";

    private AgentLoginNotice() {}

    public static Component component(AgentLoginProtocol.Decision decision) {
        var reason = Component.translatableWithFallback(decision.messageKey(), decision.messageFallback());
        return Component.translatableWithFallback("udmc_sync.login.notice", CLEAN_CLIENT_FALLBACK,
            reason, AgentNotice.link(decision.downloadUrl()));
    }
}
