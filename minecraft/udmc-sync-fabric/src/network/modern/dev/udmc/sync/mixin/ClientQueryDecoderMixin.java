package dev.udmc.sync.mixin;

import dev.udmc.sync.network.UdmcQueryPayload;

import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.login.ClientboundCustomQueryPacket;
import net.minecraft.network.protocol.login.custom.CustomQueryPayload;
import net.minecraft.resources.Identifier;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(ClientboundCustomQueryPacket.class)
public abstract class ClientQueryDecoderMixin {
    @Inject(method = "readPayload", at = @At("HEAD"), cancellable = true)
    private static void udmc$read(Identifier id, FriendlyByteBuf input, CallbackInfoReturnable<CustomQueryPayload> callback) {
        if (id.equals(UdmcQueryPayload.ID)) callback.setReturnValue(new UdmcQueryPayload(input));
    }
}
