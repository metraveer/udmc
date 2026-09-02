package dev.udmc.sync.network;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

/**
 * The game's own channel registration - "these are the channels I can receive" - as the
 * networking libraries write it: channel names, one after another, separated by a zero byte.
 *
 * <p>A client with a networking library of its own never sees this payload here: the library
 * reads the channel before the game's fallback, where this codec is hooked in, is ever asked.
 * It exists for the client that has nobody to answer for it - a fresh one, carrying nothing but
 * this mod - so that it can answer a server's registration itself. See AgentLoginProtocol.
 */
public record UdmcRegisterPayload(List<String> channels) implements CustomPacketPayload {
    public static final ResourceLocation ID = ResourceLocation.fromNamespaceAndPath("minecraft", "register");
    public static final CustomPacketPayload.Type<UdmcRegisterPayload> TYPE = new CustomPacketPayload.Type<>(ID);
    public static final StreamCodec<FriendlyByteBuf, UdmcRegisterPayload> CODEC =
        CustomPacketPayload.codec(UdmcRegisterPayload::write, UdmcRegisterPayload::new);

    public UdmcRegisterPayload(FriendlyByteBuf input) {
        this(read(input));
    }

    private static List<String> read(FriendlyByteBuf input) {
        byte[] bytes = new byte[input.readableBytes()];
        input.readBytes(bytes);
        return Arrays.stream(new String(bytes, StandardCharsets.US_ASCII).split("\0")).filter(name -> !name.isEmpty()).toList();
    }

    public void write(FriendlyByteBuf output) {
        output.writeBytes(String.join("\0", channels).getBytes(StandardCharsets.US_ASCII));
    }

    @Override public CustomPacketPayload.Type<? extends CustomPacketPayload> type() { return TYPE; }
}
