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

/**
 * Delivers what was decided before the player got here.
 *
 * <p>Deciding happens in the configuration phase, where a refusal costs the player nothing and
 * arrives before the game has had a chance to throw them out for its own reasons. What cannot
 * happen there is being told something and staying: a chat line needs somebody in the world to
 * read it. So a player who was let in with a complaint is told once they are standing in it.
 */
@Mixin(PlayerList.class)
public abstract class PlayerListMixin {
    @Inject(method = "placeNewPlayer", at = @At("TAIL"))
    private void udmc$warn(Connection connection, ServerPlayer player, CommonListenerCookie cookie, CallbackInfo callback) {
        var warning = AgentLoginProtocol.takeWarning(connection);
        if (warning != null) player.sendSystemMessage(AgentLoginNotice.component(warning));
    }
}
