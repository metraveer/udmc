package dev.udmc.sync.mixin;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.UdmcSync;
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
    private void udmc$warn(Connection connection, ServerPlayer player, CommonListenerCookie cookie, CallbackInfo callback) {
        var warning = AgentLoginProtocol.takeWarning(connection);
        if (warning != null) { player.sendSystemMessage(AgentLoginNotice.component(warning)); return; }
        // Every verdict is reached here, and only here. Refusing while the player was still in
        // the configuration phase cost them the explanation: that disconnect is sent into the
        // middle of the registry burst and a real client never processes it, leaving a bare
        // "Disconnected". From the play phase the same refusal arrives whole, translated, with
        // the installation buttons on it. Measured on the stand both ways.
        if (!AgentLoginProtocol.enabled() || !AgentLoginProtocol.pending(connection)) return;
        var decision = AgentLoginProtocol.announce(player.getName().getString(),
            AgentLoginProtocol.validate(AgentLoginProtocol.takeAnswer(connection)));
        if (decision.valid()) return;
        if (decision.reject()) player.connection.disconnect(AgentLoginNotice.component(decision));
        else player.sendSystemMessage(AgentLoginNotice.component(decision));
    }
}
