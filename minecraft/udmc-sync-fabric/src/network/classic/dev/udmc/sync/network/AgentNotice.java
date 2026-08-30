package dev.udmc.sync.network;

import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;

public final class AgentNotice {
    private AgentNotice() {}
    public static Component link(String url) {
        return Component.literal(url).withStyle(style -> style.withColor(ChatFormatting.AQUA).withUnderlined(true)
            .withClickEvent(new ClickEvent(ClickEvent.Action.OPEN_URL, url)));
    }
}
