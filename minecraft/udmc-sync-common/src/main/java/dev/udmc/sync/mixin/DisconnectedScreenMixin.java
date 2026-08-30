package dev.udmc.sync.mixin;

import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.layouts.LinearLayout;
import net.minecraft.client.gui.screens.ConfirmLinkScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * The vanilla disconnect screen draws the reason through a text widget that ignores click
 * events, so the install link a rejected player is given cannot be clicked and has to be
 * retyped by hand. This adds the two buttons that screen is missing - open the page, copy
 * the address - but only when the rejection is ours and carries an address.
 */
@Mixin(DisconnectedScreen.class)
public abstract class DisconnectedScreenMixin extends Screen {
    // The address is read back out of the message: no state to keep in sync, and the buttons
    // can never appear on an unrelated disconnect that happens to follow a UDMC session.
    @Unique private static final Pattern UDMC$ADDRESS = Pattern.compile("https?://[^\\s\"'<>]+");

    @Shadow @Final private LinearLayout layout;

    private DisconnectedScreenMixin(Component title) { super(title); }

    @Inject(method = "init", at = @At("RETURN"))
    private void udmc$offerInstallLink(CallbackInfo callback) {
        String notice = getNarrationMessage().getString();
        if (!notice.contains("UDMC")) return;
        Matcher address = UDMC$ADDRESS.matcher(notice);
        if (!address.find()) return;
        String url = address.group();

        Button open = Button.builder(Component.translatable("udmc_sync.button.install_page"),
            button -> ConfirmLinkScreen.confirmLinkNow(this, url, true)).width(210).build();
        Button copy = Button.builder(Component.translatable("udmc_sync.button.copy_link"), button -> {
            Minecraft.getInstance().keyboardHandler.setClipboard(url);
            button.setMessage(Component.translatable("udmc_sync.button.copied"));
            button.active = false;
        }).width(210).build();

        // The layout owns placement, so the buttons land under the message wherever the
        // screen puts it; only our own widgets are registered, the vanilla ones already are.
        layout.addChild(open);
        layout.addChild(copy);
        layout.arrangeElements();
        addRenderableWidget(open);
        addRenderableWidget(copy);
        repositionElements();
    }
}
