package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.AgentLoginNotice;
import net.minecraft.network.Connection;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.server.players.PlayerList;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(PlayerList.class)
public abstract class PlayerListMixin {
    @Inject(method = "placeNewPlayer", at = @At("TAIL"))
    private void udmc$check(Connection connection, ServerPlayer player, CommonListenerCookie cookie, CallbackInfo callback) {
        if (!AgentLoginProtocol.enabled()) return;
        var decision = AgentLoginProtocol.validate(AgentLoginProtocol.takeAnswer(connection));
        if (decision.valid()) return;
        // Turning the player away here instead of during login keeps UDMC out of the login
        // state machine that every networking mod also touches. They see the same screen.
        if (decision.reject()) player.connection.disconnect(AgentLoginNotice.component(decision));
        else player.sendSystemMessage(AgentLoginNotice.component(decision));
    }
}
